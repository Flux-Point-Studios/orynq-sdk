import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assetTag } from "@fluxpointstudios/orynq-sdk-conduct";
import { describe, expect, it } from "vitest";
import { allCases, checkVerdictArgs, circuitOutcomes, CLAIMS, MAX_U64, slot, type VerdictCase } from "./cases.js";
import { loadUnit, outcome, unitDir, zkCheck, type Outcome, type UnitModule } from "./harness.js";
import { agrees, atomTruths, orderCases, withoutStacks, type Judged, type Judgement, type OrderCell } from "./order-type.js";
import { auditStructure, predicateSources } from "./structure.js";

// The round-5 review's surviving mutants, each with the finding it came from.
const ROUND5_MUTANTS = [
  ["cap_rule_skipped_in_amount_band", "R5-F1"], ["cap_rule_skipped_in_cap_band", "R5-F1"], ["counterparty_rule_skipped_in_amount_band", "R5-F1"],
  ["asset_rule_skipped_in_prior_band", "R5-F1"], ["clock_rule_skipped_in_amount_band", "R5-F1"],
  ["kind_domain_assert_waived_past_not_after", "R5-F2"], ["mode_domain_assert_waived_past_not_after", "R5-F2"], ["amount_floor_waived_past_not_after", "R5-F2"],
  ["amount_floor_waived_under_deny_all_above_cap_3", "R5-F3"], ["kind_domain_assert_waived_in_cap_band", "R5-F3"], ["clock_assert_waived_in_prior_band", "R5-F3"],
  ["clock_assert_waived_far_past_clock", "R5-F3"], ["amount_floor_waived_under_deny_all_after_spend", "R5-P1"],
  ["clock_rule_needs_zero_prior_unless_off_list", "R5-P2"], ["clock_assert_waived_off_list_after_spend", "R5-P2"], ["clock_rule_needs_zero_prior_for_deny_all_payment", "R5-P2"],
] as const;
const VERDICT_CORE_MUTANTS = [
  "swap_counterparty_cap", "not_after_inclusive", "not_before_exclusive", "cap_inclusive", "clock_rule_removed",
  "mode_domain_assert_removed", "egress_mode_inverted", "counterparty_ignored", "window_after_asset", "kind_domain_assert_removed",
  "decide_uses_clock_time", "clock_assert_waived_when_expired", "clock_assert_waived_for_egress", "kind_domain_assert_waived_when_late",
  "mode_domain_assert_waived_when_early", "cap_skipped_for_over_cap_prior", "deny_all_needs_off_list", "kind_branch_on_asset_ok",
  "kind_branch_on_amount", "clock_rule_needs_zero_prior", "expiry_needs_zero_prior", "early_clock_drops_prior",
  "clock_assert_waived_with_prior", "kind_domain_assert_waived_with_prior", "mode_domain_assert_waived_with_prior",
  "kind_domain_assert_waived_for_amount", "clock_assert_waived_for_cap", "amount_floor_removed", "amount_floor_waived_with_prior",
  "clock_rule_needs_small_cap", "clock_rule_needs_small_amount", "clock_rule_needs_small_prior", "clock_rule_needs_small_not_after",
  "clock_rule_needs_small_clock", "clock_rule_needs_small_not_before", "clock_rule_skipped_for_payment_with_egress_ok",
  "early_rule_needs_small_payment", "early_rule_needs_small_prior", "early_rule_needs_small_time", "early_rule_skipped_for_payment_with_egress_ok",
  "expiry_needs_small_amount", "expiry_skipped_for_payment_with_egress_ok", "asset_rule_needs_small_amount", "asset_rule_needs_small_prior",
  "counterparty_rule_needs_small_amount", "counterparty_rule_needs_small_cap", "payment_allowed_needs_small_amount", "deny_all_needs_small_cap",
  "deny_all_needs_small_prior", "off_list_egress_needs_small_cap", "egress_allowed_needs_small_prior", "clock_assert_waived_for_large_clock",
  "kind_domain_assert_waived_for_large_time", "kind_domain_assert_waived_for_large_not_before", "kind_domain_assert_waived_late_with_prior",
  "kind_domain_assert_waived_with_prior_and_amount", "mode_domain_assert_waived_for_large_time", "mode_domain_assert_waived_late_with_prior",
  "mode_domain_assert_waived_with_prior_under_large_cap", "amount_floor_waived_for_large_time", "amount_floor_waived_under_deny_all",
  "amount_floor_waived_for_asset_mismatch", "amount_floor_waived_off_list", "amount_floor_waived_with_egress_ok", "amount_floor_waived_at_time_zero",
  "amount_floor_waived_late_with_prior", "amount_floor_waived_with_prior_under_large_cap", "validity_window_assert_removed",
  ...ROUND5_MUTANTS.map(([id]) => id), "kind_domain_assert_waived_past_cap", "rewire_window_conditions", "rewire_counterparty_cap_conditions",
  "rewire_asset_rule_negated", "rewire_amount_floor_conjunction", "rewire_clock_assert_and_rule",
];
const PREDICATE_MUTANTS = ["unconstrained_verdict", "ledger_verdict_constant", "claim_high_bits"];
// AM-1: the egress-mode domain assert runs before the deny-all rule on every path, so `mode != 1` returning 6 cannot
// differ from the circuit. It is compiled only to show that, and is never counted as killed.
const EQUIVALENT_MUTANTS = ["egress_mode_not_one_denies"];
// The clock rule returns 2 whenever the action is at or past notAfter, so these mutants change only the 12-argument
// evaluate, which is a pure circuit with no ZKIR.
const EVALUATE_ONLY_MUTANTS = ["not_after_inclusive", "expiry_needs_zero_prior", "expiry_needs_small_amount", "expiry_skipped_for_payment_with_egress_ok"];
// The decision owner's rulings name T-A10 as the killer of these refusal mutants.
const DOMAIN_KILLED_MUTANTS = ["kind_domain_assert_removed", "mode_domain_assert_removed", "amount_floor_removed", "validity_window_assert_removed"];
// AM-6.3: the mutants that pass T-A16. Each only re-wires audited comparisons and Boolean inputs inside audited
// conditions, so T-A17 must kill it.
const REWIRING_MUTANTS = [
  "deny_all_needs_off_list", "kind_branch_on_asset_ok", "amount_floor_waived_for_asset_mismatch", "amount_floor_waived_off_list",
  "amount_floor_waived_with_egress_ok", "rewire_window_conditions", "rewire_counterparty_cap_conditions", "rewire_asset_rule_negated",
  "rewire_amount_floor_conjunction", "rewire_clock_assert_and_rule",
];

