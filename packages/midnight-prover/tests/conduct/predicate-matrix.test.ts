import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkVerdictArgs, circuitOutcomes, CLAIMS, egress, MAX_U64, matrixCases, payment, policy, runPolicy, slot, T0, VERDICT_CODES, type Step, type VerdictCase } from "./cases.js";
import { loadUnit, zkCheck } from "./harness.js";

const { pureCircuits } = await loadUnit("predicate");
const at = (c: VerdictCase, name: string) => c.args[slot(name)] as bigint;
const HISTORIES = 1000;
const MIN_GENERATED_SHAPE = 10;

describe("T-A06 every window, asset, counterparty, cap, mode and clock combination", () => {
  const cases = matrixCases();
  it("enumerates all 144 combinations, and the runtime refuses exactly the 32 late actions behind a clock inside validity", () => {
    expect(cases).toHaveLength(144);
    expect(new Set(cases.map(c => c.name)).size).toBe(144);
    const refused = cases.filter(c => typeof c.guard !== "number");
    expect(refused).toHaveLength(32);
    expect(refused.every(c => at(c, "action_timestamp") > c.enforcedAt && c.enforcedAt < at(c, "not_after"))).toBe(true);
  });
  it.each(cases.map(c => [c.name, c] as const))("%s", (_name, c) => {
    expect(circuitOutcomes(pureCircuits, c), c.name).toEqual({ evaluate: c.evaluate, guard: c.guard });
  });
});

// Small values make window edges, cap edges and a clock ahead of the action or past notAfter common. Three in four
// first payments fall inside validity under a cap with room for them, so the second step usually carries a prior spend.
// Every generated step is one the guard accepts: action times never decrease, the clock never runs backward, never
// trails the action and stays in the action's spend window.
const scenario = fc.record({
  window: fc.oneof(fc.bigInt(1n, 8n), fc.constant(64n)), notBefore: fc.bigInt(0n, 10n), span: fc.bigInt(1n, 6n), cap: fc.bigInt(0n, 12n), allowlist: fc.boolean(),
  first: fc.record({
    amount: fc.bigInt(1n, 12n), fits: fc.constantFrom(true, true, true, false), offset: fc.bigInt(0n, 5n), capRoom: fc.bigInt(0n, 8n),
    ts: fc.bigInt(0n, 14n), ahead: fc.oneof(fc.constant(0n), fc.bigInt(0n, 7n)),
  }),
  second: fc.record({
    kind: fc.constantFrom("payment", "egress"), amount: fc.bigInt(1n, 12n), assetOk: fc.boolean(), listed: fc.boolean(),
    later: fc.oneof(fc.constant(0n), fc.bigInt(0n, 9n)), back: fc.bigInt(0n, 9n),
  }),
});
type Scenario = typeof scenario extends fc.Arbitrary<infer T> ? T : never;

const policyOf = (s: Scenario) => policy({
  cap: s.first.fits ? s.first.amount + s.first.capRoom : s.cap, window: s.window, notBefore: s.notBefore, notAfter: s.notBefore + s.span,
  ...(s.allowlist ? { egress: ["api.example.com"] } : {}),
});

function steps(s: Scenario): Step[] {
  const windowEnd = (t: bigint) => (t / s.window + 1n) * s.window - 1n;
  const ts0 = s.first.fits ? s.notBefore + s.first.offset % s.span : s.first.ts;
  const clock0 = ts0 + s.first.ahead % (windowEnd(ts0) - ts0 + 1n);
  const clock1 = clock0 + s.second.later;
  const lowest = ts0 > clock1 - (clock1 % s.window) ? ts0 : clock1 - (clock1 % s.window);
  const ts1 = clock1 - s.second.back % (clock1 - lowest + 1n);
  const second = s.second.kind === "payment"
    ? payment(s.second.amount, ts1, s.second.assetOk ? "lovelace" : "dust", s.second.listed ? "alice" : "mallory")
    : egress(s.second.listed ? "api.example.com" : "evil.example.com", ts1);
  return [{ action: payment(s.first.amount, ts0), clock: clock0 }, { action: second, clock: clock1 }];
}

