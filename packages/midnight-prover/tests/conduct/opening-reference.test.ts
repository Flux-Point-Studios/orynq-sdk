import { describe, expect, it, vi } from "vitest";
import { auditOpenings, openingSources } from "./structure.js";

const RULE = "payment exceeds the remaining window spend cap";
const MISWRITTEN = "payment exceeds the remaining spend cap";

// A template whose spend-cap rule is miswritten, so its renderer writes the same preimage the emitter would.
vi.mock("../../scripts/conduct/template.mjs", async importOriginal => {
  const template: { render: (classified: unknown) => string } = await importOriginal();
  return { ...template, render: (classified: unknown) => template.render(classified).replace(RULE, MISWRITTEN) };
});

describe("T-A16 (AM-8) the reference takes each event preimage from the producers, not from the template", () => {
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
});
