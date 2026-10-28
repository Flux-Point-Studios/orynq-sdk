import { addSpan, createTrace } from "@fluxpointstudios/orynq-sdk-process-trace";
import { describe, expect, it } from "vitest";
import {
  actionDigestHex, buildAllowlistRoot, GUARD_LOG_GENESIS, MandateGuard, MemoryGuardLog, nextGuardLogHead, processTraceSink,
  type GuardConfig, type GuardEvent, type GuardLogHead, type MandateV1,
} from "../src/index.js";

const CAP = 10n;
const pay = (amount: bigint) => ({ kind: "payment", asset: "lovelace", amount, counterparty: "supplier", timestamp: 7200n } as const);
const mandate = (): MandateV1 => ({
  schemaVersion: 1n, mandateId: new Uint8Array(16).fill(0x43), principalDid: "did:key:z123456789", agentDid: "did:key:z987654321",
  didFormatVersion: 0n, spendCap: { asset: "lovelace", amount: CAP, windowSeconds: 3600n },
  counterpartyAllowlistRoot: buildAllowlistRoot(["supplier"]), egressPolicy: { mode: 0n, allowlistRoot: new Uint8Array(32) },
  approvedMeasurementSetRoot: new Uint8Array(32), validityWindow: { notBefore: 0n, notAfter: 100_000n },
  disclosurePolicy: { committeeId: "c", threshold: 1n, committeeSize: 1n },
});
type Sink = NonNullable<GuardConfig["onEvent"]>;
const guard = (onEvent: Sink, history: GuardConfig["history"] = "fresh") =>
  new MandateGuard({ mandate: mandate(), counterpartyAllowlist: ["supplier"], now: () => 7200n, history, onEvent });
const sinkTo = (log: MemoryGuardLog): Sink => (event, previous) => log.append(event, previous);
const noHead = "event sink must return the log head after the append";
const casRefusal = /^guard log head is \d+:[0-9a-f]{64}, but the append expected \d+:[0-9a-f]{64}$/;

async function spend(guards: MandateGuard[], amount: bigint): Promise<{ executed: bigint; refusals: string[] }> {
  let executed = 0n;
  const refusals: string[] = [];
  for (const g of guards) {
    try {
      if ((await g.enforceAsync(pay(amount))).allowed) executed += amount;
    } catch (error) {
      refusals.push((error as Error).message);
    }
  }
  return { executed, refusals };
}

describe("L1: the guard confirms the head each append returns", () => {
  it("CONTROL: MemoryGuardLog returns the appended head, so two live guards on one log execute one cap", async () => {
    const log = new MemoryGuardLog();
    const { executed, refusals } = await spend([guard(sinkTo(log)), guard(sinkTo(log))], 10n);
    expect(executed).toBe(CAP);
    expect(refusals).toHaveLength(1);
    expect(log.history().head.count).toBe(1n);
  });

  it("processTraceSink alone returns no head: two live guards are refused and nothing executes", async () => {
    const run = await createTrace({ agentId: "a" });
    const span = addSpan(run, { name: "pay" });
    const sink = processTraceSink(run, span.id) as unknown as Sink;
    const { executed, refusals } = await spend([guard(sink), guard(sink)], 10n);
    expect(executed).toBeLessThanOrEqual(CAP);
    expect({ executed, refusals }).toEqual({ executed: 0n, refusals: [noHead, noHead] });
  });

  it("processTraceSink alone: three fresh restarts on one trace run are refused", async () => {
    const run = await createTrace({ agentId: "a" });
    const span = addSpan(run, { name: "pay" });
    let executed = 0n;
    const refusals: string[] = [];
    for (let restart = 0; restart < 3; restart++) {
      const result = await spend([guard(processTraceSink(run, span.id) as unknown as Sink)], 10n);
      executed += result.executed;
      refusals.push(...result.refusals);
    }
    expect(executed).toBeLessThanOrEqual(CAP);
    expect({ executed, refusals }).toEqual({ executed: 0n, refusals: [noHead, noHead, noHead] });
  });

  it("an idempotent upsert sink that reports nothing is refused", async () => {
    const stored = new Map<bigint, GuardEvent>();
    const upsert = ((event: GuardEvent) => { if (!stored.has(event.seq)) stored.set(event.seq, event); }) as unknown as Sink;
    const { executed, refusals } = await spend([guard(upsert), guard(upsert)], 10n);
    expect(executed).toBeLessThanOrEqual(CAP);
    expect({ executed, refusals }).toEqual({ executed: 0n, refusals: [noHead, noHead] });
  });

  it("a no-op sink is refused synchronously and the guard latches", () => {
    const g = guard((() => undefined) as unknown as Sink);
    expect(() => g.enforce(pay(10n))).toThrow(noHead);
    expect(() => g.enforce(pay(1n))).toThrow(/event sink failed; restore a new guard/);
  });

  it("a sink that returns the previous head or a foreign head is refused and latches", async () => {
    const log = new MemoryGuardLog();
    const stale = guard((event, previous) => { log.append(event, previous); return previous; });
    expect(() => stale.enforce(pay(4n))).toThrow(/^event sink returned log head 0:0{64}, expected 1:[0-9a-f]{64}$/);
    expect(() => stale.enforce(pay(1n))).toThrow(/event sink failed; restore a new guard/);
    const other = new MemoryGuardLog();
    guard(sinkTo(other)).enforce(pay(9n));
    const foreign = guard(async (event, previous) => { log.append(event, previous); return other.history().head; }, log.history());
    await expect(foreign.enforceAsync(pay(1n))).rejects.toThrow(/^event sink returned log head 1:[0-9a-f]{64}, expected 2:[0-9a-f]{64}$/);
    await expect(foreign.enforceAsync(pay(1n))).rejects.toThrow(/event sink failed; restore a new guard/);
  });

  it("enforceAsync refuses a sink that resolves to something other than a head", async () => {
    for (const value of [undefined, null, 1n, "head", { count: 1n }, { count: 1, hash: "0".repeat(64) }]) {
      const g = guard((async () => value) as unknown as Sink);
      await expect(g.enforceAsync(pay(10n))).rejects.toThrow(noHead);
      expect(g.spentInWindow(7200n)).toBe(10n);
      await expect(g.enforceAsync(pay(1n))).rejects.toThrow(/event sink failed; restore a new guard/);
    }
  });
});

