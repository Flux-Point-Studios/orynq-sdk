import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { allCases, checkVerdictArgs as claim, CLAIMS, guardVectorCases, MAX_U64, predicateVectorCases, slot, VERDICT_CODES, type VerdictCase } from "./cases.js";
import { generatedSource, prepareCheck, runCircuit, stripAsserts, unitDir, zkCheck } from "./harness.js";

const GROUPS = ["predicate-vectors", "guard-vectors", "clock", "matrix", "boundary", "unicode", "range", "invariance", "prior", "spent", "domain"];
const cases = allCases();
const honest = cases.filter((c): c is VerdictCase & { guard: number } => typeof c.guard === "number");
const labelled = <T extends VerdictCase>(list: readonly T[]) => list.map(c => [`${c.group}: ${c.name}`, c] as const);
const forgeries = (c: VerdictCase & { guard: number }, claims: readonly number[] = CLAIMS) => claims.filter(code => code !== c.guard);
const UINT8 = Array.from({ length: 256 }, (_, value) => value);
const onePerCode = VERDICT_CODES.map(code => honest.find(c => c.guard === code)!);

describe("T-A12 every case set reaches the ZKIR layer, and the cases meet every slot at its edges", () => {
  it("runs every case set at the ZKIR layer", () => {
    expect([...new Set(cases.map(c => c.group))].sort()).toEqual([...GROUPS].sort());
  });

  // AM-4: a verdict rule or refusal gated on prior_spent, cap_amount or action_amount survives every case that holds
  // those slots at one value, so every expiry, the early clock and every refusal meet a prior spend above 0.
  it("AM-4: prior spend above 0 meets every clock and action-time expiry, the prior-sensitive early clock and every refusal", () => {
    const [notBefore, notAfter, cap, kind, ts, amount, prior] = ["not_before", "not_after", "cap_amount", "action_kind", "action_timestamp", "action_amount", "prior_spent"] as const;
    const at = (c: VerdictCase, name: string) => c.args[slot(name)] as bigint;
    const isPayment = (c: VerdictCase) => at(c, kind) === 0n;
    const spent = (c: VerdictCase) => at(c, prior) > 0n;
    const refusal = (c: VerdictCase) => typeof c.guard === "number" ? undefined : c.guard.throws.replace(/^failed assert: /, "");
    const clockExpiry = (c: VerdictCase) => c.guard === 2 && c.enforcedAt >= at(c, notAfter) && at(c, ts) < at(c, notAfter);
    const shapes: [string, (c: VerdictCase) => boolean][] = [];
    for (const [clock, position] of [["at", (c: VerdictCase) => c.enforcedAt === at(c, notAfter)], ["past", (c: VerdictCase) => c.enforcedAt > at(c, notAfter)]] as const) {
      for (const [action, payment, evaluate] of [["a payment", true, 0], ["a payment", true, 4], ["an egress", false, 0], ["an egress", false, 7]] as const) {
        shapes.push([`clock ${clock} notAfter decides ${action} the action time judges ${evaluate}`,
          c => spent(c) && clockExpiry(c) && position(c) && isPayment(c) === payment && c.evaluate === evaluate]);
      }
    }
    for (const payment of [true, false]) {
      shapes.push([`action-time expiry of a${payment ? " payment" : "n egress"}`,
        c => spent(c) && c.guard === 2 && c.evaluate === 2 && at(c, ts) >= at(c, notAfter) && isPayment(c) === payment]);
    }
    for (const verdict of [0, 4]) {
      shapes.push([`a clock ahead inside validity where the prior decides ${verdict}`,
        c => spent(c) && isPayment(c) && c.guard === verdict && at(c, notBefore) <= at(c, ts) && at(c, ts) < c.enforcedAt && c.enforcedAt < at(c, notAfter)]);
    }
    const refusals = ["validity window out of domain", "action kind out of domain", "egress mode out of domain", "payment amount out of domain", "action after guard clock"];
    for (const message of refusals) {
      const refused = (c: VerdictCase) => refusal(c) === message;
      shapes.push(
        [`${message} with a prior spend above 0`, c => refused(c) && spent(c)],
        [`${message} with a prior spend of 2^64-1`, c => refused(c) && at(c, prior) === MAX_U64],
        [`${message} under a cap of 0`, c => refused(c) && at(c, cap) === 0n],
        [`${message} under a cap of 2^64-1`, c => refused(c) && at(c, cap) === MAX_U64],
      );
      if (message === "payment amount out of domain") continue;
      shapes.push(
        [`${message} with an action amount of 1`, c => refused(c) && at(c, amount) === 1n],
        [`${message} with an action amount of 2^64-1`, c => refused(c) && at(c, amount) === MAX_U64],
      );
    }
    expect(shapes.filter(([, holds]) => !cases.some(holds)).map(([shape]) => shape)).toEqual([]);
  });

  // A verdict rule or refusal gated on one slot's size, or on a Boolean it should ignore, survives every case that holds
  // that slot on one side of the gate. So every outcome, at every action and clock position it reaches, meets each
  // numeric slot within 3 of both ends of uint64 and each Boolean slot the outcome leaves free at both values.
  it("every outcome at every position meets each numeric slot at both ends of uint64 and each free Boolean at both values", () => {
    const at = (c: VerdictCase, name: string) => c.args[slot(name)]!;
    const region = (c: VerdictCase, t: bigint) => t < (at(c, "not_before") as bigint) ? "before notBefore" : t < (at(c, "not_after") as bigint) ? "inside validity" : "at or past notAfter";
    const outcomeOf = (c: VerdictCase) => {
      const decision = typeof c.guard === "number" ? `verdict ${c.guard}` : c.guard.throws.replace(/^failed assert: /, "");
      const subject = at(c, "action_kind") === 0n ? "payment" : at(c, "action_kind") === 1n ? "egress" : "any kind";
      const clock = c.enforcedAt < (at(c, "not_after") as bigint) ? "before" : "at or past";
      return `${decision} for ${subject}, action ${region(c, at(c, "action_timestamp") as bigint)}, clock ${clock} notAfter`;
    };
    const [early, inside, expired, clockEarly, clockInside, lateExpired] = [
      "action before notBefore, clock before notAfter", "action inside validity, clock before notAfter",
      "action at or past notAfter, clock at or past notAfter", "action before notBefore, clock at or past notAfter",
      "action inside validity, clock at or past notAfter", "action at or past notAfter, clock before notAfter",
    ];
    const kinds = ["payment", "egress"];
    const expected = [
      ...kinds.flatMap(k => [`verdict 1 for ${k}, ${early}`, ...[expired, clockEarly, clockInside].map(p => `verdict 2 for ${k}, ${p}`)]),
      ...[3, 4, 5, 0].map(v => `verdict ${v} for payment, ${inside}`), ...[6, 7, 0].map(v => `verdict ${v} for egress, ${inside}`),
      ...kinds.flatMap(k => [early, inside, lateExpired, expired].map(p => `action after guard clock for ${k}, ${p}`)),
      ...[early, inside, expired, clockEarly, clockInside].flatMap(p => [
        `action kind out of domain for any kind, ${p}`, ...kinds.map(k => `egress mode out of domain for ${k}, ${p}`), `payment amount out of domain for payment, ${p}`,
      ]),
      // With notBefore at or after notAfter no action time is inside validity.
      ...kinds.flatMap(k => [early, clockEarly, expired].map(p => `validity window out of domain for ${k}, ${p}`)),
    ];
    const fixed: Record<string, readonly string[]> = {
      "verdict 3 for payment": ["asset_ok"], "verdict 5 for payment": ["asset_ok", "counterparty_ok"],
      "verdict 4 for payment": ["asset_ok", "counterparty_ok"], "verdict 0 for payment": ["asset_ok", "counterparty_ok"],
      "verdict 6 for egress": ["egress_mode"], "verdict 7 for egress": ["egress_mode", "egress_ok"], "verdict 0 for egress": ["egress_mode", "egress_ok"],
      "egress mode out of domain for payment": ["egress_mode"], "egress mode out of domain for egress": ["egress_mode"],
      "payment amount out of domain for payment": ["action_amount"],
    };
    const numeric: Record<string, (c: VerdictCase) => bigint> = {
      enforced_at: c => c.enforcedAt,
      ...Object.fromEntries(["not_before", "not_after", "cap_amount", "action_timestamp", "action_amount", "prior_spent"].map(name => [name, (c: VerdictCase) => at(c, name) as bigint])),
    };
    const flags: Record<string, (c: VerdictCase) => boolean> = {
      egress_mode: c => at(c, "egress_mode") === 1n, asset_ok: c => at(c, "action_asset") === at(c, "cap_asset"),
      counterparty_ok: c => at(c, "counterparty_ok") === true, egress_ok: c => at(c, "egress_ok") === true,
    };
    const missing: string[] = [];
    for (const name of expected) {
      const within = cases.filter(c => outcomeOf(c) === name);
      const free = (field: string) => !(fixed[name.split(", ")[0]!] ?? []).includes(field);
      if (within.length === 0) missing.push(`${name}: no case`);
      for (const [field, value] of Object.entries(numeric).filter(([field]) => free(field))) {
        if (!within.some(c => value(c) >= MAX_U64 - 3n)) missing.push(`${name}: ${field} within 3 of 2^64-1`);
        if (!within.some(c => value(c) <= 3n)) missing.push(`${name}: ${field} at most 3`);
      }
      for (const [field, holds] of Object.entries(flags).filter(([field]) => free(field))) {
        for (const value of [true, false]) if (!within.some(c => holds(c) === value)) missing.push(`${name}: ${field} ${value}`);
      }
    }
    expect(missing).toEqual([]);
  });

});

