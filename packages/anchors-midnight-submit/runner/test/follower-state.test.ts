import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openFollowerState } from "../follower-state.js";
import type { FollowerBlock } from "../follower-block.js";
import { followerPolicyDigest, verifyFollowerBlock } from "../follower-block.js";
import { authorKey, rpcOnlySource, registryInitialState, unprovenRegistryCall, type FinalityCheckpoint } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { finalTransaction } from "../../src/submission.js";
import { prover } from "../../test/prover.js";
import { deployed } from "../../test/fakes.js";
import recording from "../../../anchors-midnight/src/__tests__/fixtures/rpc-mainnet-execution.json";

const h = (n: number) => n.toString(16).padStart(64, "0");
const roots: string[] = [], handles: ReturnType<typeof openFollowerState>[] = [];
const secret = new Uint8Array(32).fill(19), author = Buffer.from(authorKey(secret)).toString("hex");
const scope = { network: "preprod" as const, genesis: h(1), registry: deployed.address, author, policyDigest: h(2), runtimeSpecVersion: 1000300 };
function setup(overrides: { network?: "mainnet" | "preprod"; policyDigest?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "follower-state-")); roots.push(root); chmodSync(root, 0o700);
  const path = join(root, "follower.sqlite"), state = openFollowerState(path, { ...scope, ...overrides }); handles.push(state); return { path, state };
}
const block = (height: number, timestamp = height * 6000): FollowerBlock => ({ network: scope.network, policyDigest: scope.policyDigest, block: { height, hash: h(height) }, parentHash: h(height - 1), timestamp, runtimeSpecVersion: 1000300, sends: [] });
async function bytes(ttl = 100_000, commitment = h(90)) {
  const built = unprovenRegistryCall({ networkId: scope.network, address: scope.registry, state: registryInitialState(), ttl: new Date(ttl), call: { circuit: "anchor", args: [Buffer.from(commitment, "hex"), 3n] }, witnesses: { authorSecret: secret } });
  return (await prover.prove(built.tx)).bind().serialize();
}
afterEach(() => { for (const handle of handles.splice(0)) handle.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("persists complete block observations with an exact contiguous cursor across restart", () => {
  const { state, path } = setup(); state.recordVerifiedBlock(block(10)); state.recordVerifiedBlock(block(11));
  expect(state.head()).toEqual(block(11).block); state.close(); handles.splice(handles.indexOf(state), 1);
  const resumed = openFollowerState(path, scope); handles.push(resumed); expect(resumed.head()).toEqual(block(11).block);
  resumed.recordVerifiedBlock(block(12)); expect(resumed.head()).toEqual(block(12).block);
});

it.each(["gap", "parent", "clock", "runtime"])("holds on a %s without advancing durable coverage", mode => {
  const { state } = setup(); state.recordVerifiedBlock(block(10)); const next = block(11);
  if (mode === "gap") next.block.height++;
  if (mode === "parent") next.parentHash = h(8);
  if (mode === "clock") next.timestamp = 1;
  if (mode === "runtime") next.runtimeSpecVersion++;
  expect(() => state.recordVerifiedBlock(next)).toThrow(); expect(state.head()).toEqual(block(10).block);
});

it("refuses a different trust scope without resetting history", () => {
  const { state, path } = setup(); state.recordVerifiedBlock(block(10));
  expect(() => openFollowerState(path, { ...scope, policyDigest: h(3) })).toThrow(/scope/i);
  expect(state.head()).toEqual(block(10).block);
});

it("refuses facts verified under a different finality input policy", () => {
  const { state } = setup(); expect(() => state.recordVerifiedBlock({ ...block(10), policyDigest: h(3) })).toThrow(/scope/i);
  expect(state.head()).toBeNull();
});

it("requires exact prebroadcast bytes and never invents provenance for legacy attempts", async () => {
  const { state } = setup(); state.recordVerifiedBlock(block(10)); const raw = await bytes(), hash = finalTransaction(raw).transactionHash();
  const view = state.chainView(); await expect(view.lookup(hash)).rejects.toThrow(/provenance/i);
  expect(() => state.assertRecorded(raw)).toThrow(/record/i);
  state.recordAttempt(raw); expect(() => state.assertRecorded(raw)).not.toThrow();
  await expect(state.chainView().lookup(hash)).resolves.toBeNull();
  expect(state.attempt(hash)?.boundary).toEqual(block(10).block);
});

it("keeps the first prebroadcast boundary across identical retries and restarts", async () => {
  const { state, path } = setup(); state.recordVerifiedBlock(block(10)); const raw = await bytes(); state.recordAttempt(raw); state.recordVerifiedBlock(block(11)); state.recordAttempt(raw);
  const hash = finalTransaction(raw).transactionHash(); expect(state.attempt(hash)?.boundary).toEqual(block(10).block);
  state.close(); handles.splice(handles.indexOf(state), 1); const resumed = openFollowerState(path, scope); handles.push(resumed);
  expect(resumed.attempt(hash)?.boundary).toEqual(block(10).block);
});

it("snapshots reconciliation heads and refuses deployment reconciliation", async () => {
  const { state } = setup(); state.recordVerifiedBlock(block(10)); const raw = await bytes(); state.recordAttempt(raw); const view = state.chainView(); state.recordVerifiedBlock(block(11));
  expect(await view.indexedThrough()).toEqual({ hash: h(10), time: new Date(60_000) });
  expect(await view.finalHash(11)).toBeNull(); await expect(view.holdsContract(scope.registry, h(10))).rejects.toThrow(/deploy/i);
});

it("holds partial execution permanently and retains failure until complete TTL margin", async () => {
  for (const status of ["PARTIAL_SUCCESS", "FAILURE"] as const) {
    const { state } = setup(); state.recordVerifiedBlock(block(10)); const raw = await bytes(), txHash = finalTransaction(raw).transactionHash(); state.recordAttempt(raw);
    const inclusion = block(11); inclusion.sends = [{ bytes: raw, txHash, status, extrinsicIndex: 1 }]; state.recordVerifiedBlock(inclusion);
    await expect(state.chainView().lookup(txHash)).rejects.toThrow(/hold/i);
    state.recordVerifiedBlock(block(12, 400_000));
    await expect(state.chainView().lookup(txHash)).rejects.toThrow(/hold/i);
    state.recordVerifiedBlock(block(13, 400_001));
    if (status === "PARTIAL_SUCCESS") await expect(state.chainView().lookup(txHash)).rejects.toThrow(/hold/i);
    else await expect(state.chainView().lookup(txHash)).resolves.toBeNull();
  }
});

it("retains repeated observations and recognizes later success after an earlier failure", async () => {
  const { state } = setup(); state.recordVerifiedBlock(block(10)); const raw = await bytes(), txHash = finalTransaction(raw).transactionHash(); state.recordAttempt(raw);
  const failed = block(11); failed.sends = [{ bytes: raw, txHash, status: "FAILURE", extrinsicIndex: 1 }]; state.recordVerifiedBlock(failed);
  const success = block(12); success.sends = [{ bytes: raw, txHash, status: "SUCCESS", extrinsicIndex: 1 }]; state.recordVerifiedBlock(success);
  expect(await state.chainView().lookup(txHash)).toEqual({ status: "SUCCESS", height: 12, blockHash: h(12) });
  expect(state.observations(txHash)).toHaveLength(2);
});

it("atomically rejects substituted send hashes and keeps the prior complete cursor", async () => {
  const { state } = setup(); state.recordVerifiedBlock(block(10)); const bad = block(11); bad.sends = [{ bytes: await bytes(), txHash: h(7), status: "SUCCESS", extrinsicIndex: 1 }];
  expect(() => state.recordVerifiedBlock(bad)).toThrow(/hash/i); expect(state.head()).toEqual(block(10).block);
});

it("detects missing interval rows even when a stored cursor and attempt remain", async () => {
  const { state, path } = setup(); state.recordVerifiedBlock(block(10)); const raw = await bytes(), txHash = finalTransaction(raw).transactionHash(); state.recordAttempt(raw);
  state.recordVerifiedBlock(block(11)); state.recordVerifiedBlock(block(12, 500_000));
  const db = new DatabaseSync(path); db.prepare("delete from follower_blocks where height=?").run(11); db.close();
  await expect(state.chainView().lookup(txHash)).rejects.toThrow(/coverage/i);
});

it("requires a complete authenticated day before producing admission fee facts", () => {
  const { state } = setup(); state.recordVerifiedBlock(block(10, 0));
  expect(() => state.feeFacts()).toThrow(/24|day/i);
  state.recordVerifiedBlock(block(11, 24 * 60 * 60_000 + 1000));
  expect(state.feeFacts()).toEqual({ chainTime: 24 * 60 * 60_000 + 1000, observations: [], confirmations: [] });
});

it("derives unresolved and safely absent confirmation states from the full interval", async () => {
  const { state } = setup(), day = 24 * 60 * 60_000;
  state.recordVerifiedBlock(block(10, 0)); state.recordVerifiedBlock(block(11, day + 1000));
  const raw = await bytes(day + 100_000), txHash = finalTransaction(raw).transactionHash(); state.recordAttempt(raw);
  expect(state.feeFacts().confirmations).toEqual([{ txHash, fee: 0n, confirmedAt: day + 1000, validUntil: day + 100_000, state: "unknown" }]);
  state.recordVerifiedBlock(block(12, day + 400_000));
  expect(state.feeFacts().confirmations[0]?.state).toBe("unknown");
  state.recordVerifiedBlock(block(13, day + 400_001));
  expect(state.feeFacts().confirmations[0]?.state).toBe("absent");
});

it("never ages a partially executed confirmation into an absent reservation", async () => {
  const { state } = setup(), day = 24 * 60 * 60_000;
  state.recordVerifiedBlock(block(10, 0)); state.recordVerifiedBlock(block(11, day + 1000));
  const raw = await bytes(day + 100_000), txHash = finalTransaction(raw).transactionHash(); state.recordAttempt(raw);
  const included = block(12, day + 2000); included.sends = [{ bytes: raw, txHash, extrinsicIndex: 1, status: "PARTIAL_SUCCESS" }]; state.recordVerifiedBlock(included);
  state.recordVerifiedBlock(block(13, day * 2));
  expect(state.feeFacts().confirmations[0]?.state).toBe("unknown");
});

it("checks the shared coverage interval once for multiple retained reservations", async () => {
  const { state } = setup(), day = 24 * 60 * 60_000;
  state.recordVerifiedBlock(block(10, 0)); state.recordVerifiedBlock(block(11, day + 1000));
  for (let i = 0; i < 4; i++) state.recordAttempt(await bytes(day + 100_000, h(90 + i)));
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  try {
    expect(state.feeFacts().confirmations).toHaveLength(4);
    expect(prepare.mock.calls.filter(([sql]) => sql.includes("select count(*) as count from follower_blocks"))).toHaveLength(1);
  } finally { prepare.mockRestore(); }
});

it("records a real authenticated mainnet block through the existing proof reader", async () => {
  const checkpoint: FinalityCheckpoint = { ...recording.checkpoint, setId: BigInt(recording.checkpoint.setId), authorities: recording.checkpoint.authorities.map(a => ({ ...a, weight: BigInt(a.weight) })) };
  const node = { async call<T>(method: string, params: unknown[] = []) { const key = method + JSON.stringify(params); if (!(key in recording.recording)) throw new Error("Unrecorded test RPC"); return structuredClone(recording.recording[key as keyof typeof recording.recording]) as T; }, async batch<T>(calls: [string, unknown[]][]) { return Promise.all(calls.map(([method, params]) => node.call<T>(method, params))); } };
  const source = rpcOnlySource({ network: "mainnet", node, hints: recording.hints }), hint = recording.hints[0]!;
  const verified = await verifyFollowerBlock({ source, checkpoints: [checkpoint], block: { height: hint.blockHeight, hash: hint.blockHash } });
  const wrong = setup().state; expect(() => wrong.recordVerifiedBlock(verified)).toThrow(/scope/i);
  const { state } = setup({ network: "mainnet", policyDigest: followerPolicyDigest([checkpoint]) }); state.recordVerifiedBlock(verified);
  expect(state.head()).toEqual(verified.block); expect(state.observations(hint.txHash)[0]?.status).toBe("SUCCESS");
});
