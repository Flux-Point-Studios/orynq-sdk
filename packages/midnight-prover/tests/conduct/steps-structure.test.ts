import { describe, expect, it } from "vitest";
import { STEPS_MUTANTS, STEPS_UNIT } from "./steps.js";
import { auditSteps, auditStepsStructure, stepSources } from "./structure.js";

type StepFile = keyof ReturnType<typeof stepSources>;
type Edit = readonly [find: string, replace: string];

// The steps unit with each edit's `find`, which must occur, replaced at its first occurrence: in the generated steps,
// st_pa is the first class.
function edited(file: StepFile, ...edits: readonly Edit[]): string[] {
  const sources = stepSources();
  let text = sources[file];
  for (const [find, replace] of edits) {
    if (!text.includes(find)) throw new Error(`${file} does not hold ${find}`);
    text = text.replace(find, () => replace);
  }
  return auditSteps({ ...sources, [file]: text });
}

const subject = (finding: string) => finding.slice(0, finding.indexOf(":"));
const DECIDE = "CV_decide(enforcedAtValue, atoms.notBefore, atoms.notAfter, atoms.capAmount, atoms.egressMode, 0, tsValue, amountValue, assetOk, memberOk, s.priorSpent, false)";
const LITERALS = "st_pa literals differ from the audited list";
const COMPARISONS = "st_pa comparisons differ from the audited list";
const CALLS = "st_pa calls differ from the audited list";
const statements = (line: number) => `st_pa differs from its audited statement list at line ${line}`;

