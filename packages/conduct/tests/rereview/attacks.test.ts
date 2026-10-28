// Adversarial review suite. Each test is labelled CONTROL, DEFENDED, OBSERVE or HOST-MISUSE.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { addEvent, addSpan, closeSpan, computeEventHash, createTrace } from "@fluxpointstudios/orynq-sdk-process-trace";
import {
  actionDigestHex, buildAllowlistRoot, compileMandatePredicate, encodeMandate, decodeMandate, GuardConfigError,
  MandateGuard, MemoryGuardLog, toProcessTraceEvent, type GuardAction, type GuardConfig, type GuardEvent, type MandateV1,
} from "../../src/index.js";

const CP = ["supplier"];
const EG = ["api.example.com"];
const ctx = { id: "550e8400-e29b-41d4-a716-446655440000", seq: 0, timestamp: "2026-10-27T00:00:00.000Z", visibility: "private" as const };
function mandate(over: Partial<MandateV1> = {}, cap: Partial<MandateV1["spendCap"]> = {}): MandateV1 {
  return {
    schemaVersion: 1n, mandateId: new Uint8Array(16), principalDid: "did:key:z123456789", agentDid: "did:key:z987654321",
    didFormatVersion: 0n, spendCap: { asset: "lovelace", amount: 10n, windowSeconds: 3600n, ...cap },
    counterpartyAllowlistRoot: buildAllowlistRoot(CP), egressPolicy: { mode: 0n, allowlistRoot: new Uint8Array(32) },
    approvedMeasurementSetRoot: new Uint8Array(32), validityWindow: { notBefore: 0n, notAfter: 100_000n },
    disclosurePolicy: { committeeId: "c", threshold: 1n, committeeSize: 1n }, ...over,
  };
}
const egressMandate = (over: Partial<MandateV1> = {}) => mandate({ egressPolicy: { mode: 1n, allowlistRoot: buildAllowlistRoot(EG) }, ...over });
const pay = { kind: "payment", asset: "lovelace", amount: 6n, counterparty: "supplier", timestamp: 7200n } as const;
const cfg = (extra: Partial<GuardConfig> = {}): GuardConfig => {
  const log = new MemoryGuardLog();
  return { mandate: mandate(), counterpartyAllowlist: CP, now: () => 7200n, history: "fresh", onEvent: e => log.append(e), ...extra };
};
function recorder(extra: Partial<GuardConfig> = {}) {
  const events: GuardEvent[] = [];
  const log = new MemoryGuardLog();
  const guard = new MandateGuard(cfg({ onEvent: e => { log.append(e); events.push(e); }, ...extra }));
  return { guard, events, log };
}

