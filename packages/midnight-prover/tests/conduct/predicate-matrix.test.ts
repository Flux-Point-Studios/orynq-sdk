import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { circuitOutcomes, egress, matrixCases, payment, policy, runPolicy, type Step, type VerdictCase } from "./cases.js";
import { loadUnit } from "./harness.js";

const { pureCircuits } = await loadUnit("predicate");
const HISTORIES = 1000;
const MIN_GENERATED_SHAPE = 10;

describe("T-A06 every window, asset, counterparty, cap, mode and clock combination", () => {
  const cases = matrixCases();
  it("enumerates all 144 combinations, and the runtime refuses exactly the 32 late actions behind a clock inside validity", () => {
    expect(cases).toHaveLength(144);
    expect(new Set(cases.map(c => c.name)).size).toBe(144);
    const refused = cases.filter(c => typeof c.guard !== "number");
    expect(refused).toHaveLength(32);
    expect(refused.every(c => c.args[6] > c.enforcedAt && c.enforcedAt < c.args[1])).toBe(true);
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
      ["a clock at or past notAfter after an earlier action", c => c.guard === 2 && c.enforcedAt >= c.args[1] && c.args[6] < c.args[1]],
      ["an action at or past notAfter", c => c.guard === 2 && c.args[6] >= c.args[1]],
      ["a payment over the cap", c => c.guard === 4],
      ["an allowed payment", c => c.guard === 0 && c.args[5] === 0n],
    ];
    const counts = shapes.map(([shape, holds]) => `${shape}: ${spent.filter(holds).length}`);
    expect(counts.filter(count => Number(count.split(": ")[1]) < MIN_GENERATED_SHAPE), counts.join("; ")).toEqual([]);
  });
});