// The audit parses gadgets.compact, verdict_core.compact and steps.generated.compact to the last token. It holds the
// gadgets to their committed literals, comparisons, calls and statements, the verdict core to T-A16's audit, and each
// generated step class and probe to the reference text that step-reference.ts derives from classes.json, the producers
// and the S-CONDUCT-STEP statement, without the template's emitter.
describe("the gadgets, the verdict core and every generated step class hold exactly the audited structure", () => {
  it("the steps unit under test passes the audit, and its compiled contract implements exactly the audited circuits, probes and witnesses", () => {
    expect(auditStepsStructure(STEPS_UNIT)).toEqual([]);
  });

  it("every steps mutant in mutants.json fails the audit", () => {
    expect(STEPS_MUTANTS.filter(id => auditStepsStructure(`mutants/${id}`).length === 0)).toEqual([]);
  });

  it("refuses the recorded-decision check dropped from one class with its exact message", () => {
    expect(auditStepsStructure("mutants/step_no_recorded_decision")).toEqual([
      "st_pd4 literals differ from the audited list: added [], removed [4]",
      "st_pd4 comparisons differ from the audited list: added [], removed [verdict == 4]",
      'st_pd4 differs from its audited statement list at line 45: found "conductStep = disclose(s)", audited "assert (verdict == 4), \\"recorded decision\\""',
    ]);
  });

  it.each<readonly [string, string, string, readonly string[]]>([
    ["a recorded decision that also takes an allowed verdict", 'assert(verdict == 0, "recorded decision");', 'assert(verdict == 0 || verdict == 4, "recorded decision");', [LITERALS, COMPARISONS, statements(45)]],
    ["a counterparty walked to the egress root", "path) == atoms.counterpartyRoot;", "path) == atoms.egressRoot;", [COMPARISONS, statements(41)]],
    ["a path walked at another depth", "allowlistRoot<2>(", "allowlistRoot<1>(", [LITERALS, COMPARISONS, CALLS, statements(41)]],
    ["an asset rule that always passes", "== atoms.assetDigest;", "== atoms.assetDigest || true;", [LITERALS, statements(39)]],
    ["the membership and asset inputs of the verdict swapped", "assetOk, memberOk, s.priorSpent", "memberOk, assetOk, s.priorSpent", [CALLS, statements(42)]],
    ["a stated prior spend replaced by 0", "memberOk, s.priorSpent, false);", "memberOk, 0, false);", [LITERALS, CALLS, statements(42)]],
    ["a window check dropped", "  windowOf(tsValue, enforcedAtValue, atoms.windowSeconds, window.q, window.r, window.rClock);\n", "", [CALLS, statements(37)]],
    ["K hashed over a field element", "Vector<32, Uint<8>>, Uint<64>, Uint<64>, Bytes<32>,", "Vector<32, Uint<8>>, Field, Uint<64>, Bytes<32>,", [COMPARISONS, CALLS, statements(35)]],
    ["another action digest domain", "orynq:conduct:guard:action:v1|", "orynq:conduct:guard:action:v2|", [CALLS, statements(31)]],
    ["an amount hashed without its head bound", '  assert(amountValue <= 23, "action cbor head");\n', "", [LITERALS, COMPARISONS, statements(29)]],
    ["a non-membership verdict let through", 'assert(verdict != 5 && verdict != 7, "non-membership not provable");', 'assert(verdict != 5, "non-membership not provable");', [LITERALS, COMPARISONS, statements(43)]],
  ])("refuses %s in the generated steps", (_label, find, replace, subjects) => {
    expect(edited("steps.generated.compact", [find, replace]).map(subject)).toEqual(subjects);
  });

  it("names the changed call of a re-wired verdict exactly", () => {
    const swapped = DECIDE.replace("assetOk, memberOk", "memberOk, assetOk");
    expect(edited("steps.generated.compact", ["assetOk, memberOk, s.priorSpent", "memberOk, assetOk, s.priorSpent"])).toEqual([
      `st_pa calls differ from the audited list: added [${swapped}], removed [${DECIDE}]`,
      `st_pa differs from its audited statement list at line 42: found ${JSON.stringify(`const verdict = ${swapped}`)}, audited ${JSON.stringify(`const verdict = ${DECIDE}`)}`,
    ]);
  });

  it("refuses a witness and a circuit outside every class, and a probe retargeted to another depth", () => {
    expect(edited("steps.generated.compact", ["export pure circuit allowlist_root_d1(", "witness extra(): Vector<1, Uint<8>>;\nexport circuit sneak(s: ConductStep): [] {\n  conductStep = disclose(s);\n}\n\nexport pure circuit allowlist_root_d1("])).toEqual([
      "steps.generated.compact declarations differ from the audited list: added [circuit sneak, witness extra(): Vector<1, Uint<8>>;], removed []",
    ]);
    expect(edited("steps.generated.compact", ["return allowlistRoot<3>(leaf, path);", "return allowlistRoot<2>(leaf, path);"]).map(subject)).toEqual([
      "allowlist_root_d3 literals differ from the audited list", "allowlist_root_d3 calls differ from the audited list", "allowlist_root_d3 differs from its audited statement list at line 2",
    ]);
  });

  it.each<readonly [string, Edit, readonly string[]]>([
    ["a clock remainder that may reach the window width", ["rClock < w,", "rClock <= w,"], ["ConductGadgets.windowOf comparisons differ from the audited list", "ConductGadgets.windowOf differs from its audited statement list at line 2"]],
    ["an inactive level that passes its sibling up", ["return step.active ? node : cur;", "return step.active ? node : step.sib;"], ["ConductGadgets.allowlistStep differs from its audited statement list at line 6"]],
    ["a node hashed under the leaf domain", ["orynq:conduct:allowlist:node:v1|", "orynq:conduct:allowlist:leaf:v1|"], ["ConductGadgets.allowlistStep calls differ from the audited list", "ConductGadgets.allowlistStep differs from its audited statement list at line 5"]],
    ["a hex link that skips its last byte", ["for (const j of 0..32) {", "for (const j of 0..31) {"], ["ConductGadgets.hexOfBytes literals differ from the audited list", "ConductGadgets.hexOfBytes differs from its audited statement list at line 2"]],
  ])("refuses %s in a gadget the steps read", (_label, edit, subjects) => {
    expect(edited("gadgets.compact", edit).map(subject)).toEqual(subjects);
  });

  it("holds the verdict core the steps compile to T-A16's audit", () => {
    expect(edited("verdict_core.compact", ["if (prior_spent + action_amount > cap_amount) { return 4; }", "if (prior_spent + action_amount >= cap_amount) { return 4; }"])).toEqual([
      "comparisons differ from the audited list: added [prior_spent + action_amount >= cap_amount], removed [prior_spent + action_amount > cap_amount]",
    ]);
  });

  // The order of a struct's fields sets each statement value's slot in the public transcript.
  it("refuses the statement's fields reordered", () => {
    expect(edited("steps.generated.compact", ["  windowIndex: Uint<64>,\n  priorSpent: Uint<64>,", "  priorSpent: Uint<64>,\n  windowIndex: Uint<64>,"]).map(subject)).toEqual([
      "steps.generated.compact declarations differ from the audited list",
    ]);
  });
});
