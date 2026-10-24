import { expect, it, vi } from "vitest";
import * as Midnight from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { fixture } from "../../../anchors-midnight/src/__tests__/anchor-chain.js";
import { followerChain as setup } from "../../../anchors-midnight/src/__tests__/follower-chain.js";
import { openFollowerReader, followerPolicyDigest, verifyFollowerBlock, type FollowerBlock } from "../follower-block.js";

async function collect(values: AsyncIterable<FollowerBlock>) { const result: FollowerBlock[] = []; for await (const value of values) result.push(value); return result; }

it("uses real body, runtime, storage and GRANDPA verification in the range fixture", async () => {
  const f = setup(), block = await verifyFollowerBlock({ source: f.source, block: f.ref(1601), checkpoints: [f.checkpoint] });
  expect(block.sends).toHaveLength(1); expect(block.sends[0]).toMatchObject({ status: "SUCCESS", txHash: fixture.anchor.txHash });
});

it("verifies one finalized range across a handoff and yields complete blocks in order", async () => {
  const f = setup(), reader = openFollowerReader({ source: f.source, checkpoints: [f.checkpoint] }), spy = vi.spyOn(Midnight, "verifyFinality");
  try {
    const blocks = await collect(reader.range({ after: f.ref(1599), end: f.ref(1602) }));
    expect(blocks.map(block => block.block.height)).toEqual([1600, 1601, 1602]);
    expect(blocks.map(block => block.sends.length)).toEqual([0, 1, 0]);
    expect(blocks.every(block => block.policyDigest === followerPolicyDigest([f.checkpoint]))).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  } finally { spy.mockRestore(); }
});

it("never reads effects or promotes a cache for a range outside its exact durable parent", async () => {
  const f = setup(), reader = openFollowerReader({ source: f.source, checkpoints: [f.checkpoint], maxSetChanges: 3 }), spy = vi.spyOn(Midnight, "verifyFinality");
  try {
    await expect(collect(reader.range({ after: { height: 1599, hash: "00".repeat(32) }, end: f.ref(1602) }))).rejects.toThrow(/parent|ancestry|link/i);
    expect(f.calls).not.toContain("state_getReadProof");
    await collect(reader.range({ after: f.ref(1599), end: f.ref(1602) }));
    expect(spy.mock.calls[1]![0].checkpoints).toEqual([f.checkpoint]);
    expect(spy.mock.calls[1]![0].maxSetChanges).toBe(3);
  } finally { spy.mockRestore(); }
});

it("binds every body to its header before yielding execution facts", async () => {
  const f = setup((method, params, value) => { if (method === "chain_getBlock" && params[0] === `0x${f.ref(1601).hash}`) value.block.extrinsics.pop(); return value; });
  const reader = openFollowerReader({ source: f.source, checkpoints: [f.checkpoint] });
  await expect(collect(reader.range({ after: f.ref(1599), end: f.ref(1602) }))).rejects.toThrow(/body|root/i);
  expect(f.calls).not.toContain("state_getReadProof");
});

it("retains only previously yielded complete blocks when later effects fail", async () => {
  const f = setup((method, params, value) => method === "state_getReadProof" && params[1] === `0x${f.ref(1601).hash}` ? { ...value, proof: [] } : value);
  const reader = openFollowerReader({ source: f.source, checkpoints: [f.checkpoint] }), seen: number[] = [];
  await expect((async () => { for await (const block of reader.range({ after: f.ref(1599), end: f.ref(1602) })) seen.push(block.block.height); })()).rejects.toThrow();
  expect(seen).toEqual([1600]);
});

it("reuses verified checkpoints with the remaining original transition allowance", async () => {
  const f = setup(), reader = openFollowerReader({ source: f.source, checkpoints: [f.checkpoint], maxSetChanges: 3 }), spy = vi.spyOn(Midnight, "verifyFinality");
  try {
    await collect(reader.range({ after: f.ref(1599), end: f.ref(1602) }));
    const first = await spy.mock.results[0]!.value; expect(first.finalized).toBe(true);
    await collect(reader.range({ after: f.ref(1602), end: f.ref(1605) }));
    expect(spy.mock.calls[1]![0].checkpoints).toEqual([first.checkpoint]);
    expect(spy.mock.calls[1]![0].maxSetChanges).toBe(3 - first.setChanges);
    await collect(reader.range({ after: f.ref(1900), end: f.ref(1901) }));
    await expect(collect(reader.range({ after: f.ref(2200), end: f.ref(2201) }))).rejects.toThrow(/final|budget|change/i);
  } finally { spy.mockRestore(); }
});

it("recounts a historical fallback from its actual original root without a global spent counter", async () => {
  const f = setup(), reader = openFollowerReader({ source: f.source, checkpoints: [f.checkpoint], maxSetChanges: 3 }), spy = vi.spyOn(Midnight, "verifyFinality");
  try {
    await collect(reader.range({ after: f.ref(1900), end: f.ref(1901) }));
    await collect(reader.range({ after: f.ref(1599), end: f.ref(1602) }));
    expect(spy.mock.calls[1]![0].checkpoints).toEqual([f.checkpoint]); expect(spy.mock.calls[1]![0].maxSetChanges).toBe(3);
  } finally { spy.mockRestore(); }
});

it("rejects malformed or oversized windows before source reads", async () => {
  const f = setup(), reader = openFollowerReader({ source: f.source, checkpoints: [f.checkpoint] });
  for (const request of [{ after: f.ref(1599), end: f.ref(1632) }, { after: f.ref(1602), end: f.ref(1602) }, { after: { height: -1, hash: "00".repeat(32) }, end: f.ref(1602) }]) {
    await expect(collect(reader.range(request))).rejects.toThrow();
  }
  expect(f.calls).toEqual([]);
});

it("captures original policy and range references before asynchronous reads", async () => {
  const f = setup((method, _, value) => {
    if (method === "chain_getBlock") { policy.checkpoints[0]!.setId = 999n; policy.maxSetChanges = NaN; request.after.hash = "00".repeat(32); request.end.hash = "00".repeat(32); }
    return value;
  });
  const policy = { source: f.source, checkpoints: [structuredClone(f.checkpoint)], maxSetChanges: 3 }, digest = followerPolicyDigest(policy.checkpoints, 3);
  const reader = openFollowerReader(policy), request = { after: f.ref(1599), end: f.ref(1602) };
  const blocks = await collect(reader.range(request));
  expect(blocks).toHaveLength(3); expect(blocks.every(block => block.policyDigest === digest)).toBe(true);
});

it("keeps cached authority paths separate from the nearest original root", async () => {
  const f = setup(), supplied = f.chain.chain.checkpoint(2);
  const reader = openFollowerReader({ source: f.source, checkpoints: [f.checkpoint, supplied], maxSetChanges: 3 }), spy = vi.spyOn(Midnight, "verifyFinality");
  try {
    await collect(reader.range({ after: f.ref(1496), end: f.ref(1499) }));
    const result = await spy.mock.results[0]!.value; expect(result.checkpoint.startsAfter.height).toBe(1300);
    await collect(reader.range({ after: f.ref(1601), end: f.ref(1602) }));
    expect(spy.mock.calls[1]![0].checkpoints).toEqual([supplied]); expect(spy.mock.calls[1]![0].maxSetChanges).toBe(3);
  } finally { spy.mockRestore(); }
});
