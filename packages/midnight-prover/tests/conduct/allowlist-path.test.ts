import { allowlistLeaf, buildAllowlistRoot, compareBytes } from "@fluxpointstudios/orynq-sdk-conduct";
import { describe, expect, it } from "vitest";
import { allowlistPath } from "../../scripts/conduct/template.mjs";
import { loadUnit, unitSource } from "./harness.js";
import {
  prepareStep, STEP_FIELDS, STEP_FIXTURE, stepOpeningOf, stepOutcome, STEPS_UNIT, stepWorld, traceWorld, withStepWitness, type PathStep, type StepWorld, type WitnessRecord,
} from "./steps.js";

const { pureCircuits } = await loadUnit(STEPS_UNIT);

/** The depths the steps unit compiles a pure probe of the path gadget at: a list of up to 2^6 members. */
const PROBE_DEPTHS = [1, 2, 3, 4, 5, 6];
const SIZES = Array.from({ length: 33 }, (_, i) => i + 1);
const list = (n: number, prefix = "party") => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
const levels = (n: number) => Math.max(1, Math.ceil(Math.log2(n)));
const pathOf = (members: readonly string[], member: string, depth: number): PathStep[] => allowlistPath(members, member, depth).path;
const same = (a: Uint8Array, b: Uint8Array) => compareBytes(a, b) === 0;

// The root the path gadget computes from a leaf, or the assert that refused the path.
function walk(leaf: Uint8Array, path: readonly PathStep[]): Uint8Array | string {
  try {
    return (pureCircuits[`allowlist_root_d${path.length}`] as unknown as (leaf: Uint8Array, path: readonly PathStep[]) => Uint8Array)(leaf, path);
  } catch (error) {
    return (error as Error).message;
  }
}
/** Whether the gadget reaches `root`: false where it computes another root, and where it refuses the path. */
const reaches = (root: Uint8Array, leaf: Uint8Array, path: readonly PathStep[]) => {
  const result = walk(leaf, path);
  if (typeof result === "string" && result !== "failed assert: allowlist path not canonical") throw new Error(`unexpected refusal: ${result}`);
  return typeof result !== "string" && same(result, root);
};
const flipByte = (bytes: Uint8Array, at: number) => Uint8Array.from(bytes, (b, i) => (i === at ? b ^ 1 : b));
const at = (path: readonly PathStep[], i: number, step: Partial<PathStep>) => path.map((s, j) => (j === i ? { ...s, ...step } : s));

describe("T-C01 the path gadget computes the conduct allowlist root for every member of every list of 1 to 33 members", () => {
  it("compiles a probe at every depth up to 6, which holds a list of 33", () => {
    expect(PROBE_DEPTHS.map(d => typeof pureCircuits[`allowlist_root_d${d}`])).toEqual(PROBE_DEPTHS.map(() => "function"));
    expect(levels(33)).toBe(6);
  });

  it.each(SIZES)("a list of %i: every member's path reaches buildAllowlistRoot at the list's own depth and at the deepest probe", n => {
    const members = list(n);
    const root = buildAllowlistRoot(members);
    for (const member of members) {
      for (const depth of new Set([levels(n), 6])) {
        const { path, root: walked } = allowlistPath(members, member, depth);
        expect(path).toHaveLength(depth);
        expect(same(walked, root), `${member} reference root at depth ${depth}`).toBe(true);
        const result = walk(allowlistLeaf(member), path);
        expect(typeof result === "string" ? result : same(result, root), `${member} at depth ${depth}`).toBe(true);
      }
    }
  });

  it("a list larger than 2^D members is refused at classification, and one of exactly 2^D is not", () => {
    expect(() => allowlistPath(list(5), "party-0", 2)).toThrow("ALLOWLIST_TOO_DEEP: a list of 5 members needs more than 2 levels");
    expect(allowlistPath(list(4), "party-0", 2).path).toHaveLength(2);
    expect(() => allowlistPath(list(4), "stranger", 2)).toThrow("NOT_A_MEMBER: the allowlist does not hold the party");
  });
});