describe("F1 re-run: unknown/poisoned action content", () => {
  it("CONTROL: clean allowed action hashes through process-trace", async () => {
    const { guard, events } = recorder();
    expect(guard.enforce(pay)).toEqual({ allowed: true });
    await expect(computeEventHash(toProcessTraceEvent(events[0]!, ctx))).resolves.toMatch(/^[0-9a-f]{64}$/);
  });
  const poisoned: [string, () => unknown][] = [
    ["JSON 1e999 extra", () => ({ ...JSON.parse('{"asset":"lovelace","counterparty":"supplier","note":1e999}'), kind: "payment", amount: 6n, timestamp: 7200n })],
    ["symbol key", () => ({ ...pay, [Symbol("x")]: 1 })],
    ["own __proto__ key from JSON", () => ({ ...JSON.parse('{"__proto__":{"evil":1},"asset":"lovelace","counterparty":"supplier"}'), kind: "payment", amount: 6n, timestamp: 7200n })],
    ["boxed string asset", () => ({ ...pay, asset: new String("lovelace") })],
    ["boxed bigint amount", () => ({ ...pay, amount: Object(6n) })],
    ["number amount", () => ({ ...pay, amount: 6 })],
    ["egress carrying payment fields", () => ({ kind: "egress", destination: "api.example.com", timestamp: 7200n, amount: 1n })],
    ["kind only on prototype", () => Object.assign(Object.create({ kind: "payment" }), { asset: "lovelace", amount: 6n, counterparty: "supplier", timestamp: 7200n })],
  ];
  for (const [name, make] of poisoned) {
    it(`DEFENDED: ${name} rejects before reservation, seq or event`, () => {
      const { guard, events } = recorder();
      expect(() => guard.enforce(make() as GuardAction)).toThrow();
      expect(guard.spentInWindow(7200n)).toBe(0n);
      expect(events).toHaveLength(0);
      guard.enforce(pay);
      expect(events[0]!.seq).toBe(0n);
    });
  }
  it("DEFENDED: non-enumerable extra field cannot reach the record", () => {
    const { guard, events } = recorder();
    const a = { ...pay } as Record<string, unknown>;
    Object.defineProperty(a, "note", { value: Infinity, enumerable: false });
    expect(guard.enforce(a as unknown as GuardAction).allowed).toBe(true);
    expect(Object.keys(events[0]!.action)).toEqual(["kind", "asset", "amount", "counterparty", "timestamp"]);
  });
  it("DEFENDED: a Proxy action whose traps change between reads is snapshotted once", () => {
    let reads = 0;
    const p = new Proxy({ ...pay }, { get(t, k) { if (k === "counterparty") return reads++ === 0 ? "supplier" : "mallory"; return Reflect.get(t, k); } });
    const { guard, events } = recorder();
    expect(guard.enforce(p as GuardAction).allowed).toBe(true);
    expect(events[0]!.action).toMatchObject({ counterparty: "supplier" });
    expect(events[0]!.actionDigest).toBe(actionDigestHex(pay));
  });
  it("DEFENDED: event-level extra field and nested action extra field reject in the trace adapter and replay", () => {
    const { guard, events, log } = recorder();
    guard.enforce(pay);
    const e = events[0]!;
    expect(() => toProcessTraceEvent({ ...e, note: Infinity } as unknown as GuardEvent, ctx)).toThrow(/unknown guard event field/);
    expect(() => toProcessTraceEvent({ ...e, action: { ...e.action, note: 1 } } as unknown as GuardEvent, ctx)).toThrow(/unknown action key/);
    expect(() => new MandateGuard(cfg({ history: { events: [{ ...e, note: 1 } as unknown as GuardEvent], head: log.history().head } }))).toThrow(GuardConfigError);
  });
  it("DEFENDED (fuzz): every accepted action yields an event that process-trace can hash", async () => {
    const str = fc.string({ unit: "binary", minLength: 1, maxLength: 70 });
    const u64 = fc.bigInt({ min: 0n, max: (1n << 64n) - 1n });
    await fc.assert(fc.asyncProperty(fc.oneof(
      fc.record({ kind: fc.constant("payment" as const), asset: fc.oneof(fc.constant("lovelace"), str), amount: fc.bigInt({ min: 1n, max: (1n << 64n) - 1n }), counterparty: fc.oneof(fc.constant("supplier"), str), timestamp: u64 }),
      fc.record({ kind: fc.constant("egress" as const), destination: fc.oneof(fc.constant("api.example.com"), str), timestamp: u64 }),
    ), async (action) => {
      const events: GuardEvent[] = [];
      const log = new MemoryGuardLog();
      const g = new MandateGuard({ mandate: egressMandate({ validityWindow: { notBefore: 0n, notAfter: (1n << 64n) - 1n } }), counterpartyAllowlist: CP, egressAllowlist: EG, history: "fresh", now: () => action.timestamp, onEvent: e => { log.append(e); events.push(e); } });
      let decided = false;
      try { g.enforce(action as GuardAction); decided = true; } catch { expect(events).toHaveLength(0); expect(g.spentInWindow(action.timestamp)).toBe(0n); }
      if (decided) {
        expect(events).toHaveLength(1);
        await expect(computeEventHash(toProcessTraceEvent(events[0]!, ctx))).resolves.toMatch(/^[0-9a-f]{64}$/);
        expect(() => new MandateGuard({ mandate: egressMandate({ validityWindow: { notBefore: 0n, notAfter: (1n << 64n) - 1n } }), counterpartyAllowlist: CP, egressAllowlist: EG, history: log.history() })).not.toThrow();
      }
    }), { numRuns: 1500, seed: 20261027 });
  });
});