const { pureCircuits } = await loadUnit("predicate");
const mutants: { id: string; file: string }[] = JSON.parse(readFileSync(join(resolve(import.meta.dirname, "../.."), "circuits/conduct/mutants.json"), "utf8"));
const cases = allCases();
const disagreements = (pure: UnitModule["pureCircuits"]): VerdictCase[] =>
  cases.filter(c => !isDeepStrictEqual(circuitOutcomes(pure, c), { evaluate: c.evaluate, guard: c.guard }));

interface Judgeable { readonly name: string; readonly enforcedAt: bigint; readonly args: VerdictCase["args"]; readonly guard: Outcome | Judged }

type OrderCase = { readonly cell: OrderCell; readonly judged: Judgement };

// The first T-A17 cell whose circuit outcome differs from the runtime's, in evaluate or, for `guardOnly`, in guard_verdict.
function orderKill(pure: UnitModule["pureCircuits"], samples: Iterable<OrderCase>, guardOnly = false): Judgeable | undefined {
  return withoutStacks(() => {
    for (const { cell, judged } of samples) {
      const got = circuitOutcomes(pure, cell);
      if (!agrees(got.guard, judged.guard) || (!guardOnly && !agrees(got.evaluate, judged.evaluate))) {
        return { name: cell.name, enforcedAt: cell.enforcedAt, args: cell.args, guard: judged.guard };
      }
    }
    return undefined;
  });
}

const guardKills = new Map<string, Judgeable | undefined>();

// The first T-A17 cell on which the mutant's guard_verdict differs from the runtime's, scanned once per mutant.
async function orderGuardKill(id: string): Promise<Judgeable | undefined> {
  if (!guardKills.has(id)) guardKills.set(id, orderKill((await loadUnit(`mutants/${id}`)).pureCircuits, orderCases(), true));
  return guardKills.get(id);
}

// Both circuits are functions of the truth values of the audited comparisons and Boolean inputs, and so is every edit
// that passes T-A16, so one cell per truth assignment stands for all of T-A17 against such an edit.
const representatives = (() => {
  const chosen = new Map<string, OrderCase>();
  for (const sample of orderCases()) {
    const key = atomTruths(sample.cell).map(Number).join("");
    if (!chosen.has(key)) chosen.set(key, sample);
  }
  return [...chosen.values()];
})();

