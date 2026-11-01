import { describe, expect, it } from "vitest";
import { CLASSES } from "../../scripts/conduct/template.mjs";
import { zkCheck } from "./harness.js";
import { crafted, fieldForgeries, HONEST_MANDATES, mandateOpeningOf, mandateOutcome, runMandateOpening, type MandateOpening } from "./mandates.js";
import { misjudged, OPENINGS_UNIT, witnessFunctions, type Forgery } from "./openings.js";

const opening = (name: string) => mandateOpeningOf(HONEST_MANDATES.find(([n]) => n === name)![1]);
const base = opening("base allowlist-egress mandate");
const step = opening("the step mandate");
const byClass = new Map(HONEST_MANDATES.map(([, cbor, id]) => [id!, mandateOpeningOf(cbor)] as const));

const schema = (label: string, forged: MandateOpening, refusal: string): Forgery<MandateOpening> => ({ label, opening: forged, refusal: `failed assert: ${refusal}` });
const SCHEMA_RULES: readonly Forgery<MandateOpening>[] = [
  schema("notBefore equal to notAfter", crafted(base, { notBefore: base.segments.notAfter! }), "mandate validity window"),
  schema("notBefore after notAfter", crafted(base, { notBefore: base.segments.notAfter!, notAfter: base.segments.notBefore! }), "mandate validity window"),
  schema("a window of 0", crafted(step, { windowSeconds: Uint8Array.of(0) }), "mandate window"),
  schema("egress mode 2", crafted(step, { egressMode: Uint8Array.of(2) }), "egress mode"),
  schema("deny-all with a non-zero root", crafted(base, { egressMode: Uint8Array.of(0) }), "deny-all egress root"),
  schema("a threshold above the committee size", crafted(step, { threshold: Uint8Array.of(2) }), "mandate disclosure threshold"),
  schema("a threshold of 0", crafted(step, { threshold: Uint8Array.of(0) }), "mandate disclosure threshold"),
];

describe("T-B15 the mandate circuits refuse CBOR crafted past the codec", () => {
  it.each([["base", base], ["step", step]] as const)("control: the honest %s mandate opens at JS and checks at ZKIR", async (_name, o) => {
    await expect(runMandateOpening(o)).resolves.toEqual(o.statement);
    await expect(zkCheck(OPENINGS_UNIT, o.circuit, witnessFunctions(o.witnesses), [o.statement])).resolves.toMatchObject({ mandateOpening: o.statement });
  });

  it("has an honest opening of every compiled class", () => {
    expect([...byClass.keys()].sort()).toEqual(Object.keys(CLASSES.openings.mandates).sort());
  });

  it("refuses each schema rule's breach at JS", async () => {
    expect(await misjudged(SCHEMA_RULES, mandateOutcome), "invalid mandate opened").toEqual([]);
  });

  it.each([...byClass])("%s: refuses out-of-class bytes in every DID, the asset, the committee id and every uint field at JS", async (_id, o) => {
    const forgeries = fieldForgeries(o);
    expect(forgeries.length).toBeGreaterThanOrEqual(8 + 2 + 2 + 6);
    expect(await misjudged(forgeries, mandateOutcome), "invalid mandate opened").toEqual([]);
  });

  it.each([...SCHEMA_RULES, ...fieldForgeries(base), ...fieldForgeries(step)].map(f => [`${f.opening.circuit}: ${f.label}`, f.opening] as const))("ZKIR refuses %s", async (_label, o) => {
    const checked = await zkCheck(OPENINGS_UNIT, o.circuit, witnessFunctions(o.witnesses), [o.statement]).then(() => "invalid mandate opened", (error: Error) => error.message);
    expect(checked).toMatch(/Failed direct assertion/);
  });
});