describe("F2 re-run: caller-chosen timestamps and the guard clock", () => {
  it("CONTROL: same-time cap-sized burst is capped", () => {
    const g = new MandateGuard(cfg());
    expect([0, 1, 2].map(() => g.enforce({ ...pay, amount: 10n }).allowed)).toEqual([true, false, false]);
  });
  it("DEFENDED: original F2 burst (7200, 2^39, 3600) cannot open fresh windows", () => {
    const g = new MandateGuard(cfg());
    expect(g.enforce({ ...pay, amount: 10n }).allowed).toBe(true);
    for (const timestamp of [1n << 39n, 3600n]) expect(() => g.enforce({ ...pay, amount: 10n, timestamp })).toThrow(/timestamp/);
    expect(g.spentInWindow(1n << 39n) + g.spentInWindow(3600n)).toBe(0n);
  });
  it("DEFENDED: window edges - last second of window W and first second of W+1 must match the clock window", () => {
    const g = new MandateGuard(cfg({ now: () => 10_799n }));
    expect(() => g.enforce({ ...pay, timestamp: 10_800n })).toThrow(/timestamp/);
    expect(g.enforce({ ...pay, timestamp: 10_799n }).allowed).toBe(true);
    const h = new MandateGuard(cfg({ now: () => 10_800n }));
    expect(() => h.enforce({ ...pay, timestamp: 10_799n })).toThrow(/timestamp/);
  });
  it("DEFENDED (NF-6): post-dated action time cannot reach notBefore while the clock is before it (V1)", () => {
    const g = new MandateGuard(cfg({ mandate: mandate({ validityWindow: { notBefore: 7201n, notAfter: 100_000n } }), now: () => 7200n }));
    expect(g.evaluate({ ...pay, timestamp: 7201n }).allowed).toBe(true);
    expect(() => g.enforce({ ...pay, timestamp: 7201n })).toThrow(/action timestamp must not be later than the guard clock/);
    expect(g.enforce(pay)).toMatchObject({ allowed: false, reason: "MANDATE_NOT_YET_VALID" });
    expect(g.spentInWindow(7200n)).toBe(0n);
  });
  it("DEFENDED: clock exactly at notAfter with back-dated action time denies (V2)", () => {
    const g = new MandateGuard(cfg({ mandate: mandate({ validityWindow: { notBefore: 0n, notAfter: 7201n } }), now: () => 7201n }));
    expect(g.enforce({ ...pay, timestamp: 7200n })).toMatchObject({ allowed: false, reason: "MANDATE_EXPIRED" });
  });
  it("CONTROL: clock and action at notAfter-1 / notBefore are allowed", () => {
    expect(new MandateGuard(cfg({ mandate: mandate({ validityWindow: { notBefore: 0n, notAfter: 7201n } }), now: () => 7200n })).enforce(pay).allowed).toBe(true);
    expect(new MandateGuard(cfg({ mandate: mandate({ validityWindow: { notBefore: 7200n, notAfter: 9000n } }), now: () => 7200n })).enforce(pay).allowed).toBe(true);
  });
  it("DEFENDED: backward clock throws before state and does not poison the guard", () => {
    let now = 7300n;
    const { guard, events } = recorder({ now: () => now });
    guard.enforce({ ...pay, timestamp: 7300n });
    now = 7299n;
    expect(() => guard.enforce({ ...pay, timestamp: 7300n })).toThrow(/clock/);
    expect(events).toHaveLength(1);
    now = 7301n;
    expect(guard.enforce({ ...pay, amount: 4n, timestamp: 7301n }).allowed).toBe(true);
  });
  it("DEFENDED: hostile clocks (throwing, number, negative, >=2^64) reject before state", () => {
    for (const now of [() => { throw new Error("clock"); }, () => 7200 as unknown as bigint, () => -1n, () => 1n << 64n]) {
      const { guard, events } = recorder({ now });
      expect(() => guard.enforce(pay)).toThrow();
      expect(events).toHaveLength(0);
      expect(guard.spentInWindow(7200n)).toBe(0n);
    }
  });
  it("DEFENDED (NF-6): an agent-chosen end-of-window time is refused and cannot pin lastTimestamp", () => {
    let now = 7200n;
    const { guard, events } = recorder({ now: () => now, mandate: mandate({}, { windowSeconds: 3600n }) });
    expect(() => guard.enforce({ kind: "egress", destination: "x", timestamp: 10_799n })).toThrow(/action timestamp must not be later than the guard clock/);
    now = 7300n;
    expect(guard.enforce({ ...pay, timestamp: now }).allowed).toBe(true);
    now = 10_800n;
    expect(guard.enforce({ ...pay, timestamp: now }).allowed).toBe(true);
    expect(events).toHaveLength(2);
  });
  it("OBSERVE (availability): default clock + README-style host timestamp races at window boundary (windowSeconds=1)", () => {
    const realNow = Date.now;
    const seq = [7_200_999, 7_201_000];
    let i = 0;
    Date.now = () => seq[Math.min(i++, seq.length - 1)]!;
    try {
      const log = new MemoryGuardLog();
      const g = new MandateGuard({ mandate: mandate({}, { windowSeconds: 1n }), counterpartyAllowlist: CP, history: "fresh", onEvent: e => log.append(e) });
      const ts = BigInt(Math.floor(Date.now() / 1000));
      expect(() => g.enforce({ ...pay, timestamp: ts })).toThrow(/current window/);
    } finally { Date.now = realNow; }
  });
});

