import { compileMandatePredicate } from "@fluxpointstudios/orynq-sdk-conduct";
import { describe, expect, it } from "vitest";
import { allowlists, boundaryCases, circuitOutcomes, guardFor, invarianceCases, payment, policy, unicodeCases, type VerdictCase } from "./cases.js";
import { loadUnit } from "./harness.js";

const { pureCircuits } = await loadUnit("predicate");
const agree = (c: VerdictCase) => expect(circuitOutcomes(pureCircuits, c), c.name).toEqual({ evaluate: c.evaluate, guard: c.guard });

describe("T-A07 uint64 edges and the widened cap sum", () => {
  const cases = boundaryCases();
  it("reaches both widened sums through the runtime guard", () => {
    const widened = cases.filter(c => c.name.startsWith("prior 2^64-1"));
    expect(widened.map(c => [c.spent.guard, c.args[8], c.guard])).toEqual([
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

describe("T-A09 egress ignores prior spend and counterparty membership; payment ignores egress membership", () => {
  it.each(invarianceCases().map(c => [c.name, c] as const))("%s", (_name, c) => agree(c));
});
