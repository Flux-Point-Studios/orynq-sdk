import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CompactTypeField } from "@midnight-ntwrk/compact-runtime";
import { describe, expect, it } from "vitest";
import { allCases, guardVectorCases, predicateVectorCases, type VerdictCase } from "./cases.js";
import { generatedSource, prepareCheck, runCircuit, stripAsserts, zkCheck } from "./harness.js";

const CODES = [0, 1, 2, 3, 4, 5, 6, 7];
const GROUPS = ["predicate-vectors", "guard-vectors", "clock", "matrix", "boundary", "unicode", "invariance", "domain"];
const cases = allCases();
const honest = cases.filter((c): c is VerdictCase & { guard: number } => typeof c.guard === "number");
const refused = cases.filter(c => typeof c.guard !== "number");
const labelled = <T extends VerdictCase>(list: readonly T[]) => list.map(c => [`${c.group}: ${c.name}`, c] as const);
const claim = (c: VerdictCase, claimed: number) => [c.enforcedAt, ...c.args, BigInt(claimed)];
const forgeries = (c: VerdictCase & { guard: number }) => CODES.filter(code => code !== c.guard);

describe("T-A12 the compiled check_verdict constraints accept every honest verdict and disclose it", () => {
  it("runs every case set at the ZKIR layer", () => {
    expect([...new Set(cases.map(c => c.group))].sort()).toEqual([...GROUPS].sort());
  });

  it.each(labelled(honest))("%s", async (_name, c) => {
    const disclosed = await zkCheck("predicate", "check_verdict", {}, claim(c, c.guard));
    expect(disclosed.verdictOut).toBe(BigInt(c.guard));
  });

  it.each(labelled(refused))("%s: no claimed verdict checks", async (_name, c) => {
    for (const claimed of CODES) {
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

  it.each(labelled([...predicateVectorCases(), ...guardVectorCases()] as (VerdictCase & { guard: number })[]))(
    "%s: the honest input under a forged claim's ledger write", async (_name, c) => {
      const prepared = await prepareCheck("predicate", "check_verdict", {}, claim(c, c.guard));
      const forged = await prepareCheck("predicate", "check_verdict", {}, claim(c, (c.guard + 1) % CODES.length));
      prepared.data.publicTranscript = forged.data.publicTranscript;
      await refusesForgery(prepared.check(), /Public transcript input mismatch/);
    });
});