describe("T-A14 every VerdictCore mutant is killed by a T-A03..T-A10 case or a T-A17 cell", () => {
  it("the unmutated predicate agrees with every case in the same run", () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(disagreements(pureCircuits).map(c => c.name)).toEqual([]);
  });

  it("mutants.json lists exactly the VerdictCore, predicate and equivalent mutant sets", () => {
    const ids = (file: string) => mutants.filter(m => m.file === file).map(m => m.id).sort();
    expect(ids("verdict_core.compact")).toEqual([...VERDICT_CORE_MUTANTS, ...EQUIVALENT_MUTANTS].sort());
    expect(ids("predicate.compact")).toEqual([...PREDICATE_MUTANTS].sort());
    expect(mutants).toHaveLength(VERDICT_CORE_MUTANTS.length + PREDICATE_MUTANTS.length + EQUIVALENT_MUTANTS.length);
  });

  it.each(VERDICT_CORE_MUTANTS)("kills %s", async id => {
    const pure = (await loadUnit(`mutants/${id}`)).pureCircuits;
    const killers = disagreements(pure);
    const killed = killers.length > 0 || (await orderGuardKill(id)) !== undefined || orderKill(pure, orderCases()) !== undefined;
    expect(killed, `mutant ${id} survived every case and every T-A17 cell`).toBe(true);
    if (DOMAIN_KILLED_MUTANTS.includes(id)) expect(killers.some(c => c.group === "domain"), `mutant ${id} survived T-A10`).toBe(true);
  });

  it("the PoAC reference has explicit-time semantics: it differs from the guard exactly where the guard clock decides", async () => {
    const poac = (await loadUnit("reference/poac")).pureCircuits;
    const differs: string[] = [];
    for (const c of cases) {
      const got = outcome(() => poac.evaluate!(...c.args));
      if (c.group === "domain") {
        expect(typeof got, `${c.name}: PoAC interprets an out-of-domain value`).toBe("number");
        continue;
      }
      expect(got, `${c.group}: ${c.name}`).toEqual(c.evaluate);
      if (!isDeepStrictEqual(got, c.guard)) differs.push(`${c.group}: ${c.name}`);
    }
    const clockDecides = cases.filter(c => {
      const [notAfter, ts] = [c.args[slot("not_after")] as bigint, c.args[slot("action_timestamp")] as bigint];
      return c.group !== "domain" && (ts > c.enforcedAt || (c.enforcedAt >= notAfter && ts < notAfter));
    });
    expect(clockDecides.length).toBeGreaterThan(0);
    expect(differs).toEqual(clockDecides.map(c => `${c.group}: ${c.name}`));
  });
});

describe("AM-1: the egress `mode != 1` returns 6 mutant is equivalent, so it is never counted as killed", () => {
  const unit = `mutants/${EQUIVALENT_MUTANTS[0]}`;
  const zkir = (dir: string) => readFileSync(join(unitDir(dir), "zkir/check_verdict.zkir"));

  it("is a real edit: its compiled check_verdict differs from the predicate's", () => {
    expect(zkir(unit).equals(zkir("predicate"))).toBe(false);
  });

  it("agrees with the predicate on every case", async () => {
    expect(disagreements((await loadUnit(unit)).pureCircuits).map(c => c.name)).toEqual([]);
  });

  // Every egress-mode byte, four action kinds, four action and clock positions around [1000, 2000), every combination of
  // the three Booleans and a prior of 0 or 2^64-1.
  it("agrees with the predicate on all 65,536 inputs of the exhaustive egress-mode domain", async () => {
    const equivalent = (await loadUnit(unit)).pureCircuits;
    const tag = assetTag("lovelace");
    const positions = [[500n, 500n], [1500n, 1500n], [2000n, 2000n], [1500n, 2000n]] as const;
    const differing: string[] = [];
    let inputs = 0;
    for (let mode = 0n; mode < 256n; mode++) for (const kind of [0n, 1n, 2n, 255n]) for (const [ts, clock] of positions) {
      for (let bits = 0; bits < 8; bits++) for (const prior of [0n, MAX_U64]) {
        const args = [1000n, 2000n, tag, 10n, mode, kind, ts, bits & 1 ? tag : 0n, kind === 1n ? 0n : 5n, (bits & 2) !== 0, prior, (bits & 4) !== 0];
        inputs++;
        for (const [name, run] of [["evaluate", (pure: UnitModule["pureCircuits"]) => pure.evaluate!(...args)], ["guard_verdict", (pure: UnitModule["pureCircuits"]) => pure.guard_verdict!(clock, ...args)]] as const) {
          if (!isDeepStrictEqual(outcome(() => run(pureCircuits)), outcome(() => run(equivalent)))) differing.push(`${name}(${args.join(",")})`);
        }
      }
    }
    expect(inputs).toBe(65_536);
    expect(differing).toEqual([]);
  });
});

