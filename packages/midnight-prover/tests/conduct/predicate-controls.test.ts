import { assetTag } from "@fluxpointstudios/orynq-sdk-conduct";
import { describe, expect, it } from "vitest";
import { egress, fixturePolicy, guardVectorCases, MAX_U64, payment, runPolicy, withArg as set } from "./cases.js";
import { loadUnit } from "./harness.js";

// These controls show what the predicate cannot know at this layer: its inputs are not authenticated here.
const { pureCircuits } = await loadUnit("predicate");
const evaluate = (args: readonly unknown[]) => Number(pureCircuits.evaluate!(...args));
const pay = (amount: bigint, counterparty = "addr_test1_alpha_supplier") => payment(amount, 1_500_000n, "lovelace", counterparty);

describe("T-A11 negative controls: unbound booleans and prior spend", () => {
  it("NC1: a 6M payment after 5M spent is denied, and a false prior of 0 allows it", () => {
    const [, after] = runPolicy("controls", "6M after 5M", fixturePolicy(1n), [{ action: pay(5_000_000n) }, { action: pay(6_000_000n) }]);
    const [fresh] = runPolicy("controls", "6M fresh", fixturePolicy(1n), [{ action: pay(6_000_000n) }]);
    expect([after!.guard, evaluate(after!.args)]).toEqual([4, 4]);
    expect([fresh!.guard, evaluate(set(after!.args, 10, 0n))]).toEqual([0, 0]);
  });

  it("NC2: flipping counterparty_ok moves 5 to 0 or 4, and 0 to 5", () => {
    const [offList] = runPolicy("controls", "off-list", fixturePolicy(1n), [{ action: pay(5_000_000n, "addr_test1_mallory") }]);
    expect(evaluate(offList!.args)).toBe(5);
    expect(evaluate(set(offList!.args, 9, true))).toBe(0);
    expect(evaluate(set(set(offList!.args, 9, true), 10, 6_000_000n))).toBe(4);
    const [allowed] = runPolicy("controls", "allowed", fixturePolicy(1n), [{ action: pay(5_000_000n) }]);
    expect([evaluate(allowed!.args), evaluate(set(allowed!.args, 9, false))]).toEqual([0, 5]);
  });

  it("NC3: flipping egress_ok moves 7 to 0 and back", () => {
    const [offList] = runPolicy("controls", "egress off-list", fixturePolicy(1n), [{ action: egress("evil.example.com", 1_500_000n) }]);
    const [allowed] = runPolicy("controls", "egress allowed", fixturePolicy(1n), [{ action: egress("api.example.com", 1_500_000n) }]);
    expect([evaluate(offList!.args), evaluate(set(offList!.args, 11, true))]).toEqual([7, 0]);
    expect([evaluate(allowed!.args), evaluate(set(allowed!.args, 11, false))]).toEqual([0, 7]);
  });

  it("NC4: the tdust asset tag is not the lovelace tag", () => {
    const [allowed] = runPolicy("controls", "allowed", fixturePolicy(1n), [{ action: pay(5_000_000n) }]);
    expect(evaluate(set(allowed!.args, 7, assetTag("tdust")))).toBe(3);
  });

  it("NC5: the binding refuses 11 and 13 arguments", () => {
    const [allowed] = runPolicy("controls", "allowed", fixturePolicy(1n), [{ action: pay(5_000_000n) }]);
    expect(() => evaluate(allowed!.args.slice(0, 11))).toThrow(/expected 12 arguments/);
    expect(() => evaluate([...allowed!.args, false])).toThrow(/expected 12 arguments/);
  });

  const allowedPayments = guardVectorCases().filter(c => c.guard === 0 && c.args[5] === 0n);
  it.each(allowedPayments.map(c => [c.name, c] as const))("NC6 prior-spend ladder: %s", (_name, c) => {
    const [cap, amount] = [c.args[3], c.args[8]];
    const ladder = [cap - amount, cap - amount + 1n, 0n, MAX_U64].map(prior => evaluate(set(c.args, 10, prior)));
    expect(ladder).toEqual([0, 4, 0, 4]);
  });
});
