import { describe, expect, it } from "vitest";
import { submitPublicPreprod } from "../public-preprod.js";

const genesis = "0xdf831b09a8baa92badf47762ce5ac439b7e47e3ed3d39600cfdd44fad552361b";
const txHash = `0x${"a3".repeat(32)}`;
const replies = ["Midnight Preprod", genesis, { specVersion: 1000300 }, txHash];

function peer(answer: (request: any, index: number) => unknown = (_request, index) => ({ result: replies[index] })) {
  const events = new EventTarget();
  const sent: any[] = [];
  let closed = false;
  const socket = {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    close: () => { closed = true; },
    send(text: string) {
      const request = JSON.parse(text);
      const reply = answer(request, sent.length);
      sent.push(request);
      if (reply !== undefined) queueMicrotask(() => events.dispatchEvent(new MessageEvent("message", { data: typeof reply === "string" ? reply : JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply as object }) })));
    },
  };
  const factory = (url: string) => {
    expect(url).toBe("wss://rpc.preprod.midnight.network");
    queueMicrotask(() => events.dispatchEvent(new Event("open")));
    return socket;
  };
  return { sent, factory, events, closed: () => closed };
}

describe("credential-free preprod submission", () => {
  it("pins chain, genesis and runtime on the same socket before sending the exact bytes", async () => {
    const p = peer();
    expect(await submitPublicPreprod("0x1234", p.factory)).toBe(txHash);
    expect(p.sent.map(request => request.method)).toEqual(["system_chain", "chain_getBlockHash", "state_getRuntimeVersion", "author_submitExtrinsic"]);
    expect(p.sent[1].params).toEqual([0]);
    expect(p.sent[3].params).toEqual(["0x1234"]);
    expect(p.closed()).toBe(true);
  });

  it.each([0, 1, 2])("never sends bytes when identity pin %i fails", async index => {
    const p = peer((_request, at) => ({ result: at === index ? "wrong chain" : replies[at] }));
    await expect(submitPublicPreprod("0x1234", p.factory)).rejects.toThrow("identity or response");
    expect(p.sent).toHaveLength(index + 1);
    expect(p.closed()).toBe(true);
  });

  it("keeps the node's precise allowlisted authority refusal for evidence", async () => {
    const p = peer((_request, at) => at === 3 ? { error: { code: 1010, message: "Invalid Transaction", data: "Custom error: 136" } } : { result: replies[at] });
    await expect(submitPublicPreprod("0x1234", p.factory)).rejects.toMatchObject({ method: "author_submitExtrinsic", code: 1010, message: expect.stringContaining('"data":"Custom error: 136"') });
    expect(p.closed()).toBe(true);
  });

  it.each([
    '{"jsonrpc":"2.0","id":99,"result":"Midnight Preprod"}',
    "not json",
    "x".repeat(4097),
  ])("refuses malformed or mismatched replies before sending bytes", async reply => {
    const p = peer(() => reply);
    await expect(submitPublicPreprod("0x1234", p.factory)).rejects.toThrow();
    expect(p.sent).toHaveLength(1);
    expect(p.closed()).toBe(true);
  });

  it("times out without a response and closes the socket", async () => {
    const p = peer(() => undefined);
    await expect(submitPublicPreprod("0x1234", p.factory, 5)).rejects.toThrow("timed out");
    expect(p.closed()).toBe(true);
  });

  it("rejects malformed bytes before opening a connection", async () => {
    let opened = false;
    await expect(submitPublicPreprod("1234", () => { opened = true; throw new Error(); })).rejects.toThrow("extrinsic");
    expect(opened).toBe(false);
  });
});
