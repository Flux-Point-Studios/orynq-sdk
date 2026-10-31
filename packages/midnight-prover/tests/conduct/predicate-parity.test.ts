import { compileMandatePredicate, type GuardAction } from "@fluxpointstudios/orynq-sdk-conduct";
import { describe, expect, it } from "vitest";
import {
  allowlists, circuitOutcomes, clockCases, clockPayment, clockPolicy, decisionCode, guardFor, guardVectorCases, predicateVectorCases, type VerdictCase,
} from "./cases.js";
import { loadUnit } from "./harness.js";

const { pureCircuits } = await loadUnit("predicate");

describe("T-A03 predicate vectors: the slice-1 ABI drives the compiled evaluate", () => {
  const cases = predicateVectorCases();
  it("covers all 17 cases and 23 steps", () => {
    expect(new Set(cases.map(c => c.name.replace(/ #\d+$/, ""))).size).toBe(17);
    expect(cases).toHaveLength(23);
  });
  it.each(cases.map(c => [c.name, c] as const))("%s", (_name, c) => {
    expect(c.prior.toString()).toBe(c.fixture!.prior);
    expect(c.args.map(arg => typeof arg === "bigint" ? arg.toString() : arg)).toEqual(c.fixture!.args);
    expect(Number(pureCircuits.evaluate!(...c.args))).toBe(c.fixture!.verdict);
    expect(c.guard).toBe(c.fixture!.verdict);
  });
});

describe("T-A04 guard vectors: circuit, runtime guard and fixture agree step by step", () => {
  const cases = guardVectorCases();
  it("covers all 24 sequences and 31 steps, and every verdict code", () => {
    expect(new Set(cases.map(c => c.name.replace(/ #\d+$/, ""))).size).toBe(24);
    expect(cases).toHaveLength(31);
    const counts = new Map<number, number>();
    for (const c of cases) counts.set(c.fixture!.verdict, (counts.get(c.fixture!.verdict) ?? 0) + 1);
    expect(Object.fromEntries([...counts].sort(([a], [b]) => a - b))).toEqual({ 0: 13, 1: 3, 2: 3, 3: 2, 4: 5, 5: 2, 6: 1, 7: 2 });
  });
  it.each(cases.map(c => [c.name, c] as const))("%s", (_name, c) => {
    expect(c.guard).toBe(c.fixture!.verdict);
    expect(c.evaluate).toBe(c.fixture!.verdict);
    expect(circuitOutcomes(pureCircuits, c)).toEqual({ evaluate: c.fixture!.verdict, guard: c.fixture!.verdict });
  });
});

describe("T-A05 the guard clock: guard_verdict follows the runtime, the 12-argument evaluate does not", () => {
  const cases = Object.fromEntries(clockCases().map(c => [c.name, c]));
  const clocked = (name: string) => {
    const c = cases[name]!;
    return Number(pureCircuits.guard_verdict!(c.enforcedAt, ...c.args));
  };
  it("F2: a clock past notAfter expires a back-dated action; evaluate returns 0 there (the pinned divergence)", () => {
    const c = cases["F2: notAfter 7201, clock 7202, action 7200"]!;
    expect([c.guard, clocked(c.name)]).toEqual([2, 2]);
    expect([c.evaluate, Number(pureCircuits.evaluate!(...c.args))]).toEqual([0, 0]);
  });
  it("a clock exactly at notAfter expires", () => {
    expect([cases["clock exactly at notAfter"]!.guard, clocked("clock exactly at notAfter")]).toEqual([2, 2]);
  });
  it("the clock rule outranks MANDATE_NOT_YET_VALID", () => {
    const name = "action before notBefore, clock at notAfter, one window";
    expect([cases[name]!.evaluate, cases[name]!.guard, clocked(name)]).toEqual([1, 2, 2]);
  });
  it("a clock one second before notAfter allows", () => {
    expect([cases["clock one second before notAfter"]!.guard, clocked("clock one second before notAfter")]).toEqual([0, 0]);
  });
  it("a clock ahead of the action but inside validity judges the action time, not the clock", () => {
    const early = "action before notBefore, clock ahead at notBefore";
    expect([cases[early]!.evaluate, cases[early]!.guard, clocked(early)]).toEqual([1, 1, 1]);
    const inside = "action in validity, clock ahead and still in validity";
    expect([cases[inside]!.evaluate, cases[inside]!.guard, clocked(inside)]).toEqual([0, 0, 0]);
  });
  const later = clockCases().filter(c => c.args[6] > c.enforcedAt);
  const position = (c: VerdictCase) =>
    c.enforcedAt < c.args[0] ? "before notBefore" : c.enforcedAt < c.args[1] ? "inside validity" : c.enforcedAt === c.args[1] ? "at notAfter" : "past notAfter";
  it("tries a payment and a listed and an unlisted egress one second after the clock, at four clock positions", () => {
    expect(later.every(c => c.args[6] === c.enforcedAt + 1n)).toBe(true);
    const kinds = ["payment", "listed egress", "unlisted egress"];
    const kind = (c: VerdictCase) => c.args[5] === 0n ? kinds[0] : c.args[11] ? kinds[1] : kinds[2];
    expect(later.map(c => `${kind(c)} ${position(c)}`).sort())
      .toEqual(kinds.flatMap(k => ["before notBefore", "inside validity", "at notAfter", "past notAfter"].map(p => `${k} ${p}`)).sort());
  });
  it.each(later.map(c => [c.name, c] as const))("%s: refused by the runtime and by guard_verdict", (_name, c) => {
    expect(c.guard).toEqual({ throws: "failed assert: action after guard clock" });
    expect(() => pureCircuits.guard_verdict!(c.enforcedAt, ...c.args)).toThrow("action after guard clock");
    expect(Number(pureCircuits.evaluate!(...c.args))).toBe(c.evaluate);
  });
});

// Runtime refusals with no predicate input, outside the plan's two declared divergences and awaiting a ruling: these
// tests pin that guard_verdict returns a verdict where the runtime refuses.
describe("pending ruling: runtime refusals guard_verdict has no input for", () => {
  const p = clockPolicy(0n, 100_000n);
  const args = (action: GuardAction, prior: bigint) => compileMandatePredicate(p.mandate, allowlists(p)).buildArgs(action, prior);

  it("a guard clock in another spend window from the action", () => {
    const action = clockPayment(3599n);
    expect(() => guardFor(p, () => 3600n).enforce(action)).toThrow("action timestamp must be in the guard clock's current window");
    expect(Number(pureCircuits.guard_verdict!(3600n, ...args(action, 0n)))).toBe(0);
  });

  it("a guard clock that runs backward", () => {
    let now = 7300n;
    const guard = guardFor(p, () => now);
    expect(decisionCode(guard.enforce(clockPayment(7300n)))).toBe(0);
    now = 7299n;
    const action = clockPayment(7299n);
    expect(() => guard.enforce(action)).toThrow("guard clock must be a monotonic uint64 Unix timestamp");
    expect(Number(pureCircuits.guard_verdict!(7299n, ...args(action, guard.spentInWindow(7299n))))).toBe(4);
  });

  it("an action time that moves backward", () => {
    const guard = guardFor(p, () => 7300n);
    expect(decisionCode(guard.enforce(clockPayment(7300n)))).toBe(0);
    const action = clockPayment(7200n);
    expect(() => guard.enforce(action)).toThrow("action timestamp must not move backward");
    expect(Number(pureCircuits.guard_verdict!(7300n, ...args(action, guard.spentInWindow(7200n))))).toBe(4);
  });
});