describe("T-A06 generated guard histories", () => {
  const generated = fc.sample(scenario, { seed: 20261031, numRuns: HISTORIES }).flatMap((s, i) => runPolicy("generated", `history ${i}`, policyOf(s), steps(s)));

  it(`circuit equals runtime on every step of ${HISTORIES} generated two-step histories`, () => {
    expect(generated).toHaveLength(2 * HISTORIES);
    for (const c of generated) expect(circuitOutcomes(pureCircuits, c), c.name).toEqual({ evaluate: c.evaluate, guard: c.guard });
  });

  it("a prior spend above 0 meets a clock-decided expiry, an action-time expiry, the cap and an allowed payment", () => {
    const spent = generated.filter(c => c.prior > 0n);
    const shapes: [string, (c: VerdictCase) => boolean][] = [
      ["a clock at or past notAfter after an earlier action", c => c.guard === 2 && c.enforcedAt >= at(c, "not_after") && at(c, "action_timestamp") < at(c, "not_after")],
      ["an action at or past notAfter", c => c.guard === 2 && at(c, "action_timestamp") >= at(c, "not_after")],
      ["a payment over the cap", c => c.guard === 4],
      ["an allowed payment", c => c.guard === 0 && at(c, "action_kind") === 0n],
    ];
    const counts = shapes.map(([shape, holds]) => `${shape}: ${spent.filter(holds).length}`);
    expect(counts.filter(count => Number(count.split(": ")[1]) < MIN_GENERATED_SHAPE), counts.join("; ")).toEqual([]);
  });
});

// Every numeric slot drawn across uint64: its edges, both sides of 2^32, realistic Unix times and small values, with the
// validity window placed around the action times and the cap around the amounts. Every history is one the guard
// accepts, except that the second action may fall after the guard clock, which the runtime refuses.
const FULL_RANGE_HISTORIES = 2000;
const ZKIR_SAMPLE_EVERY = 50;
const U32 = 1n << 32n;
const anywhere = fc.oneof(
  fc.constantFrom(0n, 1n, 2n, U32 - 1n, U32, 1n << 53n, 1n << 63n, MAX_U64 - 2n, MAX_U64 - 1n, MAX_U64),
  fc.bigInt(T0 - 100_000n, T0 + 100_000n), fc.bigInt(0n, 20n), fc.bigInt(0n, MAX_U64),
);
const offset = fc.oneof(fc.constantFrom(0n, 1n), fc.bigInt(0n, 10n), fc.bigInt(0n, 100_000n), anywhere);
const bound = fc.record({ anchor: fc.constantFrom("ts0", "clock0", "ts1", "clock1", "anywhere"), shift: fc.constantFrom(-1n, 0n, 1n), value: anywhere });
const fullRange = fc.record({
  window: fc.oneof(fc.constantFrom(1n, 60n, 3600n, 86_400n, U32, 1n << 63n, MAX_U64), fc.bigInt(1n, MAX_U64)),
  ts0: anywhere, ahead0: offset, gap: offset, ahead1: offset, late: fc.boolean(), notBefore: bound, notAfter: bound,
  amounts: fc.tuple(anywhere, anywhere), cap: fc.record({ to: fc.constantFrom("anywhere", "first", "both", "both less one"), value: anywhere }),
  allowlist: fc.boolean(), second: fc.record({ kind: fc.constantFrom("payment", "egress"), assetOk: fc.boolean(), listed: fc.boolean() }),
});
type FullRange = typeof fullRange extends fc.Arbitrary<infer T> ? T : never;
const clamp = (value: bigint, low = 0n, high = MAX_U64) => (value < low ? low : value > high ? high : value);

