import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { followerPolicyDigest, type FollowerBlock } from "../follower-block.js";
import { openFollowerState } from "../follower-state.js";
import { openStandingSession } from "../standing-session.js";
import { batchAuthors, batchBytes, batchScope } from "./batch-fixture.js";
import { finalTransaction } from "../../src/submission.js";

const h = (n: number) => n.toString(16).padStart(64, "0"), now = 1_800_000_000_000, minute = 60_000;
const scope = { ...batchScope, genesis: h(1), policyDigest: followerPolicyDigest([]), runtimeSpecVersion: 1000300 };
const roots: string[] = [], handles: ReturnType<typeof openFollowerState>[] = [];
const block = (height: number, timestamp: number): FollowerBlock => ({ network: scope.network, policyDigest: scope.policyDigest, block: { height, hash: h(height) }, parentHash: h(height - 1), timestamp, runtimeSpecVersion: 1000300, sends: [] });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "standing-session-")); roots.push(root); chmodSync(root, 0o700);
  const path = join(root, "state.sqlite"), state = openFollowerState(path, scope); handles.push(state);
  state.recordVerifiedBlock(block(10, now - 24 * 60 * minute)); state.recordVerifiedBlock(block(11, now));
  const clock = { wallTime: now, monotonicMillis: 5 }, verifiedStart = block(11, now), authors = () => batchAuthors();
  const options = { state, verifiedStart, authors, clock: () => ({ ...clock }) };
  return { state, path, clock, verifiedStart, options, session: openStandingSession(options) };
}
function advance(fixture: ReturnType<typeof setup>, millis: number, height = 12) {
  fixture.clock.wallTime += millis; fixture.clock.monotonicMillis += millis;
  fixture.state.recordVerifiedBlock(block(height, fixture.clock.wallTime));
}
afterEach(() => { for (const state of handles.splice(0)) state.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("requires this process to outlive the full bounded TTL and retirement margin", async () => {
  const f = setup(), initial = await batchBytes({ ttl: now + 10 * minute });
  await expect(f.session.reserve(initial, batchScope.commitment)).rejects.toThrow(/twenty|warmup/i);
  advance(f, 20 * minute);
  const ready = await batchBytes({ ttl: f.clock.wallTime + 10 * minute });
  await expect(f.session.reserve(ready, batchScope.commitment)).rejects.toThrow(/warmup|margin|hold/i);
  advance(f, 1000, 13);
  await expect(f.session.reserve(ready, batchScope.commitment)).resolves.toMatchObject({ commitment: batchScope.commitment });
});

it("starts a new hold even when admissions and history already survived restart", async () => {
  const f = setup(); advance(f, 20 * minute + 1000);
  const raw = await batchBytes({ ttl: f.clock.wallTime + 10 * minute }); await f.session.reserve(raw, batchScope.commitment);
  const restarted = openStandingSession({ ...f.options, verifiedStart: block(12, f.clock.wallTime) });
  await expect(restarted.reserve(raw, batchScope.commitment)).rejects.toThrow(/twenty|warmup/i);
});

it("requires a successful asynchronous readiness check before synchronous reservation", async () => {
  const f = setup(); advance(f, 20 * minute + 1000); const raw = await batchBytes({ ttl: f.clock.wallTime + 10 * minute });
  expect(() => f.session.reserveNow(raw, batchScope.commitment)).toThrow(/ready|readiness/i);
  await f.session.ready(); expect(f.session.reserveNow(raw, batchScope.commitment)).toMatchObject({ commitment: batchScope.commitment, checkedAt: f.clock });
});

it("cannot bypass the strict restore margin through synchronous reservation", async () => {
  const f = setup(); advance(f, 20 * minute); const raw = await batchBytes({ ttl: f.clock.wallTime + 10 * minute });
  await expect(f.session.ready()).rejects.toThrow(/margin|warmup/i);
  expect(() => f.session.reserveNow(raw, batchScope.commitment)).toThrow(/ready|readiness|margin|warmup/i);
});

it("latches a host-clock step even if the clock is corrected before retry", async () => {
  const f = setup(); f.clock.wallTime += 1001;
  await expect(f.session.ready()).rejects.toThrow(/restart/i);
  f.clock.wallTime -= 1001; advance(f, 20 * minute + 1000);
  await expect(f.session.ready()).rejects.toThrow(/restart/i);
});

it("waits for stale follower catch-up without permanently latching an ordinary lag", async () => {
  const f = setup(); f.clock.wallTime += 20 * minute + 1000; f.clock.monotonicMillis += 20 * minute + 1000;
  await expect(f.session.ready()).rejects.toThrow(/stale|twenty|warmup/i);
  f.state.recordVerifiedBlock(block(12, f.clock.wallTime));
  await expect(f.session.ready()).resolves.toMatchObject({ chainTime: f.clock.wallTime });
});

it("captures the verified start by value before caller-owned objects can change", async () => {
  const f = setup(); f.verifiedStart.block.hash = h(99); f.verifiedStart.timestamp = 0;
  advance(f, 20 * minute + 1000);
  await expect(f.session.ready()).resolves.toMatchObject({ chainTime: f.clock.wallTime });
});

it("captures exact transaction bytes before asynchronous session checks yield", async () => {
  const f = setup(); advance(f, 20 * minute + 1000);
  const raw = await batchBytes({ ttl: f.clock.wallTime + 10 * minute }), txHash = finalTransaction(raw).transactionHash();
  const pending = f.session.reserve(raw, batchScope.commitment); raw.fill(0);
  await expect(pending).resolves.toMatchObject({ txHash });
});

it("latches a follower restore that rewinds after this process caught up", async () => {
  const f = setup(); advance(f, 20 * minute + 1000); await f.session.ready();
  const db = new DatabaseSync(f.path); db.prepare("delete from follower_blocks where height=12").run(); db.close();
  await expect(f.session.ready()).rejects.toThrow(/restart|rewind/i);
  f.state.recordVerifiedBlock(block(12, f.clock.wallTime));
  await expect(f.session.ready()).rejects.toThrow(/restart/i);
});

it("latches a rewind observed while an awaited snapshot was being read", async () => {
  const f = setup(); advance(f, 20 * minute + 1000); await f.session.ready();
  const original = f.state.chainView.bind(f.state), spy = vi.spyOn(f.state, "chainView").mockImplementation(() => {
    const view = original(); return { ...view, async indexedThrough() {
      const indexed = await view.indexedThrough();
      const db = new DatabaseSync(f.path); db.exec("delete from follower_blocks where height=12"); db.close(); return indexed;
    } };
  });
  try { await expect(f.session.ready()).rejects.toThrow(/restart/i); } finally { spy.mockRestore(); }
  f.state.recordVerifiedBlock(block(12, f.clock.wallTime));
  await expect(f.session.ready()).rejects.toThrow(/restart/i);
});

it("latches a restore between readiness and the final policy read", async () => {
  const f = setup(); let reads = 0;
  const session = openStandingSession({ ...f.options, authors() {
    if (++reads === 3) { const db = new DatabaseSync(f.path); db.exec("delete from follower_blocks where height=12"); db.close(); }
    return batchAuthors();
  } });
  advance(f, 20 * minute + 1000); const raw = await batchBytes({ ttl: f.clock.wallTime + 10 * minute });
  await expect(session.reserve(raw, batchScope.commitment)).rejects.toThrow(/restart/i);
  f.state.recordVerifiedBlock(block(12, f.clock.wallTime));
  await expect(session.ready()).rejects.toThrow(/restart/i);
});

it("latches lost history after catch-up even when the database becomes empty", async () => {
  const f = setup(); advance(f, 20 * minute + 1000); await f.session.ready();
  const db = new DatabaseSync(f.path); db.exec("delete from follower_blocks"); db.close();
  await expect(f.session.ready()).rejects.toThrow(/restart/i);
  f.state.recordVerifiedBlock(block(10, now - 24 * 60 * minute)); f.state.recordVerifiedBlock(block(11, now)); f.state.recordVerifiedBlock(block(12, f.clock.wallTime));
  await expect(f.session.ready()).rejects.toThrow(/restart/i);
});

it("remembers reservations lost by a same-head restore", async () => {
  const f = setup(); advance(f, 20 * minute + 1000);
  const raw = await batchBytes({ ttl: f.clock.wallTime + 10 * minute }); await f.session.reserve(raw, batchScope.commitment);
  const db = new DatabaseSync(f.path); db.exec("delete from follower_admissions; delete from follower_attempts"); db.close();
  await expect(f.session.ready()).rejects.toThrow(/restart/i);
});

it("rejects a same-head restore inside the atomic reservation boundary", async () => {
  const f = setup(); advance(f, 20 * minute + 1000);
  const first = await batchBytes({ ttl: f.clock.wallTime + 10 * minute }); await f.session.reserve(first, batchScope.commitment);
  const second = await batchBytes({ ttl: f.clock.wallTime + 9 * minute });
  const reserve = f.state.reserveStandingAttempt.bind(f.state), spy = vi.spyOn(f.state, "reserveStandingAttempt").mockImplementation((bytes, policy) => {
    const db = new DatabaseSync(f.path); db.exec("delete from follower_admissions; delete from follower_attempts"); db.close();
    return reserve(bytes, policy);
  });
  try { await expect(f.session.reserve(second, batchScope.commitment)).rejects.toThrow(/history|restart/i); } finally { spy.mockRestore(); }
  expect(f.state.admissions()).toEqual([]);
  await expect(f.session.ready()).rejects.toThrow(/restart/i);
});

it("retains the latest authenticated policy when local policy storage is restored", async () => {
  const f = setup(); let policy = batchAuthors();
  const session = openStandingSession({ ...f.options, authors: () => policy }); advance(f, 20 * minute + 1000);
  const raw = await batchBytes({ ttl: f.clock.wallTime + 10 * minute }); policy = batchAuthors({ role: "relay" }, 2);
  await expect(session.reserve(raw, batchScope.commitment)).rejects.toThrow(/author/i);
  const db = new DatabaseSync(f.path); db.exec("delete from follower_policies"); db.close(); policy = batchAuthors();
  await expect(session.ready()).rejects.toThrow(/serial|restart/i);
  policy = batchAuthors({}, 3); await expect(session.ready()).rejects.toThrow(/restart/i);
});

it("accepts a legitimate policy advance during the final read without poisoning the next cycle", async () => {
  const f = setup(); let reads = 0;
  const session = openStandingSession({ ...f.options, authors: () => batchAuthors({}, ++reads >= 3 ? 2 : 1) });
  advance(f, 20 * minute + 1000); const raw = await batchBytes({ ttl: f.clock.wallTime + 10 * minute });
  await expect(session.reserve(raw, batchScope.commitment)).resolves.toMatchObject({ commitment: batchScope.commitment });
  await expect(session.ready()).resolves.toMatchObject({ chainTime: f.clock.wallTime });
});

it("accepts a sibling observer's legitimate policy advance while still refusing a stale reload", async () => {
  const f = setup(); let policy = batchAuthors();
  const session = openStandingSession({ ...f.options, authors: () => policy }); advance(f, 20 * minute + 1000);
  policy = batchAuthors({}, 2); f.state.observeStandingPolicy(policy);
  await expect(session.ready()).resolves.toMatchObject({ chainTime: f.clock.wallTime });
  policy = batchAuthors(); await expect(session.ready()).rejects.toThrow(/serial|policy|continuity/i);
});

it("requires the durable interval to contain the exact verified startup block", async () => {
  const f = setup(), other = openStandingSession({ ...f.options, verifiedStart: { ...block(11, now), block: { height: 11, hash: h(99) } } });
  advance(f, 20 * minute + 1000);
  await expect(other.ready()).rejects.toThrow(/startup|checkpoint|restart/i);
});

it("checks clock continuity again after reading the current policy", async () => {
  const f = setup(); let reads = 0;
  const session = openStandingSession({ ...f.options, authors() { if (++reads > 1) f.clock.wallTime += 1001; return batchAuthors(); } });
  advance(f, 20 * minute + 1000); const raw = await batchBytes({ ttl: f.clock.wallTime + 10 * minute });
  await expect(session.reserve(raw, batchScope.commitment)).rejects.toThrow(/restart/i);
});

it("refuses a stale or cross-network startup proof", () => {
  const f = setup();
  expect(() => openStandingSession({ ...f.options, verifiedStart: block(11, now - 120_001) })).toThrow(/stale/i);
  expect(() => openStandingSession({ ...f.options, verifiedStart: { ...block(11, now), network: "mainnet" } })).toThrow(/network|scope/i);
});
