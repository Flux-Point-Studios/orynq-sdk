import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { allCases, circuitOutcomes, type VerdictCase } from "./cases.js";
import { loadUnit, outcome, zkCheck, type UnitModule } from "./harness.js";

const VERDICT_CORE_MUTANTS = [
  "swap_counterparty_cap", "not_after_inclusive", "not_before_exclusive", "cap_inclusive", "clock_rule_removed",
  "mode_domain_assert_removed", "egress_mode_inverted", "counterparty_ignored", "window_after_asset", "kind_domain_assert_removed",
  "decide_uses_clock_time",
];
// The clock rule returns 2 whenever the action is at or past notAfter, so this mutant changes only the 12-argument
// evaluate, which is a pure circuit with no ZKIR.
const EVALUATE_ONLY_MUTANTS = ["not_after_inclusive"];
const CODES = [0, 1, 2, 3, 4, 5, 6, 7];

const { pureCircuits } = await loadUnit("predicate");
const mutants: { id: string; file: string }[] = JSON.parse(readFileSync(join(resolve(import.meta.dirname, "../.."), "circuits/conduct/mutants.json"), "utf8"));
const cases = allCases();
const disagreements = (pure: UnitModule["pureCircuits"]): VerdictCase[] =>
  cases.filter(c => !isDeepStrictEqual(circuitOutcomes(pure, c), { evaluate: c.evaluate, guard: c.guard }));

describe("T-A14 every VerdictCore mutant is killed by a T-A03..T-A10 case", () => {
  it("the unmutated predicate agrees with every case in the same run", () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(disagreements(pureCircuits).map(c => c.name)).toEqual([]);
  });

  it("mutants.json lists the VerdictCore mutant set", () => {
    expect(mutants.filter(m => m.file === "verdict_core.compact").map(m => m.id).sort()).toEqual([...VERDICT_CORE_MUTANTS].sort());
  });

  it.each(VERDICT_CORE_MUTANTS)("kills %s", async id => {
    const killers = disagreements((await loadUnit(`mutants/${id}`)).pureCircuits);
    expect(killers.length, `mutant ${id} survived every case`).toBeGreaterThan(0);
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
      const [notAfter, ts] = [c.args[1], c.args[6]];
      return c.group !== "domain" && (ts > c.enforcedAt || (c.enforcedAt >= notAfter && ts < notAfter));
    });
    expect(clockDecides.length).toBeGreaterThan(0);
    expect(differs).toEqual(clockDecides.map(c => `${c.group}: ${c.name}`));
  });
});

// A claimed verdict is accepted when `check` passes; the statement is the verdict the transcript writes to the ledger.
async function checkedDifferently(unit: string, c: VerdictCase): Promise<boolean> {
  const honest = typeof c.guard === "number" ? c.guard : undefined;
  for (const claimed of honest === undefined ? CODES : [honest, ...CODES.filter(code => code !== honest)]) {
    const disclosed = await zkCheck(unit, "check_verdict", {}, [c.enforcedAt, ...c.args, BigInt(claimed)]).catch((error: Error) => {
      if (!/Failed direct assertion/.test(error.message)) throw error;
      return undefined;
    });
    if ((disclosed !== undefined) !== (claimed === honest)) return true;
    if (disclosed !== undefined && disclosed.verdictOut !== BigInt(claimed)) return true;
  }
  return false;
}

describe("T-A14 ZKIR leg: every mutant that reaches check_verdict is killed by the compiled constraints", () => {
  it.each(EVALUATE_ONLY_MUTANTS)("%s changes the 12-argument evaluate and never guard_verdict", async id => {
    const pure = (await loadUnit(`mutants/${id}`)).pureCircuits;
    expect(cases.filter(c => !isDeepStrictEqual(circuitOutcomes(pure, c).guard, c.guard)).map(c => c.name)).toEqual([]);
    expect(cases.some(c => !isDeepStrictEqual(circuitOutcomes(pure, c).evaluate, c.evaluate))).toBe(true);
  });

  it.each(mutants.map(m => m.id).filter(id => !EVALUATE_ONLY_MUTANTS.includes(id)))("kills %s", async id => {
    const unit = `mutants/${id}`;
    const pure = (await loadUnit(unit)).pureCircuits;
    const jsKills = (c: VerdictCase) => !isDeepStrictEqual(circuitOutcomes(pure, c).guard, c.guard);
    for (const c of [...cases.filter(jsKills), ...cases.filter(c => !jsKills(c))]) {
      if (await checkedDifferently(unit, c)) return;
    }
    expect.fail(`mutant ${id} survived every case at ZKIR`);
  });
});
