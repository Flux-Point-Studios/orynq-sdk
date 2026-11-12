import { describe, expect, it, vi } from "vitest";
import { honestEvents, lexicalForgeries, openingOf } from "./openings.js";
import { auditOpenings, openingSources } from "./structure.js";

const RULE = "payment exceeds the remaining window spend cap";
const MISWRITTEN = "payment exceeds the remaining spend cap";

type Spec = { readonly v?: string; readonly lex?: string; readonly max?: number; readonly nonzero?: boolean };
// Every value without a floor, which only the payment amount has, and the trace sequence as any uint64.
const { loosened } = vi.hoisted(() => ({
  loosened: ({ nonzero: _floor, ...spec }: Spec): Spec => (spec.v === "traceSeq" ? { ...spec, lex: "dec64", max: 20 } : spec),
}));

// A template whose spend-cap rule is miswritten and whose amount floor and trace sequence class are loosened, so its
// renderer writes the preimages, and its value specs the classes, that the emitter would write from it.
vi.mock("../../scripts/conduct/template.mjs", async importOriginal => {
  const template: {
    render: (classified: unknown) => string;
    valueSpecs: (kind: string) => Map<string, Spec>;
    TEMPLATE: { actions: Record<string, Spec[]> };
  } = await importOriginal();
  return {
    ...template,
    render: (classified: unknown) => template.render(classified).replace(RULE, MISWRITTEN),
    valueSpecs: (kind: string) => new Map([...template.valueSpecs(kind)].map(([name, spec]) => [name, loosened(spec)])),
    TEMPLATE: { ...template.TEMPLATE, actions: Object.fromEntries(Object.entries(template.TEMPLATE.actions).map(([action, parts]) => [action, parts.map(loosened)])) },
  };
});

const events = await honestEvents();

describe("T-A16 (AM-8) the reference and the forgeries hold each event to the producers and the audited classes, not to the template", () => {
  it("refuses an event class the emitter wrote from a miswritten template, which the template's renderer agrees with", () => {
    const sources = openingSources();
    const generated = sources["openings.generated.compact"];
    const at = generated.indexOf("export circuit ev_pd4_ascii_min(");
    const miswritten = generated.slice(at).replace(RULE, MISWRITTEN).replace("Bytes<95>", `Bytes<${95 - RULE.length + MISWRITTEN.length}>`);
    const findings = auditOpenings({ ...sources, "openings.generated.compact": generated.slice(0, at) + miswritten });
    expect(findings.map(finding => finding.slice(0, finding.indexOf(":")))).toEqual([
      "ev_pd4_ascii_min calls differ from the audited list",
      "ev_pd4_ascii_min differs from its audited statement list at line 14",
    ]);
  });

  it("holds the committed openings, with their amount floor and dec53 trace sequence, to exactly the audited structure", () => {
    expect(auditOpenings(openingSources())).toEqual([]);
  });

  it("forges a zero amount and an exponent in the trace sequence, which the loosened template's classes would not", () => {
    const forged = lexicalForgeries(openingOf(events.get("ev_pa_ascii_min")!)).forgeries.map(f => [f.label, f.refusal]);
    expect(forged).toEqual(expect.arrayContaining([
      ["amount of zero", "failed assert: decimal nonzero"],
      ["traceSeq with an exponent e", "failed assert: decimal digit"],
    ]));
  });
});