describe("F3 re-run: sink failures and thenables", () => {
  it("CONTROL: sync sink throw propagates, reservation consumed, instance refuses further enforcement", () => {
    const g = new MandateGuard(cfg({ onEvent: () => { throw new Error("sink down"); } }));
    expect(() => g.enforce(pay)).toThrow("sink down");
    expect(g.spentInWindow(7200n)).toBe(6n);
    expect(() => g.enforce({ ...pay, amount: 1n })).toThrow(/sink failed/);
  });
  it("DEFENDED: original F3 (closed span, addEvent promise) is rejected by sync enforce", async () => {
    const run = await createTrace({ agentId: "a" });
    const span = addSpan(run, { name: "s" });
    await closeSpan(run, span.id);
    let rec: Promise<unknown> | undefined;
    const g = new MandateGuard(cfg({ onEvent: e => (rec = addEvent(run, span.id, toProcessTraceEvent(e, ctx))) }));
    expect(() => g.enforce(pay)).toThrow(/enforceAsync/);
    await expect(rec).rejects.toThrow(/closed span/);
    expect(run.events).toHaveLength(0);
  });
  const thenables: [string, () => unknown][] = [
    ["plain thenable object", () => ({ then(r: () => void) { r(); } })],
    ["callable thenable", () => Object.assign(() => undefined, { then(r: () => void) { r(); } })],
    ["throwing then getter", () => ({ get then() { throw new Error("getter"); } })],
    ["resolved native promise", () => Promise.resolve()],
  ];
  for (const [name, make] of thenables) {
    it(`DEFENDED: sync enforce refuses ${name} and fails closed`, async () => {
      const g = new MandateGuard(cfg({ onEvent: () => make() }));
      expect(() => g.enforce(pay)).toThrow();
      await new Promise(r => setImmediate(r));
      expect(() => g.enforce(pay)).toThrow(/sink failed/);
    });
  }
  it("HOST-MISUSE ONLY: a promise with a shadowed then is treated as a sync success (not attacker-reachable)", async () => {
    let rejectIt!: (e: Error) => void;
    const p = new Promise<void>((_, rej) => { rejectIt = rej; });
    p.catch(() => undefined);
    Object.defineProperty(p, "then", { value: undefined });
    const g = new MandateGuard(cfg({ onEvent: () => p }));
    expect(g.enforce(pay).allowed).toBe(true);
    rejectIt(new Error("durability failed later"));
    await new Promise(r => setImmediate(r));
    expect(g.enforce({ ...pay, amount: 4n }).allowed).toBe(true);
  });
  it("DEFENDED: enforceAsync - sync throw, async rejection and missing sink", async () => {
    const a = new MandateGuard(cfg({ onEvent: () => { throw new Error("sync"); } }));
    await expect(a.enforceAsync(pay)).rejects.toThrow("sync");
    await expect(a.enforceAsync(pay)).rejects.toThrow(/sink failed/);
    const b = new MandateGuard(cfg({ onEvent: () => Promise.reject(new Error("async")) }));
    await expect(b.enforceAsync(pay)).rejects.toThrow("async");
    expect(() => b.enforce(pay)).toThrow(/sink failed/);
    const c = new MandateGuard({ mandate: mandate(), counterpartyAllowlist: CP, now: () => 7200n, history: "fresh" });
    await expect(c.enforceAsync(pay)).rejects.toThrow(/requires an event sink/);
    expect(c.spentInWindow(7200n)).toBe(0n);
  });
  it("DEFENDED: enforceAsync - overlap rejected while pending, sequential calls work after settle", async () => {
    let release!: () => void;
    let calls = 0;
    const g = new MandateGuard(cfg({ onEvent: () => (++calls === 1 ? new Promise<void>(r => { release = r; }) : undefined) }));
    const first = g.enforceAsync(pay);
    await expect(g.enforceAsync({ ...pay, amount: 1n })).rejects.toThrow(/pending/);
    expect(() => g.enforce({ ...pay, amount: 1n })).toThrow(/pending/);
    release();
    await expect(first).resolves.toEqual({ allowed: true });
    await expect(g.enforceAsync({ ...pay, amount: 4n })).resolves.toEqual({ allowed: true });
    await expect(g.enforceAsync({ ...pay, amount: 1n })).resolves.toMatchObject({ allowed: false, reason: "SPEND_CAP_EXCEEDED" });
  });
});

