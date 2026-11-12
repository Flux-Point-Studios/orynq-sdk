import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { allowlistLeaf, buildAllowlistRoot, compareBytes } from "@fluxpointstudios/orynq-sdk-conduct";
import { describe, expect, it } from "vitest";
import { allowlistPath } from "../../scripts/conduct/template.mjs";
import { loadUnit } from "./harness.js";
import {
  rederivedStep, runCase, STEP_FIXTURE, stepMutations, stepOpeningOf, stepOutcome, STEPS_MUTANTS, STEPS_UNIT, withClaim, worldOf, type PathStep, type StepOpening,
} from "./steps.js";
import { auditStepsStructure } from "./structure.js";

const text = (s: string) => new TextEncoder().encode(s);

// The honest step of a fixture case in its class.
async function honest(name: string, at = 0): Promise<StepOpening> {
  const c = STEP_FIXTURE.cases.find(x => x.name === name)!;
  return stepOpeningOf((await runCase(c))[at]!, worldOf(c));
}

/** The labels of the forgeries `unit` accepts. */
async function acceptedBy(unit: string, forgeries: readonly (readonly [string, StepOpening])[]): Promise<string[]> {
  const out: string[] = [];
  for (const [label, forged] of forgeries) if (await stepOutcome(forged, unit) === "accepted") out.push(label);
  return out;
}

const members = ["party-0", "party-1", "party-2"];
// The root the path gadget of `unit` computes, or its refusal.
async function walk(unit: string, leaf: Uint8Array, path: readonly PathStep[]): Promise<Uint8Array | string> {
  const { pureCircuits } = await loadUnit(unit);
  try {
    return (pureCircuits.allowlist_root_d2 as unknown as (leaf: Uint8Array, path: readonly PathStep[]) => Uint8Array)(leaf, path);
  } catch (error) {
    return (error as Error).message;
  }
}
const reaches = async (unit: string, member: string, path: readonly PathStep[]) => {
  const result = await walk(unit, allowlistLeaf(member), path);
  return typeof result !== "string" && compareBytes(result, buildAllowlistRoot(members)) === 0;
};

// Each steps mutant with the forgeries its test must see refused, as the labels of those `unit` judges otherwise.
const KILLS: Readonly<Record<string, (unit: string) => Promise<string[]>>> = {
  // T-C04: a lower prior spend makes the cap rule allow the payment the guard denied, claimed as allowed.
  step_no_recorded_decision: async unit => acceptedBy(unit, [["a denial 4 proven as allowed", rederivedStep(await honest("cumulative", 2), { context: { priorSpent: 0n } }, { verdict: 0n })]]),
  step_verdict_unbound: async unit => {
    const o = await honest("deny-all");
    return acceptedBy(unit, [0n, 1n, 2n, 3n, 4n, 5n, 7n].map(verdict => [`a denial 6 stated as verdict ${verdict}`, withClaim(o, { verdict })] as const));
  },
  step_no_action_digest_link: async unit => acceptedBy(unit, [["an action digest that is not the action's", rederivedStep(await honest("egress allowed"), { segments: { actionDigest: text("ab".repeat(32)) } })]]),
  step_no_commitment_link: async unit => {
    const o = await honest("before notBefore");
    const other = Uint8Array.from(o.witnesses.st_pd1_commitment as Uint8Array, b => b ^ 1);
    return acceptedBy(unit, [["K over a commitment the event does not hold", rederivedStep(o, { context: { commitment: other } })]]);
  },
  step_window_index_unbound: async unit => {
    const o = await honest("notAfter exclusive");
    return acceptedBy(unit, [["another window index", withClaim(o, { windowIndex: (o.statement.windowIndex as bigint) + 1n })]]);
  },
  step_asset_unchecked: async unit => acceptedBy(unit, [["an allowed payment in another asset", rederivedStep(await honest("cap-exact"), { segments: { asset: text("EUR") } })]]),
  step_member_unchecked: async unit => {
    const o = await honest("cumulative", 2);
    return acceptedBy(unit, stepMutations(o).get("st_pd4_path")!.map(({ label, value }) => [label, { ...o, witnesses: { ...o.witnesses, st_pd4_path: value } }] as const));
  },
  // D12: a guard clock in the window after the action's.
  window_remainder_unchecked: async unit => acceptedBy(unit, [["a clock in the next spend window", rederivedStep(await honest("egress allowed"), {
    segments: { enforcedAt: text("4") }, context: { window: { q: 0n, r: 3n, rClock: 4n } },
  })]]),
  allowlist_inactive_level_free: async unit => {
    const promoted = members.find(m => (allowlistPath(members, m, 2).path as PathStep[]).some(step => !step.active))!;
    const path = allowlistPath(members, promoted, 2).path as PathStep[];
    const directed = path.map(step => (step.active ? step : { ...step, sibRight: true }));
    return await reaches(unit, promoted, directed) ? ["an inactive level with a direction"] : [];
  },
  // The mutant hashes every node with the current hash on the left, so a member on the right misses its own root.
  allowlist_direction_ignored: async unit => {
    const missed: string[] = [];
    for (const member of members) if (!await reaches(unit, member, allowlistPath(members, member, 2).path as PathStep[])) missed.push(`${member} misses the root by its own path`);
    return missed;
  },
};

describe("the steps discrimination mutants are killed, with the compiled unit as the control in the same test", () => {
  it("names a kill for exactly the steps mutants in mutants.json", () => {
    const mutants: { id: string; file: string; unit?: string }[] = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../circuits/conduct/mutants.json"), "utf8"));
    const steps = mutants.filter(m => m.file === "steps.generated.compact" || m.unit === "steps").map(m => m.id);
    expect(Object.keys(KILLS).sort()).toEqual([...STEPS_MUTANTS].sort());
    expect(steps.sort()).toEqual([...STEPS_MUTANTS].sort());
  });

  it.each(Object.entries(KILLS))("%s: the unit judges every forgery as its test expects, and the mutant does not", async (id, kill) => {
    expect(await kill(STEPS_UNIT), "control").toEqual([]);
    expect(await kill(`mutants/${id}`), `mutant ${id} survived`).not.toEqual([]);
  });

  // The reviewer bar: a mutant that passes the audit must be killed by the step suites; every one here fails both.
  it("every steps mutant fails the structure audit, besides its kill above", () => {
    expect(STEPS_MUTANTS.filter(id => auditStepsStructure(`mutants/${id}`).length === 0)).toEqual([]);
  });
});
