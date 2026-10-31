import { compileMandatePredicate } from "@fluxpointstudios/orynq-sdk-conduct";
import { describe, expect, it } from "vitest";
import { allowlists, domainCases, fixturePolicy, guardFor, payment, policy, runPolicy, withArg } from "./cases.js";
import { loadUnit } from "./harness.js";

const { pureCircuits } = await loadUnit("predicate");

describe("T-A10 kind and mode outside {0, 1} are refused, never interpreted", () => {
  it.each(domainCases().map(c => [c.name, c] as const))("%s", (_name, c) => {
    const message = (c.guard as { throws: string }).throws.replace(/^failed assert: /, "");
    expect(() => pureCircuits.evaluate!(...c.args)).toThrow(message);
    expect(() => pureCircuits.guard_verdict!(c.enforcedAt, ...c.args)).toThrow(message);
  });

  const [base] = runPolicy("domain", "payment", fixturePolicy(1n), [{ action: payment(5_000_000n, 1_500_000n, "lovelace", "addr_test1_alpha_supplier") }]);
  const uintSlots = [[0, 64], [1, 64], [3, 64], [4, 8], [5, 8], [6, 64], [8, 64], [10, 64]] as const;
  it.each(uintSlots)("binding check, not circuit evidence: Uint slot %i refuses 2^%i and -1", (slot, bits) => {
    for (const value of [1n << BigInt(bits), -1n]) {
      expect(() => pureCircuits.evaluate!(...withArg(base!.args, slot, value))).toThrow(/type error/);
      expect(() => pureCircuits.guard_verdict!(base!.enforcedAt, ...withArg(base!.args, slot, value))).toThrow(/type error/);
    }
  });

  it("declared precondition: a zero payment is refused before the circuit, and the circuit has no amount floor", () => {
    const p = policy({});
    const zero = payment(0n, 1500n);
    expect(() => compileMandatePredicate(p.mandate, allowlists(p)).buildArgs(zero, 0n)).toThrow("payment amount must be >= 1");
    expect(() => guardFor(p, () => 1500n).enforce(zero)).toThrow("payment amount must be >= 1");
    const [one] = runPolicy("domain", "payment of 1", p, [{ action: payment(1n, 1500n) }]);
    expect(Number(pureCircuits.evaluate!(...withArg(one!.args, 8, 0n)))).toBe(0);
  });
});
