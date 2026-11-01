import { describe, expect, it } from "vitest";
import { CLASSES } from "../../scripts/conduct/template.mjs";
import { zkCheck } from "./harness.js";
import { fieldForgeries, HONEST_MANDATES, mandateOpeningOf, mandateOutcome, runMandateOpening, schemaBreaches, sibling, type MandateOpening } from "./mandates.js";
import { misjudged, OPENINGS_UNIT, settle, withByte, witnessFunctions } from "./openings.js";

const byClass = new Map(HONEST_MANDATES.map(([, cbor, id]) => [id!, mandateOpeningOf(cbor)] as const));
const siblings = new Map(HONEST_MANDATES.map(([, cbor, id]) => [id!, mandateOpeningOf(sibling(cbor))] as const));
const check = (o: Pick<MandateOpening, "circuit" | "witnesses" | "statement">) => zkCheck(OPENINGS_UNIT, o.circuit, witnessFunctions(o.witnesses), [o.statement]);

describe("T-B15 the mandate circuits refuse CBOR crafted past the codec", () => {
  it("has an honest opening of every compiled class", () => {
    expect([...byClass.keys()].sort()).toEqual(Object.keys(CLASSES.openings.mandates).sort());
  });

  it.each([...byClass])("%s: the honest mandate and its sibling check at ZKIR, and a moved byte of C or K is refused", async (id, o) => {
    for (const honest of [o, siblings.get(id)!]) {
      await expect(runMandateOpening(honest)).resolves.toEqual(honest.statement);
      await expect(check(honest)).resolves.toMatchObject({ mandateOpening: honest.statement });
    }
    const { commitment, atoms } = o.statement;
    for (const statement of [{ commitment: withByte(commitment, 31, commitment[31]! ^ 1), atoms }, { commitment, atoms: withByte(atoms, 0, atoms[0]! ^ 1) }]) {
      expect(await settle(check({ ...o, statement }))).toMatch(/Failed direct assertion/);
    }
  });

  // Adding a class changes this list, so the breaches its widths rule out are reviewed with it.
  it("crafts each schema rule's breach in every class, except where the class's uint widths cannot encode it", () => {
    expect([...byClass].flatMap(([id, o]) => schemaBreaches(o).unencodable.map(u => `${id}: ${u.label}`))).toEqual([
      "m_base: a window of 0",
      "m_field_maxima: notBefore not below notAfter", "m_field_maxima: a window of 0", "m_field_maxima: a threshold above the committee size",
      "m_one_second: a window of 0",
      "m_max: a window of 0", "m_max: a threshold of 0",
    ]);
  });

  it.each([...byClass])("%s: refuses each schema rule's breach at JS, deny-all with a non-zero byte at every root position", async (_id, o) => {
    const { forgeries } = schemaBreaches(o);
    expect(forgeries.filter(f => f.refusal === "failed assert: deny-all egress root")).toHaveLength(32);
    expect(await misjudged(forgeries, mandateOutcome), "invalid mandate opened").toEqual([]);
  });

  it.each([...byClass])("%s: refuses out-of-class bytes in every DID, the asset, the committee id and every uint field at JS", async (_id, o) => {
    const forgeries = fieldForgeries(o);
    expect(forgeries.length).toBeGreaterThanOrEqual(16 + 4 + 2 + 6);
    expect(await misjudged(forgeries, mandateOutcome), "invalid mandate opened").toEqual([]);
  });

  // At ZKIR, m_base and m_step, with deny-all breached at the first and the last root position.
  const interior = new Set(Array.from({ length: 30 }, (_, i) => `deny-all with root byte ${i + 1} non-zero`));
  const atZkir = ["m_base", "m_step"].flatMap(id => {
    const o = byClass.get(id)!;
    return [...schemaBreaches(o).forgeries.filter(f => !interior.has(f.label)), ...fieldForgeries(o)].map(f => [`${id}: ${f.label}`, f.opening] as const);
  });
  it.each(atZkir)("ZKIR refuses %s", async (_label, o) => {
    expect(await settle(check(o))).toMatch(/Failed direct assertion/);
  });
});
