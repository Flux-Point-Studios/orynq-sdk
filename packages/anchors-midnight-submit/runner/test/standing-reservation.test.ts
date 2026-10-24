import { afterEach, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openFollowerState } from "../follower-state.js";
import { followerPolicyDigest, type FollowerBlock } from "../follower-block.js";
import { declaredFee, finalTransaction } from "../../src/submission.js";
import { parseDust } from "../../src/preflight.js";
import { batchAuthors, batchBytes, batchScope } from "./batch-fixture.js";

const h = (n: number) => n.toString(16).padStart(64, "0"), now = 1_800_000_000_000, minute = 60_000, day = 24 * 60 * minute;
const scope = { ...batchScope, genesis: h(1), policyDigest: followerPolicyDigest([]), runtimeSpecVersion: 1000300 };
const roots: string[] = [], handles: ReturnType<typeof openFollowerState>[] = [];
const block = (height: number, timestamp: number): FollowerBlock => ({ network: scope.network, policyDigest: scope.policyDigest, block: { height, hash: h(height) }, parentHash: h(height - 1), timestamp, runtimeSpecVersion: 1000300, sends: [] });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "standing-reservation-")); roots.push(root); chmodSync(root, 0o700);
  const path = join(root, "state.sqlite"), state = openFollowerState(path, scope); handles.push(state);
  state.recordVerifiedBlock(block(10, now - day)); state.recordVerifiedBlock(block(11, now));
  return { state, path };
}
const policy = (time = now, commitment = batchScope.commitment, height = 11) => ({ commitment, authors: batchAuthors(), started: { chainTime: now - 20 * minute, wallTime: now - 20 * minute, monotonicMillis: 10 }, current: { chainTime: time, wallTime: time, monotonicMillis: 10 + time - (now - 20 * minute), height, hash: h(height) } });
afterEach(() => { for (const state of handles.splice(0)) state.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("atomically records a policy-checked reservation before exact bytes can be sent", async () => {
  const { state, path } = setup(), raw = await batchBytes({ ttl: now + 10 * minute });
  expect(() => state.assertAdmitted(raw)).toThrow(/admi/i);
  const admitted = state.reserveStandingAttempt(raw, policy());
  expect(admitted.txHash).toBe(finalTransaction(raw).transactionHash()); expect(() => state.assertAdmitted(raw)).not.toThrow();
  state.close(); handles.splice(handles.indexOf(state), 1); const resumed = openFollowerState(path, scope); handles.push(resumed);
  expect(() => resumed.assertAdmitted(raw)).not.toThrow(); expect(resumed.attempt(admitted.txHash)?.boundary).toEqual({ height: 11, hash: h(11) });
});

it("never treats provenance alone as standing admission", async () => {
  const { state } = setup(), raw = await batchBytes({ ttl: now + 10 * minute }); state.recordAttempt(raw);
  expect(typeof state.assertAdmitted).toBe("function");
  expect(() => state.assertRecorded(raw)).not.toThrow(); expect(() => state.assertAdmitted(raw)).toThrow(/admi/i);
});

it("rejects a failed policy without recording provenance or admission", async () => {
  const { state } = setup(), raw = await batchBytes({ ttl: now + 10 * minute }), hash = finalTransaction(raw).transactionHash();
  expect(() => state.reserveStandingAttempt(raw, { ...policy(), authors: batchAuthors({ role: "relay" }) })).toThrow(/author/i);
  expect(state.attempt(hash)).toBeNull(); expect(() => state.assertAdmitted(raw)).toThrow(/admi/i);
});

it("requires clock evidence for the actual durable head and a complete restart hold", async () => {
  const { state } = setup(), raw = await batchBytes({ ttl: now + 10 * minute });
  expect(() => state.reserveStandingAttempt(raw, { ...policy(), current: { ...policy().current, chainTime: now - 1 } })).toThrow(/head/i);
  expect(() => state.reserveStandingAttempt(raw, { ...policy(), started: policy().current })).toThrow(/twenty/i);
});

it("binds admission to the exact head even when adjacent blocks share a timestamp", async () => {
  const { state } = setup(), raw = await batchBytes({ ttl: now + 10 * minute }); state.recordVerifiedBlock(block(12, now));
  expect(() => state.reserveStandingAttempt(raw, policy())).toThrow(/head/i);
});

it("requires batch-call history from the author's first authorized block", async () => {
  const { state } = setup(), raw = await batchBytes({ ttl: now + 10 * minute });
  expect(() => state.reserveStandingAttempt(raw, { ...policy(), authors: batchAuthors({ validFrom: 1 }) })).toThrow(/author.*history|history.*author/i);
});

it("remembers a newer revoked policy even though it cannot admit a transaction", async () => {
  const { state } = setup(), raw = await batchBytes({ ttl: now + 10 * minute });
  expect(() => state.reserveStandingAttempt(raw, { ...policy(), authors: batchAuthors({ role: "relay" }, 2) })).toThrow(/author/i);
  expect(() => state.reserveStandingAttempt(raw, policy())).toThrow(/serial|rewound/i);
  expect(state.attempt(finalTransaction(raw).transactionHash())).toBeNull();
});

it("retains a same-serial authoritative conflict across restart until a newer policy resolves it", async () => {
  const { state, path } = setup();
  state.observeStandingPolicy(batchAuthors({}, 2));
  expect(() => state.observeStandingPolicy(batchAuthors({ role: "relay" }, 2))).toThrow(/conflict|differ/i);
  state.close(); handles.splice(handles.indexOf(state), 1); const resumed = openFollowerState(path, scope); handles.push(resumed);
  expect(() => resumed.observeStandingPolicy(batchAuthors({}, 2))).toThrow(/conflict/i);
  const raw = await batchBytes({ ttl: now + 10 * minute });
  expect(() => resumed.reserveStandingAttempt(raw, { ...policy(), authors: batchAuthors({}, 2) })).toThrow(/conflict/i);
  expect(resumed.attempt(finalTransaction(raw).transactionHash())).toBeNull();
  expect(() => resumed.reserveStandingAttempt(raw, { ...policy(), authors: batchAuthors({}, 3) })).not.toThrow();
});

it("binds current author-policy checkpoints to the follower's verification policy", async () => {
  const { state } = setup(), raw = await batchBytes({ ttl: now + 10 * minute });
  const changed = batchAuthors({}, 2, [{ setId: "0", startsAfter: { height: 1, hash: h(5) }, authorities: [{ key: h(6), weight: "1" }] }]);
  expect(() => state.reserveStandingAttempt(raw, { ...policy(), authors: changed })).toThrow(/checkpoint|finality/i);
  expect(() => state.reserveStandingAttempt(raw, policy())).toThrow(/serial|rewound/i);
});

it("restores remembered policy floors without accepting stale reloads or clearing conflicts", () => {
  const { state, path } = setup();
  state.observeStandingPolicy(batchAuthors({}, 2));
  expect(() => state.rememberStandingPolicy(batchAuthors())).not.toThrow();
  expect(() => state.observeStandingPolicy(batchAuthors())).toThrow(/rewound/i);
  expect(() => state.observeStandingPolicy(batchAuthors({ role: "relay" }, 2))).toThrow(/conflict/i);
  expect(() => state.rememberStandingPolicy(batchAuthors())).toThrow(/conflict/i);
  const db = new DatabaseSync(path); db.exec("delete from follower_policies"); db.close();
  state.rememberStandingPolicy(batchAuthors({}, 2));
  expect(() => state.observeStandingPolicy(batchAuthors())).toThrow(/rewound/i);
});

it("retains one commitment across unknown bytes and allows only an identical retry", async () => {
  const { state } = setup(), raw = await batchBytes({ ttl: now + 10 * minute }); state.reserveStandingAttempt(raw, policy());
  expect(() => state.reserveStandingAttempt(raw, policy())).not.toThrow();
  const replacement = await batchBytes({ ttl: now + 10 * minute + 1000 });
  expect(() => state.reserveStandingAttempt(replacement, policy())).toThrow(/commitment|claim/i);
});

it("releases an unobserved commitment only after complete strict TTL-plus-margin coverage", async () => {
  const { state } = setup(), raw = await batchBytes({ ttl: now + 10 * minute }); state.reserveStandingAttempt(raw, policy());
  const later = now + 15 * minute + 1, replacement = await batchBytes({ ttl: later + 10 * minute }); state.recordVerifiedBlock(block(12, later));
  expect(() => state.reserveStandingAttempt(replacement, policy(later, batchScope.commitment, 12))).not.toThrow();
});

it.each(["SUCCESS", "PARTIAL_SUCCESS"] as const)("keeps observed %s commitments beyond the fee window", async status => {
  const { state } = setup(), raw = await batchBytes({ ttl: now + 10 * minute }), included = block(12, now + 1000);
  included.sends = [{ bytes: raw, txHash: finalTransaction(raw).transactionHash(), extrinsicIndex: 1, status }]; state.recordVerifiedBlock(included);
  const later = now + 2 * day; state.recordVerifiedBlock(block(13, later));
  const replacement = await batchBytes({ ttl: later + 10 * minute });
  expect(() => state.reserveStandingAttempt(replacement, policy(later, batchScope.commitment, 13))).toThrow(/commitment|claim|partial/i);
});

it("reserves the exact serialized paid fee and rolls back a daily-cap refusal", async () => {
  const { state, path } = setup(), probe = await batchBytes({ ttl: now + 10 * minute, feeSpends: 1 }), unit = declaredFee(finalTransaction(probe));
  expect(unit).toBeGreaterThan(0n);
  state.reserveStandingAttempt(probe, policy()); expect(state.feeFacts().confirmations[0]?.fee).toBe(unit);
  const db = new DatabaseSync(path), perTx = parseDust("0.01")!;
  const insert = db.prepare("insert into follower_observations(block_hash,extrinsic_index,tx_hash,status,fee,policy_key) values(?,?,?,'SUCCESS',?,1)");
  for (let i = 0; i < 10; i++) insert.run(h(11), i, h(500 + i), (i === 9 ? perTx - unit : perTx).toString());
  db.close();
  const commitment = h(999), refused = await batchBytes({ ttl: now + 10 * minute, feeSpends: 1, commitment });
  expect(() => state.reserveStandingAttempt(refused, policy(now, commitment))).toThrow(/daily/i);
  expect(state.attempt(finalTransaction(refused).transactionHash())).toBeNull(); expect(() => state.assertAdmitted(refused)).toThrow(/admi/i);
});

it("migrates provenance without inventing indexed history or old admissions", async () => {
  const { state, path } = setup(), raw = await batchBytes({ ttl: now + 10 * minute }); state.recordAttempt(raw);
  state.close(); handles.splice(handles.indexOf(state), 1);
  const db = new DatabaseSync(path); db.exec("drop table follower_admissions; drop table follower_batch_calls; drop table follower_policies; alter table follower_blocks drop column batch_indexed; pragma user_version=1"); db.close();
  const resumed = openFollowerState(path, scope); handles.push(resumed);
  expect(() => resumed.assertAdmitted(raw)).toThrow(/admi/i);
  expect(() => resumed.reserveStandingAttempt(raw, policy())).toThrow(/history|index/i);
  resumed.recordVerifiedBlock(block(10, now - day)); resumed.recordVerifiedBlock(block(11, now));
  expect(resumed.head()).toEqual({ height: 11, hash: h(11) });
  expect(() => resumed.reserveStandingAttempt(raw, policy())).not.toThrow();
});
