import { describe, expect, it } from "vitest";
import { auditSources, auditStructure, compiledFindings, predicateSources } from "./structure.js";

const GUARD_CALL = "guard_verdict(enforced_at, not_before, not_after, cap_asset, cap_amount, egress_mode, action_kind, action_timestamp, action_asset, action_amount, counterparty_ok, prior_spent, egress_ok)";
const HIDDEN_WAIVER = [
  'predicate.compact differs from its audited outline at line 4: found "export ledger verdictOut: Uint<8>;", audited "import ConductVerdict prefix CV_;"',
  "numeric literals differ from the audited list: added [0, 0, 4, 4, 2199023255552, 2199023255552, 2199024304128, 2199024304128], removed []",
  "comparisons differ from the audited list: added [action_amount < 2199024304128, action_amount < 2199024304128, action_amount > 2199023255552, action_amount > 2199023255552, v == 4, v == 4], removed []",
  "compiled contract methods differ from the audited list: added [decide, equal, equal, evaluate], removed []",
];
const claimCheck = (found: string) =>
  `check_verdict differs from its audited decision list at line 2: found ${JSON.stringify(`assert (${found}), "verdict mismatch"`)}, audited ${JSON.stringify(`assert (${GUARD_CALL} == claimed), "verdict mismatch"`)}`;

// AM-6.1: the sources are already hash-pinned, which fails on any edit. This audit fails on an edit that adds, removes or
// re-pairs a literal or a comparison, adds or moves a declaration, changes a signature or a call, moves a decision, or
// changes check_verdict's condition. The parse must read every token of a source in printable ASCII and newlines, and
// the compiled contract must implement exactly the audited circuits. What a passing edit can still do is re-wire the audited comparisons and Boolean inputs inside
// ConductVerdict's conditions, and T-A17 covers that space.
describe("T-A16 the verdict sources hold exactly the audited declarations, literals, comparisons and decision lists", () => {
  it("the predicate unit under test passes the audit", () => {
    expect(auditStructure("predicate")).toEqual([]);
  });

  it.each([
    ["a 2^32 band on the cap rule", "mutants/cap_rule_skipped_in_amount_band", [
      "numeric literals differ from the audited list: added [4294967296, 9007199254740992], removed []",
      "comparisons differ from the audited list: added [action_amount <= 4294967296, action_amount >= 9007199254740992], removed []",
    ]],
    ["the action time compared with the cap", "mutants/kind_domain_assert_waived_past_cap", [
      "comparisons differ from the audited list: added [action_timestamp > cap_amount], removed []",
    ]],
    ["a reordered decision list", "mutants/swap_counterparty_cap", [
      'ConductVerdict.evaluate differs from its audited decision list at line 10: found "if (...) return 4", audited "if (...) return 5"',
    ]],
    ["a waiver module rebound to CV_ behind a constructor", "mutants/hidden_waiver", HIDDEN_WAIVER],
    ["a waiver module rebound to CV_ behind a struct", "mutants/hidden_waiver_behind_struct", HIDDEN_WAIVER],
    ["a waiver module rebound to CV_ in line comments that compactc ends at a carriage return", "mutants/hidden_waiver_behind_carriage_return", [
      "predicate.compact cannot be audited: character U+000D at offset 94 is outside printable ASCII", HIDDEN_WAIVER.at(-1),
    ]],
    ["check_verdict accepting any claim off both lists", "mutants/check_verdict_waived_off_list", [
      claimCheck(`(${GUARD_CALL} == claimed) || (!counterparty_ok && !egress_ok)`),
    ]],
    ["check_verdict refusing every claim off both lists", "mutants/check_verdict_refuses_off_list", [
      claimCheck(`(${GUARD_CALL} == claimed) && (counterparty_ok || egress_ok)`),
    ]],
  ])("refuses %s with its exact message", (_label, unit, messages) => {
    expect(auditStructure(unit)).toEqual(messages);
  });

  it("the compiled contract alone refuses a waiver module, whatever the source audit reads", () => {
    expect(compiledFindings("predicate")).toEqual([]);
    expect(compiledFindings("mutants/hidden_waiver")).toEqual([HIDDEN_WAIVER.at(-1)]);
  });

  it("refuses a cap rule waived in a second module behind a struct, rebound to CV_ from the other file", () => {
    const { "verdict_core.compact": core, "predicate.compact": predicate } = predicateSources();
    const second = core.replace("module ConductVerdict {", "module ConductVerdict2 {")
      .replace("prior_spent + action_amount > cap_amount", "prior_spent + action_amount > cap_amount && action_amount != 123456789");
    expect(auditSources({
      "verdict_core.compact": `${core}\nstruct Pad { x: Boolean; }\n${second}`,
      "predicate.compact": predicate.replace("import ConductVerdict prefix CV_;", "import ConductVerdict2 prefix CV_;"),
    })).toEqual([
      'verdict_core.compact differs from its audited outline at line 6: found "struct Pad { x: Boolean; }", audited "the end"',
      'predicate.compact differs from its audited outline at line 4: found "import ConductVerdict2 prefix CV_;", audited "import ConductVerdict prefix CV_;"',
      "numeric literals differ from the audited list: added [0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 3, 4, 5, 6, 7, 123456789], removed []",
      "comparisons differ from the audited list: added [action_amount != 123456789, action_amount >= 1, action_kind <= 1, action_kind == 0, action_kind == 1, "
        + "action_timestamp < not_before, action_timestamp <= enforced_at, action_timestamp >= not_after, egress_mode <= 1, egress_mode == 0, "
        + "enforced_at >= not_after, not_before < not_after, prior_spent + action_amount > cap_amount], removed []",
    ]);
  });

  // compactc ends a line comment at each of these as well as at a newline, so it reads the rest of the line as code.
  it.each([["a carriage return", "\r", "000D"], ["a next-line character", "\u0085", "0085"], ["a line separator", "\u2028", "2028"]])(
    "refuses %s, after which compactc reads a line comment's text as code", (_label, separator, code) => {
      const sources = predicateSources();
      const predicate = `${sources["predicate.compact"]}// note${separator}export ledger hidden: Uint<8>;\n`;
      expect(auditSources({ ...sources, "predicate.compact": predicate })).toEqual([
        `predicate.compact cannot be audited: character U+${code} at offset ${sources["predicate.compact"].length + "// note".length} is outside printable ASCII`,
      ]);
    });
  it.each([
    ["a constructor", "\nconstructor() { verdictOut = 0; }\n", ['predicate.compact differs from its audited outline at line 9: found "constructor() { verdictOut = 0; }", audited "the end"']],
    ["a closing brace outside any module", "}\n", ['predicate.compact cannot be audited: unexpected "}" outside any module']],
    ["an unterminated declaration", "\nexport ledger extra: Uint<8>\n", ["predicate.compact cannot be audited: unexpected end of the Compact source"]],
  ])("refuses %s after the circuits", (_label, appended, messages) => {
    const sources = predicateSources();
    expect(auditSources({ ...sources, "predicate.compact": `${sources["predicate.compact"]}${appended}` })).toEqual(messages);
  });
});
