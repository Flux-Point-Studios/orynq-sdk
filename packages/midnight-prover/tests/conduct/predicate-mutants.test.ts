import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assetTag, PREDICATE_LAYOUT } from "@fluxpointstudios/orynq-sdk-conduct";
import { describe, expect, it } from "vitest";
import { allCases, checkVerdictArgs, circuitOutcomes, CLAIMS, MAX_U64, slot, type VerdictCase } from "./cases.js";
import { loadUnit, outcome, unitDir, zkCheck, type Outcome, type UnitModule } from "./harness.js";
import { agrees, assertsApplying, atomTruths, orderCases, withoutStacks, type Judged, type Judgement, type OrderCell } from "./order-type.js";
import { OPENINGS_MUTANTS } from "./openings.js";
import { STEPS_MUTANTS } from "./steps.js";
import { auditStructure } from "./structure.js";

const BAND = "a rule skipped in a band between 2^32 and 2^53";
const PAST_NOT_AFTER = "a refusal waived strictly past notAfter";
const THRESHOLD = "a refusal waived past a cap, prior or lag threshold";
const AFTER_SPEND = "a rule or refusal gated on a prior spend, off-list or under deny-all";
// Mutants that gate a rule or refusal on a magic band or a combination of slots, each with what it gates.
const GATED_MUTANTS = [
  ["cap_rule_skipped_in_amount_band", BAND], ["cap_rule_skipped_in_cap_band", BAND], ["counterparty_rule_skipped_in_amount_band", BAND],
  ["asset_rule_skipped_in_prior_band", BAND], ["clock_rule_skipped_in_amount_band", BAND],
  ["kind_domain_assert_waived_past_not_after", PAST_NOT_AFTER], ["mode_domain_assert_waived_past_not_after", PAST_NOT_AFTER],
  ["amount_floor_waived_past_not_after", PAST_NOT_AFTER], ["amount_floor_waived_under_deny_all_above_cap_3", THRESHOLD],
  ["kind_domain_assert_waived_in_cap_band", THRESHOLD], ["clock_assert_waived_in_prior_band", THRESHOLD], ["clock_assert_waived_far_past_clock", THRESHOLD],
  ["amount_floor_waived_under_deny_all_after_spend", AFTER_SPEND], ["clock_rule_needs_zero_prior_unless_off_list", AFTER_SPEND],
  ["clock_assert_waived_off_list_after_spend", AFTER_SPEND], ["clock_rule_needs_zero_prior_for_deny_all_payment", AFTER_SPEND],
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
  ...GATED_MUTANTS.map(([id]) => id), "kind_domain_assert_waived_past_cap", "rewire_window_conditions", "rewire_counterparty_cap_conditions",
  "rewire_asset_rule_negated", "rewire_amount_floor_conjunction", "rewire_clock_assert_and_rule", "refusal_messages_swapped", "r8_rewire_kind_mode_conditions",
];
const PREDICATE_MUTANTS = [
  "unconstrained_verdict", "ledger_verdict_constant", "claim_high_bits", "check_verdict_waived_off_list", "check_verdict_refuses_off_list",
];
// A waiver module placed after a declaration with a body, where a parse that stopped early would not see it. It adds
// literals and comparisons, which AM-6.3 answers by T-A16, so no case or cell is required to kill it.
const HIDDEN_CODE_MUTANTS = ["hidden_waiver", "hidden_waiver_behind_struct", "hidden_waiver_behind_carriage_return"];
// ZKIR carries no assert message, so a mutant that only moves messages between asserts compiles to the predicate's
// constraints and only the generated JS can tell it apart.
const MESSAGE_ONLY_MUTANTS = ["refusal_messages_swapped"];
// A mutant that swaps the conditions of two asserts changes check_verdict's ZKIR, yet both conditions are still
// asserted, so its constraints accept the predicate's claims and only the refusal raised in the generated JS differs.
const REFUSAL_ONLY_MUTANTS = ["r8_rewire_kind_mode_conditions"];
// The named cases a refusal-only mutant is checked on at ZKIR, and the T-A17 cell added to them: all 816 take about 113 s.
const REFUSAL_ONLY_ZKIR_SAMPLE = { named: 66, cells: 1 };
// AM-1: the egress-mode domain assert runs before the deny-all rule on every path, so `mode != 1` returning 6 cannot
// differ from the circuit. It is compiled only to show that, and is never counted as killed.
const EQUIVALENT_MUTANTS = ["egress_mode_not_one_denies"];
// The clock rule returns 2 whenever the action is at or past notAfter, so these mutants change only the 12-argument
// evaluate, which is a pure circuit with no ZKIR.
const EVALUATE_ONLY_MUTANTS = ["not_after_inclusive", "expiry_needs_zero_prior", "expiry_needs_small_amount", "expiry_skipped_for_payment_with_egress_ok"];
// The decision owner's rulings name T-A10 as the killer of these refusal mutants.
const DOMAIN_KILLED_MUTANTS = ["kind_domain_assert_removed", "mode_domain_assert_removed", "amount_floor_removed", "validity_window_assert_removed"];
// AM-6.3: the mutants that pass T-A16. Each only re-wires audited comparisons and Boolean inputs inside ConductVerdict's
// conditions, so T-A17 must kill it.
const REWIRING_MUTANTS = [
  "deny_all_needs_off_list", "kind_branch_on_asset_ok", "amount_floor_waived_for_asset_mismatch", "amount_floor_waived_off_list",
  "amount_floor_waived_with_egress_ok", "rewire_window_conditions", "rewire_counterparty_cap_conditions", "rewire_asset_rule_negated",
  "rewire_amount_floor_conjunction", "rewire_clock_assert_and_rule", ...REFUSAL_ONLY_MUTANTS,
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
      if (!agrees(got.guard, judged.guard, () => assertsApplying(cell).guard) || (!guardOnly && !agrees(got.evaluate, judged.evaluate, () => assertsApplying(cell).evaluate))) {
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

  it("mutants.json lists exactly the VerdictCore, predicate and equivalent mutant sets, and the openings set", () => {
    const ids = (file: string) => mutants.filter(m => m.file === file).map(m => m.id).sort();
    expect(ids("verdict_core.compact")).toEqual([...VERDICT_CORE_MUTANTS, ...EQUIVALENT_MUTANTS].sort());
    expect(ids("predicate.compact")).toEqual([...PREDICATE_MUTANTS, ...HIDDEN_CODE_MUTANTS].sort());
    expect(mutants.map(m => m.id).sort()).toEqual([...VERDICT_CORE_MUTANTS, ...EQUIVALENT_MUTANTS, ...PREDICATE_MUTANTS, ...HIDDEN_CODE_MUTANTS, ...OPENINGS_MUTANTS, ...STEPS_MUTANTS].sort());
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
        const values: Readonly<Record<string, bigint | boolean>> = {
          not_before: 1000n, not_after: 2000n, cap_asset: tag, cap_amount: 10n, egress_mode: mode, action_kind: kind, action_timestamp: ts,
          action_asset: bits & 1 ? tag : 0n, action_amount: kind === 1n ? 0n : 5n, counterparty_ok: (bits & 2) !== 0, prior_spent: prior, egress_ok: (bits & 4) !== 0,
        };
        const args = PREDICATE_LAYOUT.map(input => values[input.name]!);
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

describe("a mutant that moves messages between asserts compiles to the predicate's constraints, and T-A17 kills it", () => {
  it.each(MESSAGE_ONLY_MUTANTS)("%s has the predicate's check_verdict ZKIR and raises the wrong refusal on a T-A17 cell", async id => {
    expect(readFileSync(join(unitDir(`mutants/${id}`), "zkir/check_verdict.zkir")).equals(readFileSync(join(unitDir("predicate"), "zkir/check_verdict.zkir")))).toBe(true);
    const killer = orderKill((await loadUnit(`mutants/${id}`)).pureCircuits, representatives);
    expect(killer, `mutant ${id} raises the right refusal on every T-A17 cell`).toBeDefined();
  });
});

describe("AM-6.3: a mutant that passes T-A16 only re-wires audited comparisons, and T-A17 kills it", () => {
  it("exactly the re-wiring mutants of the predicate unit pass T-A16", () => {
    const predicateMutants = mutants.filter(m => !OPENINGS_MUTANTS.includes(m.id) && !STEPS_MUTANTS.includes(m.id));
    expect(predicateMutants.filter(m => auditStructure(`mutants/${m.id}`).length === 0).map(m => m.id).sort()).toEqual([...REWIRING_MUTANTS].sort());
  });

  it.each(REWIRING_MUTANTS)("T-A17 kills %s", async id => {
    const killer = orderKill((await loadUnit(`mutants/${id}`)).pureCircuits, representatives);
    expect(killer, `mutant ${id} passes T-A16 and survives T-A17: a HIGH finding under AM-6.3`).toBeDefined();
  });

  it.each(GATED_MUTANTS)("%s (%s) fails T-A16, and T-A17 kills it", async id => {
    expect(auditStructure(`mutants/${id}`)).not.toEqual([]);
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

// One named case from each stratum, in the order of `allCases`: a stratum is a case group, the guard_verdict expected
// there and whether the mutant's guard_verdict differs from it at JS. The first T-A17 cell the mutant gets wrong follows.
async function zkirSample(id: string): Promise<Judgeable[]> {
  const pure = (await loadUnit(`mutants/${id}`)).pureCircuits;
  const strata = new Map<string, Judgeable>();
  for (const c of cases) {
    const key = JSON.stringify([c.group, c.guard, isDeepStrictEqual(circuitOutcomes(pure, c).guard, c.guard)]);
    if (!strata.has(key)) strata.set(key, c);
  }
  const cell = await orderGuardKill(id);
  return [...strata.values(), ...(cell === undefined ? [] : [cell])];
}

// The claims check_verdict accepts are fixed by whether guard_verdict refuses and by the verdict it returns otherwise.
const acceptsAlike = (got: Outcome, expected: Outcome | Judged) =>
  (typeof expected === "number" ? got === expected : typeof got !== "number");

describe("a mutant that swaps the conditions of two asserts raises the wrong refusal, and the compiled constraints cannot tell", () => {
  it.each(REFUSAL_ONLY_MUTANTS)("%s compiles to a different check_verdict, and at JS differs only in the refusal it raises", async id => {
    const unit = `mutants/${id}`;
    expect(readFileSync(join(unitDir(unit), "zkir/check_verdict.zkir")).equals(readFileSync(join(unitDir("predicate"), "zkir/check_verdict.zkir")))).toBe(false);
    const pure = (await loadUnit(unit)).pureCircuits;
    expect(cases.filter(c => !acceptsAlike(circuitOutcomes(pure, c).guard, c.guard)).map(c => c.name)).toEqual([]);
    const cells = withoutStacks(() => representatives.filter(({ cell, judged }) => !acceptsAlike(circuitOutcomes(pure, cell).guard, judged.guard)));
    expect(cells.map(({ cell }) => cell.name)).toEqual([]);
  });

  it.each(REFUSAL_ONLY_MUTANTS)("%s differs on no case of a stratified sample at ZKIR", async id => {
    const sample = await zkirSample(id);
    const differing: string[] = [];
    for (const c of sample) if (await checkedDifferently(`mutants/${id}`, c)) differing.push(c.name);
    expect(differing).toEqual([]);
    expect(sample).toHaveLength(REFUSAL_ONLY_ZKIR_SAMPLE.named + REFUSAL_ONLY_ZKIR_SAMPLE.cells);
  });
});

describe("T-A14 ZKIR leg: every mutant that reaches check_verdict is killed by the compiled constraints", () => {
  it.each(EVALUATE_ONLY_MUTANTS)("%s changes the 12-argument evaluate and never guard_verdict, on any case or T-A17 cell", async id => {
    const pure = (await loadUnit(`mutants/${id}`)).pureCircuits;
    expect(cases.filter(c => !isDeepStrictEqual(circuitOutcomes(pure, c).guard, c.guard)).map(c => c.name)).toEqual([]);
    expect((await orderGuardKill(id))?.name).toBeUndefined();
    expect(cases.some(c => !isDeepStrictEqual(circuitOutcomes(pure, c).evaluate, c.evaluate))).toBe(true);
  });

  // The cases whose guard_verdict the mutant gets wrong at JS come first; when no named case does, the first such T-A17
  // cell. A predicate.compact mutant leaves the pure circuits as they are, so no JS case can differ.
  it.each(mutants.map(m => m.id).filter(id => ![...EVALUATE_ONLY_MUTANTS, ...EQUIVALENT_MUTANTS, ...HIDDEN_CODE_MUTANTS, ...MESSAGE_ONLY_MUTANTS, ...REFUSAL_ONLY_MUTANTS, ...OPENINGS_MUTANTS, ...STEPS_MUTANTS].includes(id)))("kills %s", async id => {
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
