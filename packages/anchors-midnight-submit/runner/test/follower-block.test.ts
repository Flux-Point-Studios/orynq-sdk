import { expect, it, vi } from "vitest";
import * as Midnight from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import fixture from "../../../anchors-midnight/src/__tests__/fixtures/rpc-mainnet-execution.json";
import { rpcOnlySource, type FinalityCheckpoint, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { followerPolicyDigest, verifyFollowerBlock } from "../follower-block.js";

const checkpoint: FinalityCheckpoint = { ...fixture.checkpoint, setId: BigInt(fixture.checkpoint.setId), authorities: fixture.checkpoint.authorities.map(author => ({ ...author, weight: BigInt(author.weight) })) };
const block = { height: fixture.hints[0]!.blockHeight, hash: fixture.hints[0]!.blockHash };
function options(edit: (method: string, params: unknown[], answer: any) => unknown = (_, __, answer) => answer) {
  const calls: string[] = [];
  const node: MidnightSource["node"] = {
    async call<T>(method: string, params: unknown[] = []) {
      calls.push(method);
      const key = method + JSON.stringify(params);
      if (!(key in fixture.recording)) throw new Error(`Unrecorded RPC ${method}`);
      return edit(method, params, structuredClone(fixture.recording[key as keyof typeof fixture.recording])) as T;
    },
    async batch<T>(batch: [string, unknown[]][]) { return Promise.all(batch.map(([method, params]) => node.call<T>(method, params))); },
  };
  return { source: rpcOnlySource({ network: "mainnet", node, hints: fixture.hints }), checkpoints: [checkpoint], block, calls };
}

it("authenticates every bare Midnight send against a complete real mainnet block body", async () => {
  const opts = options(), result = await verifyFollowerBlock(opts);
  expect(result.block).toEqual(block);
  expect(result.parentHash).toMatch(/^[a-f0-9]{64}$/);
  expect(result.timestamp).toBeGreaterThan(0);
  const send = result.sends.find(send => send.txHash === fixture.hints[0]!.txHash)!;
  expect(send).toBeDefined();
  expect(send.status).toBe("SUCCESS");
  expect(send.extrinsicIndex).toBe(4);
  expect(send.bytes.length).toBeGreaterThan(0);
  expect(opts.calls).not.toContain("state_getRuntimeVersion");
});

it.each(["missing", "header", "body"])("refuses a substituted block: %s", async mode => {
  const opts = options((method, _, answer) => {
    if (method !== "chain_getBlock") return answer;
    if (mode === "missing") return null;
    if (mode === "header") answer.block.header.number = "0x1";
    if (mode === "body") answer.block.extrinsics.pop();
    return answer;
  });
  await expect(verifyFollowerBlock(opts)).rejects.toThrow();
});

it("never reads execution witnesses after finality failed", async () => {
  const opts = options((method, _, answer) => method === "grandpa_proveFinality" ? null : answer);
  await expect(verifyFollowerBlock(opts)).rejects.toThrow(/final/i);
  expect(opts.calls).not.toContain("state_getReadProof");
});

it("refuses an unavailable or unsupported execution witness", async () => {
  for (const code of [false, true]) {
    const opts = options((method, params, answer) => method === "state_getReadProof" && (params[0] as string[]).includes("0x3a636f646500") === code ? { ...answer, proof: [] } : answer);
    await expect(verifyFollowerBlock(opts)).rejects.toThrow();
  }
});

it("requires a bounded exact block reference and explicit finality trust", async () => {
  for (const wrong of [{ ...block, height: -1 }, { ...block, hash: "0x" + block.hash }, { ...block, height: NaN }]) await expect(verifyFollowerBlock({ ...options(), block: wrong })).rejects.toThrow();
  await expect(verifyFollowerBlock({ ...options(), checkpoints: [] })).rejects.toThrow(/final/i);
});


it("rejects unbounded finality budgets before reading the source", async () => {
  for (const maxSetChanges of [NaN, Infinity, -1, 1.5]) {
    const opts = options();
    await expect(verifyFollowerBlock({ ...opts, maxSetChanges })).rejects.toThrow(/budget/i);
    expect(opts.calls).toEqual([]);
  }
});

it("uses the same captured finality budget for its policy identity and verification", async () => {
  const opts = { ...options((method, _, answer) => { if (method === "chain_getBlock") opts.maxSetChanges = NaN; return answer; }), maxSetChanges: 0 };
  const observed = vi.spyOn(Midnight, "verifyFinality");
  try {
    const result = await verifyFollowerBlock(opts);
    expect(observed.mock.calls[0]![0].maxSetChanges).toBe(0);
    expect(result.policyDigest).toBe(followerPolicyDigest(opts.checkpoints, 0));
  } finally { observed.mockRestore(); }
});
