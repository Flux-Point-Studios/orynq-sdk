import { encodeMandate, mandateCommitment } from "@fluxpointstudios/orynq-sdk-conduct";
import { describe, expect, it } from "vitest";
import { unitSource } from "./harness.js";
import { mandateOpeningOf } from "./mandates.js";
import { OPENINGS_UNIT, runOpening } from "./openings.js";
import { mandateAtoms, weld } from "./statement-checker.js";
import { rederivedStep, runCase, runStep, STEP_FIXTURE, stepOpeningOf, stepOutcome, STEPS_UNIT, stepWorld, traceWorld, worldOf, type FixtureCase } from "./steps.js";

type Statement = Record<string, Uint8Array | bigint>;
const caseOf = (name: string): FixtureCase => STEP_FIXTURE.cases.find(c => c.name === name)!;

// The mandate opening and the first provable step of a fixture case, each run through its own circuit.
async function pair(name: string): Promise<{ mandate: Statement; step: Statement; reference: Uint8Array }> {
  const c = caseOf(name);
  const world = worldOf(c);
  const opening = mandateOpeningOf(encodeMandate(world.mandate));
  expect(opening.circuit).toBe("m_step");
  const [first] = await runCase(c);
  return { mandate: await runOpening(opening) as Statement, step: await runStep(stepOpeningOf(first!, world)) as Statement, reference: mandateAtoms(world.mandate) };
}

describe("T-C06 a step and the opening of its mandate compute one K", () => {
  // Each case's mandate differs from the others in an atom K commits: the cap, the window, or the egress mode and root.
  it.each(["within cap", "exceed by one", "clock expiry", "deny-all", "egress allowed"])("%s: K of the step = K of S-MANDATE-OPEN = the reference, and weld() accepts the pair", async name => {
    const { mandate, step, reference } = await pair(name);
    expect(step.atoms).toEqual(reference);
    expect(mandate.atoms).toEqual(reference);
    expect(mandate.commitment).toEqual(mandateCommitment(worldOf(caseOf(name)).mandate));
    expect(() => weld(step, mandate)).not.toThrow();
  });

  it("the two circuits hash the commitment under different types: the opening as the Bytes<32> it computed, the step as bytes decoded from the event's hex", () => {
    const atomsOf = (source: string, circuit: string) => {
      const body = source.slice(source.indexOf(`export circuit ${circuit}(`));
      return /persistentHash<\[Bytes<32>, ([^,]+(?:, Uint<8>>)?), Uint<64>, Uint<64>, Bytes<32>, Uint<64>, Uint<64>, Uint<8>, [^\]]+\]>\(\[pad\(32, "orynq:conduct:mandate-atoms:v1"\), (\w+),/.exec(body)!.slice(1, 3);
    };
    expect(atomsOf(unitSource(OPENINGS_UNIT, "openings.generated.compact"), "m_step")).toEqual(["Bytes<32>", "commitment"]);
    expect(atomsOf(unitSource(STEPS_UNIT, "steps.generated.compact"), "st_pa")).toEqual(["Vector<32, Uint<8>>", "commitment"]);
  });

  it("weld() refuses a step under the opening of another mandate, and an opening with no K", async () => {
    const [base, capped] = [await pair("within cap"), await pair("exceed by one")];
    expect(() => weld(base.step, capped.mandate)).toThrow("the step's K is not the K of the mandate opening");
    expect(() => weld(capped.step, base.mandate)).toThrow("the step's K is not the K of the mandate opening");
    expect(() => weld(base.step, { commitment: base.mandate.commitment! })).toThrow("the mandate opening discloses no K");
    expect(() => weld({ ...base.step, atoms: new Uint8Array(31) }, base.mandate)).toThrow("the step's K is not the K of the mandate opening");
  });

  it("a step whose prover swaps in the atoms of another mandate discloses a K no opening of the event's mandate has", async () => {
    const c = caseOf("within cap");
    const world = worldOf(c);
    const [first] = await runCase(c);
    const opening = stepOpeningOf(first!, world);
    const lied = rederivedStep(opening, { context: { atoms: { ...opening.context.atoms, capAmount: 23n } } });
    const step = await runStep(lied) as Statement;
    const { mandate } = await pair("within cap");
    expect(() => weld(step, mandate)).toThrow("the step's K is not the K of the mandate opening");
  });
});

describe("T-C06 asset_ok holds exactly when the action's asset bytes are the mandate's", () => {
  it.each([["USD", "USD", 0, "st_pa"], ["usd", "USD", 3, "st_pd3"], ["USD", "usd", 3, "st_pd3"], ["usd", "usd", 0, "st_pa"], ["USD", "USd", 3, "st_pd3"]] as const)(
    "a mandate for %s and a payment in %s: the runtime decides %i and %s proves it", async (mandated, paid, verdict, circuit) => {
      const world = stepWorld({ ...STEP_FIXTURE.mandate, asset: mandated });
      const [step] = await traceWorld(world, [{ action: { kind: "payment", asset: paid, amount: 1n, counterparty: "acme", timestamp: 3n } }]);
      expect(step!.verdict).toBe(verdict);
      const opening = stepOpeningOf(step!, world);
      expect(opening.circuit).toBe(circuit);
      expect((await runStep(opening) as Statement).verdict).toBe(BigInt(verdict));
    });

  it("the allowed class refuses the same payment once one asset byte changes case, and the denial class refuses it once the bytes agree", async () => {
    const world = stepWorld(STEP_FIXTURE.mandate);
    const text = (s: string) => new TextEncoder().encode(s);
    const [allowed] = await traceWorld(world, [{ action: { kind: "payment", asset: "USD", amount: 1n, counterparty: "acme", timestamp: 3n } }]);
    const [denied] = await traceWorld(world, [{ action: { kind: "payment", asset: "usd", amount: 1n, counterparty: "acme", timestamp: 3n } }]);
    expect(await stepOutcome(rederivedStep(stepOpeningOf(allowed!, world), { segments: { asset: text("usd") } }))).toBe("failed assert: verdict mismatch");
    expect(await stepOutcome(rederivedStep(stepOpeningOf(denied!, world), { segments: { asset: text("USD") } }))).toBe("failed assert: verdict mismatch");
  });
});
