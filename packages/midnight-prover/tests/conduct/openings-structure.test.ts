import { describe, expect, it } from "vitest";
import { OPENINGS_MUTANTS } from "./openings.js";
import { auditOpenings, auditOpeningsStructure, openingSources } from "./structure.js";

type OpeningFile = keyof ReturnType<typeof openingSources>;
type Edit = readonly [find: string, replace: string];

// The openings unit with each edit's `find`, which must occur, replaced at its first occurrence: in the generated
// openings, ev_pa_ascii_min is the first event class and m_base the first mandate class.
function edited(file: OpeningFile, ...edits: readonly Edit[]): string[] {
  const sources = openingSources();
  let text = sources[file];
  for (const [find, replace] of edits) {
    if (!text.includes(find)) throw new Error(`${file} does not hold ${find}`);
    text = text.replace(find, () => replace);
  }
  return auditOpenings({ ...sources, [file]: text });
}

const statementLine = (subject: string, line: number, found: string, audited: string) =>
  `${subject} differs from its audited statement list at line ${line}: found ${JSON.stringify(found)}, audited ${JSON.stringify(audited)}`;
const gadgetLine = (gadget: string, line: number, found: string, audited: string) => statementLine(`ConductGadgets.${gadget}`, line, found, audited);
const subject = (finding: string) => finding.slice(0, finding.indexOf(":"));

const AMOUNT = 'assert(decU64<1>(amount) == s.amount, "amount opening");';
const ROLL = '["poi-trace:roll:v1|", s.prevRollHex, "|", eventHex]';
const rolled = (version: string) => `persistentHash("poi-trace:roll:${version}|", s.prevRollHex: Bytes<64>, "|", eventHex: Vector<64, Uint<8>>)`;
const leaf = (type: string) => `persistentHash("orynq:conduct:allowlist:leaf:v1|d", counterparty: ${type})`;
const UNTYPED_LEAF = 'persistentHash(["orynq:conduct:allowlist:leaf:v1|d", counterparty])';
const atoms = (notBefore: string) =>
  `persistentHash(pad(32, "orynq:conduct:mandate-atoms:v1"): Bytes<32>, commitment: Bytes<32>, notBeforeValue: ${notBefore}, notAfterValue: Uint<64>, `
  + "persistentHash(asset: Vector<8, Uint<8>>): Bytes<32>, capAmountValue: Uint<64>, windowSecondsValue: Uint<64>, egressMode[0]: Uint<8>, "
  + "counterpartyRoot: Vector<32, Uint<8>>, egressRoot: Vector<32, Uint<8>>)";
const CBOR_FOLD = "fold((acc, b) => (acc * 256) + (b as Field), 0 as Field, body)";
const CBOR_FOLD_CAST = "fold((acc, b) => ((acc * 256) + b) as Field, 0 as Field, body)";
const UUID_TEST = "(((i == 8) || (i == 13)) || (i == 18)) || (i == 23)";