describe("L2: an append compares the whole previous head, not just its count", () => {
  function forgedReplica(primary: MemoryGuardLog): { events: GuardEvent[]; head: GuardLogHead } {
    const [e0, e1] = primary.history().events;
    const action = { ...e1!.action, amount: 1n } as GuardEvent["action"];
    const events = [e0!, { ...e1!, action, actionDigest: actionDigestHex(action) } as GuardEvent];
    return { events, head: events.reduce(nextGuardLogHead, GUARD_LOG_GENESIS) };
  }

  it("MemoryGuardLog refuses an expected previous head with the right count and another hash, without writing", () => {
    const log = new MemoryGuardLog();
    const g = guard(sinkTo(log));
    g.enforce(pay(6n));
    const [e0] = log.history().events;
    const before = log.history();
    const forged = { count: 1n, hash: "1".repeat(64) };
    const next = { ...e0!, seq: 1n } as GuardEvent;
    expect(() => log.append(next, forged)).toThrow(casRefusal);
    expect(() => log.append(next, GUARD_LOG_GENESIS)).toThrow(casRefusal);
    for (const missing of [undefined, null, "1:" + "1".repeat(64)]) {
      expect(() => log.append(next, missing as never)).toThrow(/^guard log head must be \{ count: bigint in \[0, 2\^64\], hash: 64 lowercase hex \}$/);
    }
    expect(log.history()).toEqual(before);
    expect(log.append(next, log.history().head)).toEqual(nextGuardLogHead(before.head, next));
  });

  it("split read/write: a guard restored from a forged replica cannot append to the intact primary", () => {
    const primary = new MemoryGuardLog();
    const g = guard(sinkTo(primary));
    expect([g.enforce(pay(6n)).allowed, g.enforce(pay(4n)).allowed]).toEqual([true, true]);
    const restored = guard(sinkTo(primary), forgedReplica(primary));
    expect(restored.spentInWindow(7200n)).toBe(7n);
    let executed = 10n;
    try {
      if (restored.enforce(pay(3n)).allowed) executed += 3n;
    } catch (error) {
      expect((error as Error).message).toMatch(casRefusal);
    }
    expect(executed).toBe(CAP);
    expect(primary.history().events.map(e => e.seq)).toEqual([0n, 1n]);
  });

  it("BOUNDARY: a writer who rewrites both the events and the head restores a lower spend, which the guard cannot detect", () => {
    const primary = new MemoryGuardLog();
    const g = guard(sinkTo(primary));
    g.enforce(pay(6n));
    g.enforce(pay(4n));
    const replica = forgedReplica(primary);
    const rewritten = new MemoryGuardLog();
    replica.events.reduce((previous, event) => rewritten.append(event, previous), GUARD_LOG_GENESIS);
    const restored = guard(sinkTo(rewritten), rewritten.history());
    expect(restored.enforce(pay(3n))).toEqual({ allowed: true });
    expect(restored.spentInWindow(7200n)).toBe(10n);
  });
});
