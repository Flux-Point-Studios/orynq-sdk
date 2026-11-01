import { describe, expect, it } from "vitest";
import { auditStructure, predicateSources } from "./structure.js";

// AM-6.1: the sources are already hash-pinned, which fails on any edit. This audit fails on an edit that adds, removes or
// re-pairs a literal or a comparison, changes a signature or a call, or moves a decision. What a passing edit can still
// do is re-wire the audited comparisons and Boolean inputs inside the audited conditions, and T-A17 covers that space.
describe("T-A16 the verdict sources hold exactly the audited literals, comparisons and decision lists", () => {
  it("the predicate unit under test passes the audit", () => {
    expect(auditStructure(predicateSources())).toEqual([]);
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
  ])("refuses %s with its exact message", (_label, unit, messages) => {
    expect(auditStructure(predicateSources(unit))).toEqual(messages);
  });
});