// AM-8: the audit parses gadgets.compact and openings.generated.compact to the last token, compares each gadget with
// its committed literals, comparisons, calls and statements, and each generated class and probe with the reference text
// that opening-reference.ts derives from classes.json, the producers and the audited value classes. An edit that adds a
// literal, a comparison, a call, a witness read, a ledger write, a statement or a declaration, or changes one, fails
// with an exact message.
describe("T-A16 (AM-8) the gadgets and every generated opening class hold exactly the audited structure", () => {
  it("the openings unit under test passes the audit, and its compiled contract implements exactly the audited circuits, probes and witnesses", () => {
    expect(auditOpeningsStructure("openings")).toEqual([]);
  });

  it.each([
    ["a leading zero waived for a decimal of three or more digits ending in 9", "mutants/decimal_leading_zero_waived_for_nines", [
      "ConductGadgets.decU64 literals differ from the audited list: added [1, 2, 57], removed []",
      "ConductGadgets.decU64 comparisons differ from the audited list: added [N > 2, ds[N - 1] == 57], removed []",
      gadgetLine("decU64", 5, 'assert (((N == 1) || (ds[0] != 48)) || ((N > 2) && (ds[N - 1] == 57))), "decimal leading zero"', 'assert ((N == 1) || (ds[0] != 48)), "decimal leading zero"'),
    ]],
    ["a CBOR uint of 1000 accepted in any width", "mutants/cbor_uint_minimal_waived_at_1000", [
      "ConductGadgets.cborUint literals differ from the audited list: added [1000], removed []",
      "ConductGadgets.cborUint comparisons differ from the audited list: added [value == 1000], removed []",
      gadgetLine("cborUint", 4,
        'assert ((value >= ((W == 1) ? 24 : ((W == 2) ? 256 : ((W == 4) ? 65536 : 4294967296)))) || (value == 1000)), "cbor uint not minimal"',
        'assert (value >= ((W == 1) ? 24 : ((W == 2) ? 256 : ((W == 4) ? 65536 : 4294967296)))), "cbor uint not minimal"'),
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
      statementLine("ev_pa_ascii_min", 18, 'assert ((decU64<1>(amount) == s.amount) || (s.amount == 1000)), "amount opening"', 'assert (decU64<1>(amount) == s.amount), "amount opening"'),
    ]],
    ["a string gadget call that never runs", "  jsonStr<4>(counterparty);\n", "  if (false) {\n    jsonStr<4>(counterparty);\n  }\n", [
      "ev_pa_ascii_min literals differ from the audited list: added [false], removed []",
      statementLine("ev_pa_ascii_min", 31, "if (false) jsonStr<4>(counterparty)", "jsonStr<4>(counterparty)"),
    ]],
    ["another rolling domain", ROLL, ROLL.replace("v1", "v2"), [
      `ev_pa_ascii_min comparisons differ from the audited list: added [${rolled("v2")} == s.rollAfter], removed [${rolled("v1")} == s.rollAfter]`,
      `ev_pa_ascii_min calls differ from the audited list: added [${rolled("v2")}], removed [${rolled("v1")}]`,
      statementLine("ev_pa_ascii_min", 17, `assert (${rolled("v2")} == s.rollAfter), "rolling root mismatch"`, `assert (${rolled("v1")} == s.rollAfter), "rolling root mismatch"`),
    ]],
    ["a party leaf hashed as 16-bit words, which compactc widens its bytes to", "persistentHash<[Bytes<33>, Vector<4, Uint<8>>]>", "persistentHash<[Bytes<33>, Vector<4, Uint<16>>]>", [
      `ev_pa_ascii_min comparisons differ from the audited list: added [${leaf("Vector<4, Uint<16>>")} == s.counterpartyLeaf], removed [${leaf("Vector<4, Uint<8>>")} == s.counterpartyLeaf]`,
      `ev_pa_ascii_min calls differ from the audited list: added [${leaf("Vector<4, Uint<16>>")}], removed [${leaf("Vector<4, Uint<8>>")}]`,
      statementLine("ev_pa_ascii_min", 21, `assert (${leaf("Vector<4, Uint<16>>")} == s.counterpartyLeaf), "counterpartyLeaf opening"`,
        `assert (${leaf("Vector<4, Uint<8>>")} == s.counterpartyLeaf), "counterpartyLeaf opening"`),
    ]],
    ["a party leaf whose hash lists no types", "persistentHash<[Bytes<33>, Vector<4, Uint<8>>]>(", "persistentHash(", [
      `ev_pa_ascii_min comparisons differ from the audited list: added [${UNTYPED_LEAF} == s.counterpartyLeaf], removed [${leaf("Vector<4, Uint<8>>")} == s.counterpartyLeaf]`,
      `ev_pa_ascii_min calls differ from the audited list: added [${UNTYPED_LEAF}], removed [${leaf("Vector<4, Uint<8>>")}]`,
      statementLine("ev_pa_ascii_min", 21, `assert (${UNTYPED_LEAF} == s.counterpartyLeaf), "counterpartyLeaf opening"`,
        `assert (${leaf("Vector<4, Uint<8>>")} == s.counterpartyLeaf), "counterpartyLeaf opening"`),
    ]],
    ["a mandate atom hashed as a field element", "persistentHash<[Bytes<32>, Bytes<32>, Uint<64>,", "persistentHash<[Bytes<32>, Bytes<32>, Field,", [
      `m_base comparisons differ from the audited list: added [${atoms("Field")} == s.atoms], removed [${atoms("Uint<64>")} == s.atoms]`,
      `m_base calls differ from the audited list: added [${atoms("Field")}], removed [${atoms("Uint<64>")}]`,
      statementLine("m_base", 25, `assert (${atoms("Field")} == s.atoms), "mandate atoms opening"`, `assert (${atoms("Uint<64>")} == s.atoms), "mandate atoms opening"`),
    ]],
    ["a payment class without its amount floor", '  assert(s.amount != 0, "decimal nonzero");\n', "", [
      "ev_pa_ascii_min literals differ from the audited list: added [], removed [0]",
      "ev_pa_ascii_min comparisons differ from the audited list: added [], removed [s.amount != 0]",
      statementLine("ev_pa_ascii_min", 19, 'assert (persistentHash(asset: Vector<3, Uint<8>>) == s.assetDigest), "assetDigest opening"', 'assert (s.amount != 0), "decimal nonzero"'),
    ]],
    ["a pure circuit that is not a probe", "export pure circuit cbor_uint_w0(", "export pure circuit dec_sneak(v: Vector<2, Uint<8>>): Uint<64> {\n  return decU64<2>(v) + 1;\n}\n\nexport pure circuit cbor_uint_w0(", [
      "openings.generated.compact declarations differ from the audited list: added [circuit dec_sneak], removed []",
    ]],
    ["a string probe retargeted to the other UTF-8 gadget", "return jsonStr<4>(v);", "return utf8Any<4>(v);", [
      "json_str_w4 calls differ from the audited list: added [utf8Any<4>(v)], removed [jsonStr<4>(v)]",
      statementLine("json_str_w4", 2, "return utf8Any<4>(v)", "return jsonStr<4>(v)"),
    ]],
    ["a dec53 probe read through decU64", "return dec53<1>(v);", "return decU64<1>(v);", [
      "dec53_w1 calls differ from the audited list: added [decU64<1>(v)], removed [dec53<1>(v)]",
      statementLine("dec53_w1", 2, "return decU64<1>(v)", "return dec53<1>(v)"),
    ]],
    ["a decimal probe read at another width", "return decU64<16>(v);", "return decU64<10>(v);", [
      "dec_u64_w16 literals differ from the audited list: added [10], removed [16]",
      "dec_u64_w16 calls differ from the audited list: added [decU64<10>(v)], removed [decU64<16>(v)]",
      statementLine("dec_u64_w16", 2, "return decU64<10>(v)", "return decU64<16>(v)"),
    ]],
    ["a witness and a circuit outside every class", "export pure circuit cbor_uint_w0(", "witness extra(): Vector<1, Uint<8>>;\nexport circuit sneak(s: PaymentOpening): [] {\n  paymentOpening = disclose(s);\n}\n\nexport pure circuit cbor_uint_w0(", [
      "openings.generated.compact declarations differ from the audited list: added [circuit sneak, witness extra(): Vector<1, Uint<8>>;], removed []",
    ]],
  ])("refuses %s in the generated openings with its exact message", (_label, find, replace, messages) => {
    expect(edited("openings.generated.compact", [find, replace])).toEqual(messages);
  });

  // compactc encodes a string literal as UTF-8, so "\u00ab" is the two bytes C2 AB: never one constant byte AB.
  it("refuses a non-ASCII escape in a mandate commitment's constant bytes, which compactc hashes as two UTF-8 bytes", () => {
    const findings = edited("openings.generated.compact",
      ["persistentHash<[Bytes<25>, Vector<4, Uint<8>>, Bytes<1>,", "persistentHash<[Bytes<25>, Bytes<2>, Vector<3, Uint<8>>, Bytes<1>,"],
      ['["orynq:conduct:mandate:v1|", [171, 0, 1, 1], "P",', '["orynq:conduct:mandate:v1|", "\\u00ab", [0, 1, 1], "P",']);
    expect(findings.map(subject)).toEqual(["m_base calls differ from the audited list", "m_base differs from its audited statement list at line 17"]);
    expect(findings[0]).toContain('added [persistentHash("orynq:conduct:mandate:v1|", "\\u00ab": Bytes<2>, "\\x00\\x01\\x01P", mandateId: Vector<16, Uint<8>>,');
    expect(findings[0]).toContain('removed [persistentHash("orynq:conduct:mandate:v1|\\xab\\x00\\x01\\x01P", mandateId: Vector<16, Uint<8>>,');
  });

  it.each<readonly [string, string, readonly Edit[], readonly string[]]>([
    ["an assert turned into a binding nothing reads", "asciiPrint", [['assert(c >= 33 && c <= 126, "printable ASCII");', "const printable = c >= 33 && c <= 126;"]], [
      gadgetLine("asciiPrint", 3, "const printable = (c >= 33) && (c <= 126)", 'assert ((c >= 33) && (c <= 126)), "printable ASCII"'),
    ]],
    ["arithmetic outside every call and comparison", "nib", [["return (c as Field) - 48 - (c >= 97 ? 39 : 0);", "return (c as Field) - 48 + (c >= 97 ? 39 : 0);"]], [
      gadgetLine("nib", 3, "return ((c as Field) - 48) + ((c >= 97) ? 39 : 0)", "return ((c as Field) - 48) - ((c >= 97) ? 39 : 0)"),
    ]],
    ["a returned tuple reordered", "hexHalves", [["slice<32>(h, 0)), fold((acc, c) => acc * 16 + nib(c), 0 as Field, slice<32>(h, 32))]", "slice<32>(h, 32)), fold((acc, c) => acc * 16 + nib(c), 0 as Field, slice<32>(h, 0))]"]], [
      gadgetLine("hexHalves", 2,
        "return [fold((acc, c) => (acc * 16) + nib(c), 0 as Field, slice<32>(h, 32)), fold((acc, c) => (acc * 16) + nib(c), 0 as Field, slice<32>(h, 0))]",
        "return [fold((acc, c) => (acc * 16) + nib(c), 0 as Field, slice<32>(h, 0)), fold((acc, c) => (acc * 16) + nib(c), 0 as Field, slice<32>(h, 32))]"),
    ]],
    ["a comparison moved from the width assert into the minimality assert", "cborUint", [
      ['assert(W == 1 || W == 2 || W == 4 || W == 8, "cbor uint width");', "const width = W == 1 || W == 2 || W == 4;"],
      ['4294967296))), "cbor uint not minimal");', '4294967296))) || W == 8, "cbor uint not minimal");'],
    ], [
      gadgetLine("cborUint", 2, "const width = ((W == 1) || (W == 2)) || (W == 4)", 'assert ((((W == 1) || (W == 2)) || (W == 4)) || (W == 8)), "cbor uint width"'),
    ]],
    ["a literal moved into a binding nothing reads, its place taken by an operand", "utf8Next", [[
      "const hi: Uint<8> = due != 0 ? 191 : (b == 237 ? 159 : (b == 244 ? 143 : 191));",
      "const keep = 143;\n    const hi: Uint<8> = due != 0 ? 191 : (b == 237 ? 159 : (b == 244 ? b : 191));",
    ]], [
      gadgetLine("utf8Next", 8, "const keep = 143", "const hi: Uint<8> = (due != 0) ? 191 : ((b == 237) ? 159 : ((b == 244) ? 143 : 191))"),
    ]],
    ["a conjunction turned into a disjunction", "jsonStr", [['assert(end[3] && end[0] == 0, "string outside', 'assert(end[3] || end[0] == 0, "string outside']], [
      gadgetLine("jsonStr", 3, 'assert (end[3] || (end[0] == 0)), "string outside escape-free well-formed UTF-8 class"', 'assert (end[3] && (end[0] == 0)), "string outside escape-free well-formed UTF-8 class"'),
    ]],
    ["a binding added inside a loop", "decU64", [['assert(c >= 48 && c <= 57, "decimal digit");', 'const copy = c;\n      assert(c >= 48 && c <= 57, "decimal digit");']], [
      gadgetLine("decU64", 3, "const copy = c", 'assert ((c >= 48) && (c <= 57)), "decimal digit"'),
    ]],
    ["a declared type added to a binding", "utf8Next", [["const lead2 =", "const lead2: Boolean ="]], [
      gadgetLine("utf8Next", 3, "const lead2: Boolean = (b >= 194) && (b <= 223)", "const lead2 = (b >= 194) && (b <= 223)"),
    ]],
  ])("refuses %s in a gadget, %s, with its exact message", (_label, _gadget, edits, messages) => {
    expect(edited("gadgets.compact", ...edits)).toEqual(messages);
  });

  // compactc binds `as` looser than + - * and tighter than the comparisons, and < <= > >= tighter than == and !=.
  it.each([
    ["`acc * 256 + b as Field` as a cast of the sum", "acc * 256 + (b as Field)", "acc * 256 + b as Field", [
      `ConductGadgets.cborUint calls differ from the audited list: added [${CBOR_FOLD_CAST}], removed [${CBOR_FOLD}]`,
      gadgetLine("cborUint", 3, `const value = ${CBOR_FOLD_CAST} as Uint<64>`, `const value = ${CBOR_FOLD} as Uint<64>`),
    ]],
    ["`v[i] == 45 < 46` as an equality with a comparison", "v[i] == 45 : isHex(v[i])", "v[i] == 45 < 46 : isHex(v[i])", [
      "ConductGadgets.uuid literals differ from the audited list: added [46], removed []",
      "ConductGadgets.uuid comparisons differ from the audited list: added [45 < 46, v[i] == (45 < 46)], removed [v[i] == 45]",
      gadgetLine("uuid", 3, `assert ((${UUID_TEST}) ? (v[i] == (45 < 46)) : isHex(v[i])), "uuid"`, `assert ((${UUID_TEST}) ? (v[i] == 45) : isHex(v[i])), "uuid"`),
    ]],
  ])("reads %s, as compactc does", (_label, find, replace, messages) => {
    expect(edited("gadgets.compact", [find, replace])).toEqual(messages);
  });

  it("refuses a carriage return in a gadget's line comment, after which compactc reads the rest of the line as code", () => {
    expect(edited("gadgets.compact", ["module ConductGadgets {", "module ConductGadgets { // note\r"])).toEqual([
      "gadgets.compact cannot be audited: character U+000D at offset 31 is outside printable ASCII",
    ]);
  });
});
