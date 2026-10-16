import { describe, expect, it } from "vitest";
import { midnightExtrinsic, midnightTransactionIn, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { broadcast, nodeRefusal } from "../src/broadcast.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// A node that records each call and answers from `answer`.
function node(answer: (method: string, params: unknown[]) => unknown) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const source = {
    operator: "test",
    node: {
      async call(method: string, params: unknown[] = []) {
        calls.push({ method, params });
        return answer(method, params);
      },
      async batch() {
        throw new Error("unused");
      },
    },
  } as unknown as MidnightSource;
  return { source, calls };
}

const tx = new Uint8Array([0x6d, 0x69, 0x64, 0x6e, 0x69, 0x67, 0x68, 0x74, 1, 2, 3]);

describe("broadcast", () => {
  it("submits exactly the bare Midnight.send_mn_transaction of the bytes, once", async () => {
    const { source, calls } = node(() => "0xextrinsichash");
    await broadcast(source, tx);
    expect(calls).toEqual([{ method: "author_submitExtrinsic", params: [`0x${hex(midnightExtrinsic(tx))}`] }]);
    expect(hex(midnightTransactionIn(Buffer.from((calls[0]!.params[0] as string).slice(2), "hex"))!)).toBe(hex(tx));
  });

  it("treats a node that already holds the transaction as delivered", async () => {
    const { source } = node(() => {
      throw new Error('test node: author_submitExtrinsic failed: {"code":1013,"message":"Transaction Already Imported"}');
    });
    await expect(broadcast(source, tx)).resolves.toBeUndefined();
  });

  it("takes only the node's own JSON-RPC answer as already imported, never a gateway body that mentions 1013", async () => {
    const { source } = node(() => {
      throw new Error('test node: HTTP 502: {"code":1013,"message":"upstream"}');
    });
    await expect(broadcast(source, tx)).rejects.toThrow(/HTTP 502/);
  });

  it("surfaces every other refusal", async () => {
    const { source } = node(() => {
      throw new Error('test node: author_submitExtrinsic failed: {"code":1010,"message":"Invalid Transaction","data":"Custom error: 110"}');
    });
    await expect(broadcast(source, tx)).rejects.toThrow(/1010.*Invalid Transaction/);
  });
});

describe("nodeRefusal", () => {
  it("reads the JSON-RPC code, message and data of the node's answer", () => {
    const error = new Error('midnight node: author_submitExtrinsic failed: {"code":1010,"message":"Invalid Transaction","data":"Custom error: 110"}');
    expect(nodeRefusal(error)).toEqual({ code: 1010, message: "Invalid Transaction", data: "Custom error: 110" });
  });

  it("is null for a failure that is not the node's answer, so it can never be counted as a refusal", () => {
    for (const message of [
      "midnight node: fetch failed",
      "midnight node: HTTP 502: Bad Gateway",
      'midnight node: HTTP 500: {"code":1010,"message":"Invalid Transaction"}',
      "midnight node: answered with something other than JSON: <html>",
      "midnight node: no answer to author_submitExtrinsic",
      'midnight node: chain_getBlock failed: {"code":1010,"message":"Invalid Transaction"}',
      "the operation was aborted due to timeout",
    ]) {
      expect(nodeRefusal(new Error(message)), message).toBeNull();
    }
    expect(nodeRefusal('midnight node: author_submitExtrinsic failed: {"code":1010,"message":"Invalid Transaction"}')).toBeNull();
  });
});
