import {
  encodeMuxMessage,
  MUX_CLOSE,
  MUX_FRAME,
  MUX_OPEN,
  MUX_READY,
  MuxDecoder,
  type LinuxPeer,
  type MuxKind,
  type MuxMessage,
  type Peer,
} from "@fluxpointstudios/orynq-sdk-core/broker-wire";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { Broker } from "../src/broker.js";
import { serveMux } from "../src/host.js";

const OPERATOR = 1000;
const AGENT = 1500;
const SLICE = "/orynq.slice/orynq-agents.slice";
const C = "11".repeat(32);
const utf8 = (text: string) => new TextEncoder().encode(text);
const linux = (uid: number, cgroup = "/user.slice"): LinuxPeer => ({ os: "linux", uid, gid: uid, pidHint: 1, cgroup });

function broker(): Broker {
  return new Broker({
    principals: { operatorUid: OPERATOR, agent: { uid: AGENT, slice: SLICE } },
    receiptKey: Uint8Array.of(1, 2, 3),
    policy: Uint8Array.of(0xa0),
    registeredMandates: new Set([C]),
  });
}

// Plays the frontend: writes what it would write and collects what the host answers.
function frontend(b = broker()) {
  const input = new PassThrough();
  const output = new PassThrough();
  const decoder = new MuxDecoder();
  const sent: MuxMessage[] = [];
  output.on("data", (chunk: Buffer) => sent.push(...decoder.push(chunk)));
  const reports: unknown[] = [];
  const host = serveMux(input, output, b, error => reports.push(error));
  const settled = host.done.then(() => "ended", (error: Error) => `rejected: ${error.message}`);
  const write = (kind: MuxKind, conn: bigint, payload: Uint8Array = new Uint8Array()) =>
    input.write(encodeMuxMessage({ kind, conn, payload }));
  const open = (conn: bigint, peer: Peer | null) => write(MUX_OPEN, conn, utf8(JSON.stringify(peer)));
  const call = (conn: bigint, method: string, id = Number(conn), params?: unknown) =>
    write(MUX_FRAME, conn, utf8(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })));
  const replies = (conn: bigint) =>
    sent.filter(m => m.conn === conn && m.kind === MUX_FRAME).map(m => JSON.parse(new TextDecoder().decode(m.payload)) as Record<string, unknown>);
  const closes = () => sent.filter(m => m.kind === MUX_CLOSE).map(m => m.conn);
  return { b, host, input, settled, sent, reports, write, open, call, replies, closes };
}

const ready = async (f: ReturnType<typeof frontend>) => {
  f.write(MUX_READY, 0n);
  await f.host.ready;
};

