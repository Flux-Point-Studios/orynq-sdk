import { compileMandatePredicate, PREDICATE_LAYOUT } from "@fluxpointstudios/orynq-sdk-conduct";
import { describe, expect, it } from "vitest";
import { allowlists, circuitOutcomes, domainCases, egress, fixturePolicy, guardFor, MAX_U64, payment, policy, runPolicy, slot, UINT_BITS, withArg } from "./cases.js";
import { loadUnit } from "./harness.js";

const { pureCircuits } = await loadUnit("predicate");

describe("T-A10 kind and mode outside {0, 1}, a zero payment and an empty validity window are refused, never interpreted", () => {
  it.each(domainCases().map(c => [c.name, c] as const))("%s", (_name, c) => {
    const message = (c.guard as { throws: string }).throws.replace(/^failed assert: /, "");
    expect(() => pureCircuits.evaluate!(...c.args)).toThrow(message);
    expect(() => pureCircuits.guard_verdict!(c.enforcedAt, ...c.args)).toThrow(message);
  });

  const [base] = runPolicy("domain", "payment", fixturePolicy(1n), [{ action: payment(5_000_000n, 1_500_000n, "lovelace", "addr_test1_alpha_supplier") }]);
  const uintSlots = PREDICATE_LAYOUT.flatMap((input, index) => (UINT_BITS[input.type] === undefined ? [] : [[input.name, index, UINT_BITS[input.type]!] as const]));
  it("derives the 8 Uint slots from the predicate layout", () => expect(uintSlots).toHaveLength(8));
  it.each(uintSlots)("binding check, not circuit evidence: Uint slot %s (%i) refuses 2^%i and -1", (_name, index, bits) => {
    for (const value of [1n << BigInt(bits), -1n]) {
      expect(() => pureCircuits.evaluate!(...withArg(base!.args, index, value))).toThrow(/type error/);
      expect(() => pureCircuits.guard_verdict!(base!.enforcedAt, ...withArg(base!.args, index, value))).toThrow(/type error/);
    }
  });

  it("AM-6.2: the runtime schema and both circuits refuse an empty validity window, notBefore at or after notAfter", () => {
    const [valid] = runPolicy("domain", "payment", policy({}), [{ action: payment(1n, 1500n) }]);
    for (const [notBefore, notAfter] of [[1500n, 1500n], [2000n, 1000n], [0n, 0n], [MAX_U64, MAX_U64], [MAX_U64, 0n]] as const) {
      const p = policy({ notBefore, notAfter });
      expect(() => guardFor(p, () => 1500n)).toThrow("validityWindow.notAfter must be > notBefore");
      expect(() => compileMandatePredicate(p.mandate, allowlists(p))).toThrow("validityWindow.notAfter must be > notBefore");
      const args = withArg(withArg(valid!.args, slot("not_before"), notBefore), slot("not_after"), notAfter);
      expect(() => pureCircuits.evaluate!(...args)).toThrow("validity window out of domain");
      expect(() => pureCircuits.guard_verdict!(valid!.enforcedAt, ...args)).toThrow("validity window out of domain");
    }
  });

  it("AM-2: the runtime schema and both circuits refuse a zero payment; an egress, whose amount slot is 0, evaluates", () => {
    const p = policy({ egress: ["api.example.com"] });
    const zero = payment(0n, 1500n);
    expect(() => compileMandatePredicate(p.mandate, allowlists(p)).buildArgs(zero, 0n)).toThrow("payment amount must be >= 1");
    expect(() => guardFor(p, () => 1500n).enforce(zero)).toThrow("payment amount must be >= 1");
    const [one] = runPolicy("domain", "payment of 1", p, [{ action: payment(1n, 1500n) }]);
    expect(() => pureCircuits.evaluate!(...withArg(one!.args, slot("action_amount"), 0n))).toThrow("payment amount out of domain");
    expect(() => pureCircuits.guard_verdict!(one!.enforcedAt, ...withArg(one!.args, slot("action_amount"), 0n))).toThrow("payment amount out of domain");
    const [out] = runPolicy("domain", "egress", p, [{ action: egress("api.example.com", 1500n) }]);
    expect(out!.args[slot("action_amount")]).toBe(0n);
    expect(circuitOutcomes(pureCircuits, out!)).toEqual({ evaluate: 0, guard: 0 });
  });
});