// vitest drops a custom message on `rejects`, so an accepted forgery is reported explicitly.
async function refusesForgery(run: Promise<unknown>, refusal: RegExp): Promise<void> {
  const error = await run.then(() => undefined, (reason: unknown) => reason as Error);
  if (error === undefined) expect.fail("forged verdict accepted");
  expect(error.message).toMatch(refusal);
}

describe("T-A13 a forged verdict fails the generated JS", () => {
  it.each(labelled(honest))("%s", async (_name, c) => {
    for (const claimed of forgeries(c)) {
      await refusesForgery(runCircuit("predicate", "check_verdict", {}, claim(c, claimed)), /verdict mismatch/);
    }
  });

  it.each(labelled(onePerCode))("%s: every other Uint<8> claim", async (_name, c) => {
    for (const claimed of forgeries(c, UINT8)) {
      await refusesForgery(runCircuit("predicate", "check_verdict", {}, claim(c, claimed)), /verdict mismatch/);
    }
  });
});

// Each honest case is T-A12's acceptance leg: check passes and discloses its verdict, in the same run that refuses every
// forged claim for it. predicate-refusals.test.ts holds T-A12's refusal leg.
describe("T-A12 and T-A13 the compiled constraints accept and disclose every honest verdict and refuse every forged one", () => {
  it("the strip transform removes every generated assertion, one per Compact assert", () => {
    const circuits = resolve(import.meta.dirname, "../../circuits/conduct");
    const compactAsserts = ["verdict_core.compact", "predicate.compact"]
      .reduce((count, file) => count + (readFileSync(join(circuits, file), "utf8").match(/\bassert\(/g) ?? []).length, 0);
    const { source, removed } = stripAsserts(generatedSource("predicate"));
    expect(source).not.toContain("__compactRuntime.assert(");
    expect(removed).toBe(compactAsserts);
  });

  it("the stripped copy names no source map", async () => {
    await prepareCheck("predicate", "check_verdict", {}, claim(honest[0]!, honest[0]!.guard));
    expect(readFileSync(join(unitDir("predicate"), "contract/index.stripped.js"), "utf8")).not.toContain("sourceMappingURL");
  });

  it.each(labelled(honest))("%s", async (_name, c) => {
    expect((await zkCheck("predicate", "check_verdict", {}, claim(c, c.guard))).verdictOut).toBe(BigInt(c.guard));
    for (const claimed of forgeries(c)) {
      await refusesForgery(zkCheck("predicate", "check_verdict", {}, claim(c, claimed)), /Failed direct assertion/);
    }
  });

  it.each(labelled(onePerCode))("%s: every other Uint<8> claim", async (_name, c) => {
    for (const claimed of forgeries(c, UINT8)) {
      await refusesForgery(zkCheck("predicate", "check_verdict", {}, claim(c, claimed)), /Failed direct assertion/);
    }
  });

  it.each(labelled([...predicateVectorCases(), ...guardVectorCases()] as (VerdictCase & { guard: number })[]))(
    "%s: the honest input under a forged claim's ledger write", async (_name, c) => {
      const prepared = await prepareCheck("predicate", "check_verdict", {}, claim(c, c.guard));
      const forged = await prepareCheck("predicate", "check_verdict", {}, claim(c, forgeries(c)[0]!));
      prepared.data.publicTranscript = forged.data.publicTranscript;
      await refusesForgery(prepared.check(), /Public transcript input mismatch/);
    });
});