describe("T-C01 the path gadget reaches a root only from a member of its list, by that member's own path", () => {
  it.each(SIZES)("a list of %i: every direction flip, every active flip and a changed sibling at every level miss the root", n => {
    const members = list(n);
    const root = buildAllowlistRoot(members);
    const accepted: string[] = [];
    let tried = 0;
    for (const member of members) {
      const leaf = allowlistLeaf(member);
      const path = pathOf(members, member, levels(n));
      expect(reaches(root, leaf, path), "honest control").toBe(true);
      path.forEach((step, i) => {
        const variants: [string, PathStep[]][] = [
          ["sibRight flipped", at(path, i, { sibRight: !step.sibRight })], ["active flipped", at(path, i, { active: !step.active })],
          ["first sibling byte changed", at(path, i, { sib: flipByte(step.sib, 0) })], ["last sibling byte changed", at(path, i, { sib: flipByte(step.sib, 31) })],
        ];
        for (const [label, forged] of variants) {
          tried += 1;
          if (reaches(root, leaf, forged)) accepted.push(`${member} level ${i} ${label}`);
        }
      });
    }
    expect(accepted, "mutation accepted").toEqual([]);
    expect(tried).toBe(4 * n * levels(n));
  });

  it.each(SIZES)("a list of %i: a non-member, a member of another list, the empty list's zero root and a list one member larger or smaller", n => {
    const members = list(n);
    const root = buildAllowlistRoot(members);
    const depth = levels(n + 1);
    const others = list(n, "other");
    const zero = buildAllowlistRoot([]);
    expect(zero).toEqual(new Uint8Array(32));
    const neighbours = [list(n + 1), ...(n > 1 ? [list(n - 1)] : [])];
    for (const member of members) {
      const path = pathOf(members, member, depth);
      expect(reaches(root, allowlistLeaf(member), path), "honest control").toBe(true);
      // A party outside the list under a member's path, and a member of another list under its own path there.
      expect(reaches(root, allowlistLeaf("stranger"), path)).toBe(false);
      expect(reaches(root, allowlistLeaf(others[0]!), pathOf(others, others[0]!, depth))).toBe(false);
      // No path from a member reaches the zero root of the empty list.
      expect(reaches(zero, allowlistLeaf(member), path)).toBe(false);
      expect(reaches(zero, allowlistLeaf(member), path.map(step => ({ ...step, active: false, sibRight: false, sib: new Uint8Array(32) })))).toBe(false);
      // Cross-size replay: the path in this list against the root of a neighbour, and the neighbour's path against this root.
      for (const neighbour of neighbours) {
        expect(reaches(buildAllowlistRoot(neighbour), allowlistLeaf(member), path), `${member} against a list of ${neighbour.length}`).toBe(false);
        if (neighbour.includes(member)) expect(reaches(root, allowlistLeaf(member), pathOf(neighbour, member, depth)), `${member} from a list of ${neighbour.length}`).toBe(false);
      }
    }
  });

  // Pinned gap, not fixed here: the path witness is malleable. An inactive level may stand anywhere, so a member has
  // more than one accepted path. Every accepted path hashes the same leaf through the same nodes, so no false
  // membership follows; only the witness is not unique.
  it("pinned gap: the levels of a path may be permuted around an inactive one, and the walk still reaches the root", () => {
    const members = list(2);
    const root = buildAllowlistRoot(members);
    for (const member of members) {
      const [active, idle] = pathOf(members, member, 2) as [PathStep, PathStep];
      expect([active.active, idle.active]).toEqual([true, false]);
      expect(reaches(root, allowlistLeaf(member), [active, idle]), "the path allowlistPath writes").toBe(true);
      expect(reaches(root, allowlistLeaf(member), [idle, active]), "the same levels the other way round").toBe(true);
    }
  });

  it("an inactive level carries no direction and no sibling", () => {
    const members = list(3);
    const promoted = members.find(m => pathOf(members, m, 2).some(step => !step.active))!;
    const path = pathOf(members, promoted, 2);
    const idle = path.findIndex(step => !step.active);
    expect(path[idle]).toEqual({ active: false, sibRight: false, sib: new Uint8Array(32) });
    expect(walk(allowlistLeaf(promoted), at(path, idle, { sibRight: true }))).toBe("failed assert: allowlist path not canonical");
    expect(walk(allowlistLeaf(promoted), at(path, idle, { sib: flipByte(new Uint8Array(32), 31) }))).toBe("failed assert: allowlist path not canonical");
  });
});

const fixture = STEP_FIXTURE.mandate;
const COUNTERPARTIES = ["acme", "beta", "cafe", "dove"];
const DESTINATIONS = ["api1", "api2", "api3", "api4"];
const world = (n: number): StepWorld => stepWorld({ ...fixture, counterparties: COUNTERPARTIES.slice(0, n), egress: DESTINATIONS.slice(0, n) });

