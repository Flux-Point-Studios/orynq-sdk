import { describe, expect, it } from "vitest";
import { OPENINGS_MUTANTS } from "./openings.js";
import { auditOpenings, auditOpeningsStructure, openingSources } from "./structure.js";

const AMOUNT = 'assert(decU64<1>(amount) == s.amount, "amount opening");';
const AMOUNT_LINE = `found ${JSON.stringify('assert ((decU64<1>(amount) == s.amount) || (s.amount == 1000)), "amount opening"')}, audited ${JSON.stringify('assert (decU64<1>(amount) == s.amount), "amount opening"')}`;
const ROLL = '["poi-trace:roll:v1|", s.prevRollHex, "|", eventHex]';
const rolled = (version: string) => `persistentHash("poi-trace:roll:${version}|", s.prevRollHex, "|", eventHex)`;

// The generated openings with `find`, which must occur, replaced at its first occurrence: in ev_pa_ascii_min, the first
// class in the file.
function edited(find: string, replace: string, file: "gadgets.compact" | "openings.generated.compact" = "openings.generated.compact") {
  const sources = openingSources();
  if (!sources[file].includes(find)) throw new Error(`${file} does not hold ${find}`);
  return auditOpenings({ ...sources, [file]: sources[file].replace(find, () => replace) });
}

// AM-8: the audit parses gadgets.compact and openings.generated.compact to the last token, compares each gadget with
// its committed literals, comparisons and calls, and each generated class with the reference text that
// opening-reference.ts derives from classes.json and the producers. An edit that adds a literal, a comparison, a call,
// a witness read, a ledger write, a statement or a declaration fails with an exact message.
describe("T-A16 (AM-8) the gadgets and every generated opening class hold exactly the audited structure", () => {
  it("the openings unit under test passes the audit, and its compiled contract implements exactly the audited circuits, probes and witnesses", () => {
    expect(auditOpeningsStructure("openings")).toEqual([]);
  });

  it.each([
    ["a leading zero waived for a decimal of three or more digits ending in 9", "mutants/decimal_leading_zero_waived_for_nines", [
      "ConductGadgets.decU64 literals differ from the audited list: added [1, 2, 57], removed []",
      "ConductGadgets.decU64 comparisons differ from the audited list: added [N > 2, ds[N - 1] == 57], removed []",
    ]],
    ["a CBOR uint of 1000 accepted in any width", "mutants/cbor_uint_minimal_waived_at_1000", [
      "ConductGadgets.cborUint literals differ from the audited list: added [1000], removed []",
      "ConductGadgets.cborUint comparisons differ from the audited list: added [value == 1000], removed []",
    ]],
  ])("refuses %s with its exact message", (_label, unit, messages) => {
    expect(auditOpeningsStructure(unit)).toEqual(messages);
  });

  // The reviewer bar: a mutant that passes this audit must be killed by the opening, forgery or gadget suites.
  it("every openings mutant in mutants.json fails the audit, besides its kill in openings-mutants.test.ts", () => {
    expect(OPENINGS_MUTANTS.filter(id => auditOpeningsStructure(`mutants/${id}`).length === 0)).toEqual([]);
  });

  it.each([
    ["a waiver of the amount opening at 1000", AMOUNT, 'assert(decU64<1>(amount) == s.amount || s.amount == 1000, "amount opening");', [
      "ev_pa_ascii_min literals differ from the audited list: added [1000], removed []",
      "ev_pa_ascii_min comparisons differ from the audited list: added [s.amount == 1000], removed []",
      `ev_pa_ascii_min differs from its audited statement list at line 18: ${AMOUNT_LINE}`,
    ]],
    ["a string gadget call that never runs", "  jsonStr<4>(counterparty);\n", "  if (false) {\n    jsonStr<4>(counterparty);\n  }\n", [
      "ev_pa_ascii_min literals differ from the audited list: added [false], removed []",
      'ev_pa_ascii_min differs from its audited statement list at line 31: found "if (false) jsonStr<4>(counterparty)", audited "jsonStr<4>(counterparty)"',
    ]],
    ["another rolling domain", ROLL, ROLL.replace("v1", "v2"), [
      `ev_pa_ascii_min comparisons differ from the audited list: added [${rolled("v2")} == s.rollAfter], removed [${rolled("v1")} == s.rollAfter]`,
      `ev_pa_ascii_min calls differ from the audited list: added [${rolled("v2")}], removed [${rolled("v1")}]`,
      `ev_pa_ascii_min differs from its audited statement list at line 17: found ${JSON.stringify(`assert (${rolled("v2")} == s.rollAfter), "rolling root mismatch"`)}, `
        + `audited ${JSON.stringify(`assert (${rolled("v1")} == s.rollAfter), "rolling root mismatch"`)}`,
    ]],
    ["a pure circuit that is not a probe", "export pure circuit cbor_uint_w0(", "export pure circuit dec_sneak(v: Vector<2, Uint<8>>): Uint<64> {\n  return decU64<2>(v) + 1;\n}\n\nexport pure circuit cbor_uint_w0(", [
      "the pure circuit dec_sneak does not return one gadget call on its own parameters",
    ]],
    ["a witness and a circuit outside every class", "export pure circuit cbor_uint_w0(", "witness extra(): Vector<1, Uint<8>>;\nexport circuit sneak(s: PaymentOpening): [] {\n  paymentOpening = disclose(s);\n}\n\nexport pure circuit cbor_uint_w0(", [
      "openings.generated.compact declarations differ from the audited list: added [circuit sneak, witness extra(): Vector<1, Uint<8>>;], removed []",
    ]],
  ])("refuses %s in the generated openings with its exact message", (_label, find, replace, messages) => {
    expect(edited(find, replace)).toEqual(messages);
  });

  it("refuses a carriage return in a gadget's line comment, after which compactc reads the rest of the line as code", () => {
    expect(edited("module ConductGadgets {", "module ConductGadgets { // note\r", "gadgets.compact")).toEqual([
      "gadgets.compact cannot be audited: character U+000D at offset 31 is outside printable ASCII",
    ]);
  });
});