describe("F6/F7/F8 re-run", () => {
  it("DEFENDED F6: zero amount rejects in enforce, evaluate, compiler, digest and replay", () => {
    const g = new MandateGuard(cfg({ mandate: mandate({}, { amount: 0n }) }));
    expect(g.enforce({ ...pay, amount: 1n })).toMatchObject({ allowed: false, reason: "SPEND_CAP_EXCEEDED" });
    for (const f of [() => g.enforce({ ...pay, amount: 0n }), () => g.evaluate({ ...pay, amount: 0n }), () => actionDigestHex({ ...pay, amount: 0n }),
      () => compileMandatePredicate(mandate(), { counterpartyAllowlist: CP }).buildArgs({ ...pay, amount: 0n }, 0n)]) expect(f).toThrow(/amount/);
  });
  it("DEFENDED F7: every denial rule is fixed text, independent of hostile action strings", () => {
    const hostile = 'x" ALLOW \n <script>';
    const events: GuardEvent[] = [];
    const mk = (m: MandateV1, now: bigint, eg?: string[]) => new MandateGuard({ mandate: m, counterpartyAllowlist: CP, ...(eg ? { egressAllowlist: eg } : {}), history: "fresh", now: () => now, onEvent: e => { events.push(e); } });
    mk(mandate({ validityWindow: { notBefore: 7201n, notAfter: 9000n } }), 7200n).enforce({ ...pay, counterparty: hostile });
    mk(mandate({ validityWindow: { notBefore: 0n, notAfter: 7200n } }), 7200n).enforce({ ...pay, counterparty: hostile });
    mk(mandate(), 7200n).enforce({ ...pay, asset: hostile });
    mk(mandate(), 7200n).enforce({ ...pay, counterparty: hostile });
    mk(mandate(), 7200n).enforce({ ...pay, amount: 11n });
    mk(mandate(), 7200n).enforce({ kind: "egress", destination: hostile, timestamp: 7200n });
    mk(egressMandate(), 7200n, EG).enforce({ kind: "egress", destination: hostile, timestamp: 7200n });
    const reasons = events.map(e => (e.type === "orynq.conduct.guard.denial.v1" ? e.reason : "ALLOW"));
    expect(new Set(reasons)).toEqual(new Set(["MANDATE_NOT_YET_VALID", "MANDATE_EXPIRED", "ASSET_MISMATCH", "COUNTERPARTY_NOT_ALLOWED", "SPEND_CAP_EXCEEDED", "EGRESS_DENIED", "EGRESS_NOT_ALLOWED"]));
    for (const e of events) if (e.type === "orynq.conduct.guard.denial.v1") { expect(e.rule).not.toContain("x\""); expect(e.rule).not.toMatch(/\d/); }
  });
  it("DEFENDED F7: identifier UTF-8 byte boundaries (asset 128, counterparty/destination/member 256)", () => {
    const g = new MandateGuard(cfg());
    const four = "\u{1F600}";
    expect(g.evaluate({ ...pay, asset: four.repeat(32) })).toMatchObject({ reason: "ASSET_MISMATCH" });
    expect(() => g.evaluate({ ...pay, asset: four.repeat(32) + "a" })).toThrow(/identifier/);
    expect(g.evaluate({ ...pay, counterparty: four.repeat(64) })).toMatchObject({ reason: "COUNTERPARTY_NOT_ALLOWED" });
    expect(() => g.evaluate({ ...pay, counterparty: four.repeat(64) + "a" })).toThrow(/identifier/);
    expect(() => g.evaluate({ ...pay, counterparty: "\ud800" })).toThrow(/identifier/);
    expect(() => buildAllowlistRoot([four.repeat(64)])).not.toThrow();
    expect(() => buildAllowlistRoot([four.repeat(64) + "a"])).toThrow(/member/);
    expect(() => g.evaluate({ ...pay, counterparty: "x".repeat(8 << 20) })).toThrow(/identifier/);
  });
  it("DEFENDED F8: committeeId bounded in UTF-8 bytes on encode and decode", () => {
    const m = (id: string) => mandate({ disclosurePolicy: { committeeId: id, threshold: 1n, committeeSize: 1n } });
    expect(decodeMandate(encodeMandate(m("\u{1F600}".repeat(32)))).disclosurePolicy.committeeId).toBe("\u{1F600}".repeat(32));
    expect(() => encodeMandate(m("\u{1F600}".repeat(32) + "a"))).toThrow(/committeeId/);
    const ok = encodeMandate(m("a".repeat(128)));
    const idx = Buffer.from(ok).indexOf(Buffer.from("78" + "80", "hex"));
    expect(idx).toBeGreaterThan(0);
  });
  it("DEFENDED Info: hostile own iterators on guard allowlists cannot split hashing from membership", () => {
    const list = ["supplier"];
    Object.defineProperty(list, Symbol.iterator, { value: function* () { yield "supplier"; yield "mallory"; } });
    expect(() => new MandateGuard(cfg({ counterpartyAllowlist: list }))).toThrow(GuardConfigError);
    const eg = ["api.example.com"];
    Object.defineProperty(eg, Symbol.iterator, { value: function* () { yield "api.example.com"; yield "evil.example"; } });
    expect(() => new MandateGuard({ mandate: egressMandate(), counterpartyAllowlist: CP, egressAllowlist: eg, history: "fresh", now: () => 7200n })).toThrow(GuardConfigError);
  });
});

