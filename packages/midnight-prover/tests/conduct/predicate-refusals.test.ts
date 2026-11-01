import { PREDICATE_LAYOUT } from "@fluxpointstudios/orynq-sdk-conduct";
import { CompactTypeField } from "@midnight-ntwrk/compact-runtime";
import { describe, expect, it } from "vitest";
import { allCases, checkVerdictArgs as claim, CLAIMS, UINT_BITS, type VerdictCase } from "./cases.js";
import { prepareCheck, zkCheck } from "./harness.js";

const cases = allCases();
const honest = cases.find((c): c is VerdictCase & { guard: number } => typeof c.guard === "number")!;
const refused = cases.filter(c => typeof c.guard !== "number");

describe("T-A12 the compiled check_verdict constraints refuse every claim for an input the circuits refuse", () => {
  it.each(refused.map(c => [`${c.group}: ${c.name}`, c] as const))("%s: no claimed verdict checks", async (_name, c) => {
    for (const claimed of CLAIMS) {
      await expect(zkCheck("predicate", "check_verdict", {}, claim(c, claimed))).rejects.toThrow(/Failed direct assertion/);
    }
  });
});

// check_verdict's public inputs: the guard clock, the 12 predicate slots and the claimed verdict.
const INPUTS = [{ name: "enforced_at", type: "uint64" }, ...PREDICATE_LAYOUT, { name: "claimed", type: "uint8" }];
const uintSlots = INPUTS.flatMap((input, slot) => (UINT_BITS[input.type] === undefined ? [] : [[input.name, slot, UINT_BITS[input.type]!] as const]));
const booleanSlots = INPUTS.flatMap((input, slot) => (input.type === "boolean" ? [[input.name, slot] as const] : []));

describe("U12: the compiled check_verdict range-checks every public Uint and Boolean slot", () => {
  // The ledger refuses an out-of-range value in an aligned slot before `check`, so the slot is re-aligned as a
  // Field to reach the IR's own range and Boolean constraints.
  const realign = async (slot: number, value: bigint) => {
    const prepared = await prepareCheck("predicate", "check_verdict", {}, claim(honest, honest.guard));
    const values = [...prepared.data.input.value];
    const alignment = [...prepared.data.input.alignment];
    values[slot] = CompactTypeField.toValue(value)[0]!;
    alignment[slot] = CompactTypeField.alignment()[0];
    prepared.data.input = { value: values, alignment };
    return prepared.check();
  };

  it("derives 10 Uint and 2 Boolean slots from the predicate layout", () => {
    expect([uintSlots.length, booleanSlots.length]).toEqual([10, 2]);
  });
  it.each(uintSlots)("public Uint slot %s (%i) holding 2^%i fails the IR range constraint", async (_name, slot, bits) => {
    await expect(realign(slot, 1n << BigInt(bits))).rejects.toThrow(new RegExp(`Bit bound failed: [0-9a-f]+ is not ${bits}-bit`));
  });
  it.each(booleanSlots)("public Boolean slot %s (%i) holding 2 fails the IR Boolean constraint", async (_name, slot) => {
    await expect(realign(slot, 2n)).rejects.toThrow(/Expected boolean/);
  });
  it.each([...uintSlots, ...booleanSlots].map(([name, slot]) => [name, slot] as const))("control: public slot %s (%i) re-aligned with its own value checks", async (_name, slot) => {
    await expect(realign(slot, BigInt(claim(honest, honest.guard)[slot] as bigint | boolean))).resolves.toBeDefined();
  });
});
