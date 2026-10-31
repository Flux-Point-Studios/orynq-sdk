import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { circuitOutcomes, egress, matrixCases, payment, policy, runPolicy, type Step } from "./cases.js";
import { loadUnit } from "./harness.js";

const { pureCircuits } = await loadUnit("predicate");

describe("T-A06 every feasible window, asset, counterparty, cap, mode and clock combination", () => {
  const cases = matrixCases();
  it("enumerates the 112 feasible combinations of 144", () => {
    expect(cases).toHaveLength(112);
    expect(new Set(cases.map(c => c.name)).size).toBe(112);
  });
  it.each(cases.map(c => [c.name, c] as const))("%s", (_name, c) => {
    expect(circuitOutcomes(pureCircuits, c), c.name).toEqual({ evaluate: c.evaluate, guard: c.guard });
  });
});

// Small values make window edges, cap edges and a clock ahead of the action or past notAfter common. Every generated
// step is one the guard accepts: action times never decrease, the clock never runs backward, never trails the action
// and stays in the action's spend window.
const scenario = fc.record({
  window: fc.bigInt(1n, 8n), notBefore: fc.bigInt(0n, 10n), span: fc.bigInt(1n, 6n), cap: fc.bigInt(0n, 12n), allowlist: fc.boolean(),
  first: fc.record({ amount: fc.bigInt(1n, 12n), ts: fc.bigInt(0n, 14n), ahead: fc.bigInt(0n, 7n) }),
  second: fc.record({
    kind: fc.constantFrom("payment", "egress"), amount: fc.bigInt(1n, 12n), assetOk: fc.boolean(), listed: fc.boolean(),
    later: fc.bigInt(0n, 9n), back: fc.bigInt(0n, 9n),
  }),
});

function steps(s: typeof scenario extends fc.Arbitrary<infer T> ? T : never): Step[] {
  const windowEnd = (t: bigint) => (t / s.window + 1n) * s.window - 1n;
  const ts0 = s.first.ts;
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
  it("circuit equals runtime on every step of 400 generated two-step histories", () => {
    fc.assert(fc.property(scenario, s => {
      const p = policy({ cap: s.cap, window: s.window, notBefore: s.notBefore, notAfter: s.notBefore + s.span, ...(s.allowlist ? { egress: ["api.example.com"] } : {}) });
      for (const c of runPolicy("generated", "history", p, steps(s))) {
        expect(circuitOutcomes(pureCircuits, c), c.name).toEqual({ evaluate: c.evaluate, guard: c.guard });
      }
    }), { seed: 20261031, numRuns: 400 });
  });
});