describe("AM-6.3: a mutant that passes T-A16 only re-wires audited comparisons, and T-A17 kills it", () => {
  it("exactly the re-wiring mutants pass T-A16", () => {
    expect(mutants.filter(m => auditStructure(predicateSources(`mutants/${m.id}`)).length === 0).map(m => m.id).sort()).toEqual([...REWIRING_MUTANTS].sort());
  });

  it.each(REWIRING_MUTANTS)("T-A17 kills %s", async id => {
    const killer = orderKill((await loadUnit(`mutants/${id}`)).pureCircuits, representatives);
    expect(killer, `mutant ${id} passes T-A16 and survives T-A17: a HIGH finding under AM-6.3`).toBeDefined();
  });

  it.each(ROUND5_MUTANTS)("%s (%s) fails T-A16, and T-A17 kills it", async id => {
    expect(auditStructure(predicateSources(`mutants/${id}`))).not.toEqual([]);
    expect(await orderGuardKill(id), `mutant ${id} survived every T-A17 cell`).toBeDefined();
  });
});

// A claimed verdict is accepted when `check` passes; the statement is the verdict the transcript writes to the ledger.
async function checkedDifferently(unit: string, c: Judgeable): Promise<boolean> {
  const honest = typeof c.guard === "number" ? c.guard : undefined;
  for (const claimed of honest === undefined ? CLAIMS : [honest, ...CLAIMS.filter(code => code !== honest)]) {
    const disclosed = await zkCheck(unit, "check_verdict", {}, checkVerdictArgs(c, claimed)).catch((error: Error) => {
      if (!/Failed direct assertion/.test(error.message)) throw error;
      return undefined;
    });
    if ((disclosed !== undefined) !== (claimed === honest)) return true;
    if (disclosed !== undefined && disclosed.verdictOut !== BigInt(claimed)) return true;
  }
  return false;
}

describe("T-A14 ZKIR leg: every mutant that reaches check_verdict is killed by the compiled constraints", () => {
  it.each(EVALUATE_ONLY_MUTANTS)("%s changes the 12-argument evaluate and never guard_verdict, on any case or T-A17 cell", async id => {
    const pure = (await loadUnit(`mutants/${id}`)).pureCircuits;
    expect(cases.filter(c => !isDeepStrictEqual(circuitOutcomes(pure, c).guard, c.guard)).map(c => c.name)).toEqual([]);
    expect((await orderGuardKill(id))?.name).toBeUndefined();
    expect(cases.some(c => !isDeepStrictEqual(circuitOutcomes(pure, c).evaluate, c.evaluate))).toBe(true);
  });

  // The cases whose guard_verdict the mutant gets wrong at JS come first; when no named case does, the first such T-A17
  // cell. A predicate.compact mutant leaves the pure circuits as they are, so no JS case can differ.
  it.each(mutants.map(m => m.id).filter(id => !EVALUATE_ONLY_MUTANTS.includes(id) && !EQUIVALENT_MUTANTS.includes(id)))("kills %s", async id => {
    const unit = `mutants/${id}`;
    const pure = (await loadUnit(unit)).pureCircuits;
    const jsKills = (c: VerdictCase) => !isDeepStrictEqual(circuitOutcomes(pure, c).guard, c.guard);
    const named = cases.filter(jsKills);
    const cell = named.length > 0 || PREDICATE_MUTANTS.includes(id) ? undefined : await orderGuardKill(id);
    for (const c of [...named, ...(cell === undefined ? [] : [cell]), ...cases.filter(c => !jsKills(c))]) {
      if (await checkedDifferently(unit, c)) return;
    }
    expect.fail(`mutant ${id} survived every case at ZKIR`);
  });
});