describe("T-C01 a step walks the path of its event's own party to the root K commits", () => {
  it.each([1, 2, 3, 4])("lists of %i: a payment to every counterparty and an egress to every destination are accepted with their allowed decision", async n => {
    const w = world(n);
    for (const [i, counterparty] of w.counterparties.entries()) {
      const steps = await traceWorld(w, [
        { action: { kind: "payment", asset: "USD", amount: 1n, counterparty, timestamp: 3n } },
        { action: { kind: "egress", destination: w.egress![i]!, timestamp: 3n } },
      ]);
      expect(steps.map(s => s.verdict)).toEqual([0, 0]);
      expect(steps.map(s => stepOpeningOf(s, w).circuit)).toEqual(["st_pa", "st_ea"]);
      for (const step of steps) expect(await stepOutcome(stepOpeningOf(step, w)), `${counterparty} of ${n}`).toBe("accepted");
    }
  });

  it("refuses a list deeper than its class, a member under another member's path, and a member of a list the mandate does not commit", async () => {
    const w = world(3);
    const [step] = await traceWorld(w, [{ action: { kind: "payment", asset: "USD", amount: 1n, counterparty: "beta", timestamp: 3n } }]);
    const opening = stepOpeningOf(step!, w);
    expect(await stepOutcome(opening), "honest control").toBe("accepted");
    const deep = { ...w, counterparties: [...COUNTERPARTIES, "echo"] };
    expect(() => stepOpeningOf(step!, deep)).toThrow("ALLOWLIST_TOO_DEEP: a list of 5 members needs more than 2 levels");
    expect(await stepOutcome(withStepWitness(opening, "path", pathOf(w.counterparties, "acme", 2)))).toBe("failed assert: non-membership not provable");
    const elsewhere = ["beta", "zeta", "yoda"];
    expect(await stepOutcome(withStepWitness(opening, "path", pathOf(elsewhere, "beta", 2)))).toBe("failed assert: non-membership not provable");
  });

  it("pinned gap: a step accepts its member's path with the inactive level first, at the generated JS and at ZKIR, and discloses the same statement", async () => {
    const w = world(2);
    const [step] = await traceWorld(w, [{ action: { kind: "payment", asset: "USD", amount: 1n, counterparty: "beta", timestamp: 3n } }]);
    const opening = stepOpeningOf(step!, w);
    const [active, idle] = opening.witnesses.st_pa_path as [PathStep, PathStep];
    expect([active.active, idle.active]).toEqual([true, false]);
    const permuted = withStepWitness(opening, "path", [idle, active]);
    expect(await stepOutcome(permuted)).toBe("accepted");
    const honest = await (await prepareStep(opening)).check();
    expect(await (await prepareStep(permuted)).check()).toEqual(honest);
  });

  it("the generated binding refuses a path flag that is not a Boolean, and the compiled constraints refuse it when the private transcript carries one", async () => {
    const w = world(3);
    const [step] = await traceWorld(w, [{ action: { kind: "payment", asset: "USD", amount: 1n, counterparty: "beta", timestamp: 3n } }]);
    const opening = stepOpeningOf(step!, w);
    const path = opening.witnesses.st_pa_path as PathStep[];
    for (const flag of ["active", "sibRight"] as const) {
      const forged = at(path, 0, { [flag]: 2 as unknown as boolean });
      expect(await stepOutcome(withStepWitness(opening, "path", forged)), `binding check, not circuit evidence: ${flag}`).toMatch(/type error: .*st_pa_path/);
    }
    const honest = await prepareStep(opening);
    await expect(honest.check(), "honest control").resolves.toBeDefined();
    // Each flag of the path is one private transcript value; the others are its sibling halves.
    for (const [flag, slot] of [["active", 0], ["sibRight", 1]] as const) {
      const record: WitnessRecord = { requested: new Set(), read: [] };
      const prepared = await prepareStep(opening, STEPS_UNIT, record);
      const output = prepared.data.privateTranscriptOutputs[record.read.indexOf("st_pa_path")] as { value: Uint8Array[] };
      expect([...output.value[slot]!], `${flag} of the first level`).toEqual(path[0]![flag] ? [1] : []);
      output.value[slot] = Uint8Array.of(2);
      await expect(prepared.check(), `a ${flag} of 2`).rejects.toThrow(/Failed direct assertion|boolean|bit/i);
    }
  });

  it("the statement carries no leaf index: membership is of a set", () => {
    expect([...STEP_FIELDS]).toEqual(["prevRollHex", "rollAfter", "atoms", "windowIndex", "priorSpent", "verdict", "dataSeq", "traceSeq"]);
    const source = unitSource(STEPS_UNIT, "steps.generated.compact");
    const struct = /export struct ConductStep \{([^}]*)\}/.exec(source)![1]!;
    expect(struct.split(",").map(field => field.trim().split(":")[0])).toEqual([...STEP_FIELDS]);
    expect(source).not.toMatch(/leaf ?index|position/i);
  });
});
