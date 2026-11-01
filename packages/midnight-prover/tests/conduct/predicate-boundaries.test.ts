import { compileMandatePredicate } from "@fluxpointstudios/orynq-sdk-conduct";
import { describe, expect, it } from "vitest";
import {
  allowlists, boundaryCases, circuitOutcomes, guardFor, invarianceCases, overCapPriorCases, payment, policy, slot, unicodeCases, type VerdictCase,
} from "./cases.js";
import { loadUnit } from "./harness.js";

const { pureCircuits } = await loadUnit("predicate");
const at = (c: VerdictCase, name: string) => c.args[slot(name)];
const agree = (c: VerdictCase) => expect(circuitOutcomes(pureCircuits, c), c.name).toEqual({ evaluate: c.evaluate, guard: c.guard });

describe("T-A07 uint64 edges and the widened cap sum", () => {
  const cases = boundaryCases();
  it("reaches both widened sums through the runtime guard", () => {
    const widened = cases.filter(c => c.name.startsWith("prior 2^64-1"));
    expect(widened.map(c => [c.prior, at(c, "action_amount"), c.guard])).toEqual([
      [0n, (1n << 64n) - 1n, 0], [(1n << 64n) - 1n, 1n, 4],
      [0n, (1n << 64n) - 1n, 0], [(1n << 64n) - 1n, (1n << 64n) - 1n, 4],
    ]);
  });
  it.each(cases.map(c => [c.name, c] as const))("%s", (_name, c) => agree(c));
});

describe("T-A08 asset and Unicode identifiers", () => {
  const cases = unicodeCases();
  it("deny on byte inequality, not on string normalization", () => {
    expect(cases.map(c => [c.name, c.guard])).toEqual([
      ["Lovelace against lovelace", 3],
      ["128-character ASCII mandate asset", 0],
      ["128-character asset with its last byte changed", 3],
      ["Cardano unit asset", 0],
      ["action asset é", 3],
      ["action asset emoji", 3],
      ["action asset U+2028", 3],
      ["NFD counterparty against an NFC member", 5],
      ["NFC counterparty against an NFC member", 0],
    ]);
  });
  it.each(cases.map(c => [c.name, c] as const))("%s", (_name, c) => agree(c));
  it("refuses a lone surrogate before it can reach the circuit", () => {
    const p = policy({});
    const lone = payment(1n, 1500n, "\uD800");
    expect(() => compileMandatePredicate(p.mandate, allowlists(p)).buildArgs(lone, 0n)).toThrow(/well-formed UTF-8/);
    expect(() => guardFor(p, () => 1500n).enforce(lone)).toThrow(/well-formed UTF-8/);
  });
});

describe("T-A09 egress ignores prior spend, counterparty membership, action asset and amount; deny-all and validity ignore egress membership; payment ignores egress membership", () => {
  const cases = invarianceCases();
  it("varies every slot the verdict must ignore", () => {
    const egressSlots = new Set(cases.filter(c => at(c, "action_kind") === 1n).flatMap(c => [...c.name.matchAll(/ (\w+)=/g)].map(m => m[1])));
    expect(egressSlots).toEqual(new Set(["prior_spent", "counterparty_ok", "action_asset", "action_amount", "egress_ok"]));
    expect(cases.some(c => at(c, "action_kind") === 1n && at(c, "egress_mode") === 0n && at(c, "egress_ok") === true)).toBe(true);
    expect(cases.some(c => at(c, "action_kind") === 1n && at(c, "action_asset") === at(c, "cap_asset") && at(c, "action_amount") === (1n << 64n) - 1n)).toBe(true);
  });
  it.each(cases.map(c => [c.name, c] as const))("%s", (_name, c) => agree(c));
});

describe("a prior spend above the cap, which the runtime never holds, is judged as a fresh payment of the same total", () => {
  const cases = overCapPriorCases();
  it("covers priors of cap+1, cap+amount and 2^63 under allowed, over-cap, asset-mismatch and off-list payments", () => {
    expect(cases.map(c => [at(c, "prior_spent"), c.guard])).toEqual([
      [11n, 4], [15n, 4], [1n << 63n, 4],
      [11n, 4], [21n, 4], [1n << 63n, 4],
      [11n, 3], [15n, 3], [1n << 63n, 3],
      [11n, 5], [15n, 5], [1n << 63n, 5],
    ]);
  });
  it.each(cases.map(c => [c.name, c] as const))("%s", (_name, c) => agree(c));
});
