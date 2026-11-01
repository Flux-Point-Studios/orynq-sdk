import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CompactTypeField } from "@midnight-ntwrk/compact-runtime";
import { describe, expect, it } from "vitest";
import { allCases, checkVerdictArgs as claim, CLAIMS, guardVectorCases, MAX_U64, predicateVectorCases, VERDICT_CODES, type VerdictCase } from "./cases.js";
import { generatedSource, prepareCheck, runCircuit, stripAsserts, zkCheck } from "./harness.js";

const GROUPS = ["predicate-vectors", "guard-vectors", "clock", "matrix", "boundary", "unicode", "invariance", "prior", "spent", "domain"];
const cases = allCases();
const honest = cases.filter((c): c is VerdictCase & { guard: number } => typeof c.guard === "number");
const refused = cases.filter(c => typeof c.guard !== "number");
const labelled = <T extends VerdictCase>(list: readonly T[]) => list.map(c => [`${c.group}: ${c.name}`, c] as const);
const forgeries = (c: VerdictCase & { guard: number }, claims: readonly number[] = CLAIMS) => claims.filter(code => code !== c.guard);
const UINT8 = Array.from({ length: 256 }, (_, value) => value);
const onePerCode = VERDICT_CODES.map(code => honest.find(c => c.guard === code)!);

describe("T-A12 the compiled check_verdict constraints accept every honest verdict and disclose it", () => {
  it("runs every case set at the ZKIR layer", () => {
    expect([...new Set(cases.map(c => c.group))].sort()).toEqual([...GROUPS].sort());
  });

  // AM-4: a verdict rule or refusal gated on prior_spent, cap_amount or action_amount survives every case that holds
  // those slots at one value, so every expiry, the early clock and every refusal meet a prior spend above 0.
  it("AM-4: prior spend above 0 meets every clock and action-time expiry, the prior-sensitive early clock and every refusal", () => {
    const [notBefore, notAfter, cap, kind, ts, amount, prior] = [0, 1, 3, 5, 6, 8, 10];
    const at = (c: VerdictCase, slot: number) => c.args[slot] as bigint;
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
    const refusals = ["action kind out of domain", "egress mode out of domain", "payment amount out of domain", "action after guard clock"];
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

  it.each(labelled(honest))("%s", async (_name, c) => {
    const disclosed = await zkCheck("predicate", "check_verdict", {}, claim(c, c.guard));
    expect(disclosed.verdictOut).toBe(BigInt(c.guard));
  });

  it.each(labelled(refused))("%s: no claimed verdict checks", async (_name, c) => {
    for (const claimed of CLAIMS) {
      await expect(zkCheck("predicate", "check_verdict", {}, claim(c, claimed))).rejects.toThrow(/Failed direct assertion/);
    }
  });

  // The ledger refuses an out-of-range value in an aligned slot before `check`, so the slot is re-aligned as a
  // Field to reach the IR's own range and Boolean constraints.
  const realign = async (slot: number, value: bigint) => {
    const prepared = await prepareCheck("predicate", "check_verdict", {}, claim(honest[0]!, honest[0]!.guard));
    const values = [...prepared.data.input.value];
    const alignment = [...prepared.data.input.alignment];
    values[slot] = CompactTypeField.toValue(value)[0]!;
    alignment[slot] = CompactTypeField.alignment()[0];
    prepared.data.input = { value: values, alignment };
    return prepared.check();
  };
  const honestSlot = (slot: number) => BigInt(claim(honest[0]!, honest[0]!.guard)[slot] as bigint | boolean);
  const uintSlots = [[0, 64], [1, 64], [2, 64], [4, 64], [5, 8], [6, 8], [7, 64], [9, 64], [11, 64], [13, 8]] as const;
  it.each(uintSlots)("U12: public Uint slot %i holding 2^%i fails the IR range constraint", async (slot, bits) => {
    await expect(realign(slot, 1n << BigInt(bits))).rejects.toThrow(new RegExp(`Bit bound failed: [0-9a-f]+ is not ${bits}-bit`));
  });
  const booleanSlots = [10, 12] as const;
  it.each(booleanSlots)("public Boolean slot %i holding 2 fails the IR Boolean constraint", async slot => {
    await expect(realign(slot, 2n)).rejects.toThrow(/Expected boolean/);
  });
  it.each([...uintSlots.map(([slot]) => slot), ...booleanSlots])("control: public slot %i re-aligned with its own value checks", async slot => {
    await expect(realign(slot, honestSlot(slot))).resolves.toBeDefined();
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

describe("T-A13 a forged verdict fails the compiled constraints", () => {
  it("the strip transform removes every generated assertion, one per Compact assert", () => {
    const circuits = resolve(import.meta.dirname, "../../circuits/conduct");
    const compactAsserts = ["verdict_core.compact", "predicate.compact"]
      .reduce((count, file) => count + (readFileSync(join(circuits, file), "utf8").match(/\bassert\(/g) ?? []).length, 0);
    const { source, removed } = stripAsserts(generatedSource("predicate"));
    expect(source).not.toContain("__compactRuntime.assert(");
    expect(removed).toBe(compactAsserts);
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