describe("Replay / spend restoration (new code)", () => {
  function history() {
    const { guard, log } = recorder();
    guard.enforce(pay);
    guard.enforce({ ...pay, amount: 4n });
    guard.enforce({ ...pay, amount: 1n });
    return { log, ...log.history() };
  }
  it("CONTROL: full log restores spend 10, seq 3 and denies further spend", () => {
    const { log, events, head } = history();
    expect(events.map(e => e.type.split(".")[3])).toEqual(["action", "action", "denial"]);
    const g = new MandateGuard(cfg({ history: { events, head }, onEvent: e => log.append(e) }));
    expect(g.spentInWindow(7200n)).toBe(10n);
    expect(g.enforce({ ...pay, amount: 1n })).toMatchObject({ allowed: false });
  });
  it("DEFENDED: foreign mandate, duplicated, reordered, suffix-only and type-flipped logs reject", () => {
    const { events, head } = history();
    const foreign = (() => { const { guard, events: ev } = recorder({ mandate: mandate({ mandateId: new Uint8Array(16).fill(7) }) }); guard.enforce(pay); return ev; })();
    for (const bad of [foreign, [events[0]!, events[0]!], [events[1]!, events[0]!], events.slice(1),
      [events[0]!, events[1]!, (({ reason: _r, rule: _u, ...rest }) => ({ ...rest, type: "orynq.conduct.guard.action.v1" }))(events[2] as Extract<GuardEvent, { type: "orynq.conduct.guard.denial.v1" }>)],
      [{ ...events[0]!, type: "orynq.conduct.guard.denial.v1", reason: "SPEND_CAP_EXCEEDED", rule: "payment exceeds the remaining window spend cap" }]]) {
      expect(() => new MandateGuard(cfg({ history: { events: bad as GuardEvent[], head } }))).toThrow(GuardConfigError);
    }
  });
  it("DEFENDED (R-3): tail truncation is refused against the head the sink reports", () => {
    const { events, head } = history();
    expect(() => new MandateGuard(cfg({ history: { events: events.slice(0, 1), head } }))).toThrow(/recorded guard events do not end at the expected log head/);
  });
  it("DEFENDED (R-3): delete-and-renumber of a middle allowed payment is refused against the sink head", () => {
    const { events, head } = history();
    const forged = [{ ...events[1]!, seq: 0n }];
    expect(() => new MandateGuard(cfg({ history: { events: forged, head } }))).toThrow(/recorded guard events do not end at the expected log head/);
  });
  it("DEFENDED (R-3): a recorded enforcedAt moved into the future is refused against the sink head", () => {
    const { guard, events, log } = recorder({ now: () => 7200n });
    guard.enforce(pay);
    const far = [{ ...events[0]!, enforcedAt: 10_799n }];
    expect(() => new MandateGuard(cfg({ history: { events: far, head: log.history().head } }))).toThrow(/recorded guard events do not end at the expected log head/);
  });
  it("DEFENDED (NF-5): toProcessTraceEvent and replay both refuse a coerced non-string denial reason", () => {
    const { guard, events, log } = recorder();
    guard.enforce({ ...pay, counterparty: "mallory" });
    const e = events[0]! as Extract<GuardEvent, { type: "orynq.conduct.guard.denial.v1" }>;
    const forged = { ...e, reason: [e.reason] } as unknown as GuardEvent;
    expect(() => toProcessTraceEvent(forged, ctx)).toThrow(/invalid guard denial reason or rule/);
    expect(() => new MandateGuard(cfg({ history: { events: [forged], head: log.history().head } }))).toThrow(GuardConfigError);
  });
  it("DEFENDED: a promise-misuse event that the sink later persisted replays as consumed spend (conservative)", async () => {
    const log = new MemoryGuardLog();
    const g = new MandateGuard(cfg({ onEvent: e => Promise.resolve().then(() => { log.append(e); }) }));
    expect(() => g.enforce({ ...pay, amount: 10n })).toThrow(/enforceAsync/);
    await new Promise(r => setImmediate(r));
    expect(log.history().events).toHaveLength(1);
    const h = new MandateGuard(cfg({ history: log.history(), onEvent: e => log.append(e) }));
    expect(h.enforce({ ...pay, amount: 1n })).toMatchObject({ allowed: false, reason: "SPEND_CAP_EXCEEDED" });
  });
});