function fullRangeHistory(s: FullRange, i: number): VerdictCase[] {
  const windowStart = (t: bigint) => t - (t % s.window);
  const windowEnd = (t: bigint) => clamp(windowStart(t) + s.window - 1n);
  const ts0 = s.ts0;
  const clock0 = clamp(ts0 + s.ahead0, ts0, windowEnd(ts0));
  const ts1 = clamp(ts0 + s.gap);
  const clock1 = clamp(s.late ? ts1 - 1n : ts1 + s.ahead1, clock0 > windowStart(ts1) ? clock0 : windowStart(ts1), windowEnd(ts1));
  const anchored = (b: FullRange["notBefore"]) => clamp({ ts0, clock0, ts1, clock1, anywhere: b.value }[b.anchor] + b.shift);
  let [notBefore, notAfter] = [anchored(s.notBefore), anchored(s.notAfter)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) as [bigint, bigint];
  if (notBefore === notAfter) [notBefore, notAfter] = notAfter === MAX_U64 ? [MAX_U64 - 1n, MAX_U64] : [notBefore, notBefore + 1n];
  const [amount0, amount1] = s.amounts.map(amount => clamp(amount, 1n)) as [bigint, bigint];
  const cap = clamp({ anywhere: s.cap.value, first: amount0, both: amount0 + amount1, "both less one": amount0 + amount1 - 1n }[s.cap.to]);
  const second = s.second.kind === "payment"
    ? payment(amount1, ts1, s.second.assetOk ? "lovelace" : "dust", s.second.listed ? "alice" : "mallory")
    : egress(s.second.listed ? "api.example.com" : "evil.example.com", ts1);
  return runPolicy("full range", `history ${i}`, policy({ cap, window: s.window, notBefore, notAfter, ...(s.allowlist ? { egress: ["api.example.com"] } : {}) }),
    [{ action: payment(amount0, ts0), clock: clock0 }, { action: second, clock: clock1 }]);
}

describe("T-A06 generated guard histories across the whole of uint64", () => {
  const generated = fc.sample(fullRange, { seed: 20261031, numRuns: FULL_RANGE_HISTORIES }).flatMap(fullRangeHistory);

  it(`circuit equals runtime on every step of ${FULL_RANGE_HISTORIES} generated two-step histories`, () => {
    expect(generated).toHaveLength(2 * FULL_RANGE_HISTORIES);
    for (const c of generated) expect(circuitOutcomes(pureCircuits, c), c.name).toEqual({ evaluate: c.evaluate, guard: c.guard });
  });

  it("reaches every verdict and the later-than-clock refusal, and every numeric slot on both sides of 2^32", () => {
    const outcomes = new Set(generated.map(c => (typeof c.guard === "number" ? String(c.guard) : c.guard.throws)));
    expect([...outcomes].sort()).toEqual([...VERDICT_CODES.map(String), "failed assert: action after guard clock"].sort());
    const slots: [string, (c: VerdictCase) => bigint][] = [
      ["enforced_at", c => c.enforcedAt],
      ...["not_before", "not_after", "cap_amount", "action_timestamp", "action_amount", "prior_spent"].map((name): [string, (c: VerdictCase) => bigint] => [name, c => at(c, name)]),
    ];
    const missing = slots.flatMap(([name, value]) => [
      ...(generated.some(c => value(c) >= U32) ? [] : [`${name} at or above 2^32`]),
      ...(generated.some(c => value(c) > 0n && value(c) < U32) ? [] : [`${name} between 1 and 2^32-1`]),
    ]);
    expect(missing).toEqual([]);
  });

  it.each(generated.filter((_, i) => i % ZKIR_SAMPLE_EVERY === 0).map(c => [c.name, c] as const))("ZKIR: %s checks exactly the runtime verdict", async (_name, c) => {
    for (const claimed of CLAIMS) {
      const disclosed = await zkCheck("predicate", "check_verdict", {}, checkVerdictArgs(c, claimed)).then(ledger => ledger.verdictOut, (error: Error) => {
        if (!/Failed direct assertion/.test(error.message)) throw error;
        return undefined;
      });
      expect(disclosed, `claim ${claimed}`).toBe(claimed === c.guard ? BigInt(claimed) : undefined);
    }
  });
});