describe("serveMux", () => {
  it("is ready once the frontend says READY, and ends when its output ends", async () => {
    const f = frontend();
    let isReady = false;
    void f.host.ready.then(() => { isReady = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(isReady).toBe(false);
    await ready(f);
    f.input.end();
    expect(await f.settled).toBe("ended");
  });

  it("answers each request as the principal the connection's peer maps to", async () => {
    const f = frontend();
    await ready(f);
    f.open(1n, linux(OPERATOR));
    f.call(1n, "broker.hello");
    await vi.waitFor(() => expect(f.replies(1n)).toHaveLength(1));
    expect(f.replies(1n)[0]).toMatchObject({ jsonrpc: "2.0", id: 1, result: { principal: "operator", protocol: 2 } });
    f.call(1n, "session.open", 7, { mandates: [C] });
    await vi.waitFor(() => expect(f.replies(1n)).toHaveLength(2));
    expect(f.replies(1n)[1]).toMatchObject({ id: 7, result: { unit: expect.stringMatching(/^orynq-agent-[0-9a-f]{32}\.service$/) } });
  });

  it("answers PEER_UNKNOWN to an anonymous client, an unconfigured peer and a peer outside the contract", async () => {
    const f = frontend();
    await ready(f);
    f.open(1n, null);
    f.open(2n, linux(4242));
    f.write(MUX_OPEN, 3n, utf8(JSON.stringify({ ...linux(OPERATOR), extra: 1 })));
    for (const conn of [1n, 2n, 3n]) f.call(conn, "broker.hello");
    await vi.waitFor(() => expect([1n, 2n, 3n].map(conn => f.replies(conn).length)).toEqual([1, 1, 1]));
    for (const conn of [1n, 2n, 3n]) {
      expect(f.replies(conn)[0]).toEqual({ jsonrpc: "2.0", id: Number(conn), error: { code: -32001, message: "Peer unknown" } });
    }
    expect(f.reports).toHaveLength(1);
    expect(f.reports[0]).toMatchObject({ name: "BrokerWireError", code: "PEER_INVALID" });
  });

  it("answers a request it cannot decode from the error table with id null", async () => {
    const f = frontend();
    await ready(f);
    f.open(1n, linux(OPERATOR));
    f.write(MUX_FRAME, 1n, utf8('{"jsonrpc":"2.0","id":1,"id":2,"method":"broker.hello"}'));
    await vi.waitFor(() => expect(f.replies(1n)).toHaveLength(1));
    expect(f.replies(1n)[0]).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  });

  it("refuses the 33rd connection of a principal and admits one again when another closes", async () => {
    const f = frontend();
    await ready(f);
    for (let conn = 1n; conn <= 33n; conn++) f.open(conn, linux(OPERATOR, `/cg/${conn}`));
    await vi.waitFor(() => expect(f.closes()).toEqual([33n]));
    f.call(33n, "broker.hello");
    f.call(32n, "broker.hello");
    await vi.waitFor(() => expect(f.replies(32n)).toHaveLength(1));
    expect(f.replies(33n)).toEqual([]);
    f.write(MUX_CLOSE, 33n);
    f.write(MUX_CLOSE, 1n);
    f.open(34n, linux(OPERATOR));
    f.open(35n, linux(OPERATOR));
    await vi.waitFor(() => expect(f.closes()).toEqual([33n, 35n]));
    f.call(34n, "broker.hello");
    await vi.waitFor(() => expect(f.replies(34n)).toHaveLength(1));
  });

  it("refuses the 9th connection of an agent session, each session counted on its own", async () => {
    const f = frontend();
    await ready(f);
    const sessions: string[] = [];
    for (const id of [1, 2]) {
      const reply = await f.b.handle({ id, method: "session.open", params: { mandates: [C] } }, "operator");
      sessions.push((JSON.parse(new TextDecoder().decode(reply)) as { result: { sessionId: string } }).result.sessionId);
    }
    const agent = (sessionId: string) => linux(AGENT, `${SLICE}/orynq-agent-${sessionId}.service`);
    for (let conn = 1n; conn <= 9n; conn++) f.open(conn, agent(sessions[0]!));
    for (let conn = 11n; conn <= 18n; conn++) f.open(conn, agent(sessions[1]!));
    await vi.waitFor(() => expect(f.closes()).toEqual([9n]));
    f.call(18n, "broker.hello");
    await vi.waitFor(() => expect(f.replies(18n)).toHaveLength(1));
    expect(f.replies(18n)[0]).toMatchObject({ result: { principal: `agent:${sessions[1]}`, sessionId: sessions[1] } });
  });

  it("answers PEER_UNKNOWN on an agent's connection once its session has closed", async () => {
    const f = frontend();
    await ready(f);
    const opened = JSON.parse(new TextDecoder().decode(await f.b.handle({ id: 1, method: "session.open", params: { mandates: [C] } }, "operator"))) as {
      result: { sessionId: string; unit: string };
    };
    f.open(1n, linux(AGENT, `${SLICE}/${opened.result.unit}`));
    f.call(1n, "broker.hello");
    await vi.waitFor(() => expect(f.replies(1n)).toHaveLength(1));
    await f.b.handle({ id: 2, method: "session.close", params: { sessionId: opened.result.sessionId } }, "operator");
    f.call(1n, "broker.hello", 2);
    await vi.waitFor(() => expect(f.replies(1n)).toHaveLength(2));
    expect(f.replies(1n)[1]).toMatchObject({ id: 2, error: { code: -32001 } });
  });

  it("closes a connection whose handler fails with anything but an RpcError, and reports it", async () => {
    const f = frontend();
    await ready(f);
    const failure = new Error("vault unreachable");
    vi.spyOn(f.b, "handle").mockRejectedValueOnce(failure);
    f.open(1n, linux(OPERATOR));
    f.call(1n, "broker.hello");
    await vi.waitFor(() => expect(f.closes()).toEqual([1n]));
    expect(f.reports).toEqual([failure]);
    expect(f.replies(1n)).toEqual([]);
    f.write(MUX_CLOSE, 1n);
    f.open(2n, linux(OPERATOR));
    f.call(2n, "broker.hello");
    await vi.waitFor(() => expect(f.replies(2n)).toHaveLength(1));
  });

  it("sends no reply for a connection the frontend closed while its request ran", async () => {
    const f = frontend();
    await ready(f);
    let release!: (reply: Uint8Array) => void;
    vi.spyOn(f.b, "handle").mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    f.open(1n, linux(OPERATOR));
    f.call(1n, "broker.hello");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.write(MUX_CLOSE, 1n);
    await new Promise(resolve => setImmediate(resolve));
    release(utf8('{"jsonrpc":"2.0","id":1,"result":{}}'));
    f.open(2n, linux(OPERATOR));
    f.call(2n, "broker.hello");
    await vi.waitFor(() => expect(f.replies(2n)).toHaveLength(1));
    expect(f.sent.filter(m => m.conn === 1n)).toEqual([]);
  });

  it.each([
    ["anything before READY", (f: ReturnType<typeof frontend>) => f.open(1n, null), false, "the frontend spoke before READY"],
    ["a second READY", (f: ReturnType<typeof frontend>) => f.write(MUX_READY, 0n), true, "the frontend sent READY twice"],
    ["an OPEN for an open connection", (f: ReturnType<typeof frontend>) => { f.open(1n, null); f.open(1n, null); }, true, "the frontend opened connection 1 twice"],
    ["a FRAME for a connection never opened", (f: ReturnType<typeof frontend>) => f.call(5n, "broker.hello"), true, "the frontend sent a FRAME for connection 5, which is not open"],
    ["a CLOSE for a connection never opened", (f: ReturnType<typeof frontend>) => f.write(MUX_CLOSE, 5n), true, "the frontend sent a CLOSE for connection 5, which is not open"],
    ["a malformed message", (f: ReturnType<typeof frontend>) => f.input.write(Uint8Array.of(0, 0, 0, 9, 7)), true, "mux message kind is unknown"],
  ])("rejects on %s, since the frontend is broken", async (_, act, afterReady, message) => {
    const f = frontend();
    if (afterReady) await ready(f);
    act(f);
    expect(await f.settled).toBe(`rejected: ${message}`);
  });

  it("rejects on a second request in flight on one connection", async () => {
    const f = frontend();
    await ready(f);
    vi.spyOn(f.b, "handle").mockReturnValueOnce(new Promise(() => {}));
    f.open(1n, linux(OPERATOR));
    f.call(1n, "broker.hello");
    f.call(1n, "broker.hello");
    expect(await f.settled).toBe("rejected: the frontend sent a second request on connection 1 before its reply");
  });
});
