import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const index = fileURLToPath(new URL("../index.js", import.meta.url));

/** Type-checks `source` as a consumer of this package and returns its diagnostics' codes. */
function consumerDiagnostics(source: string): number[] {
  const dir = mkdtempSync(join(tmpdir(), "process-trace-consumer-"));
  try {
    const file = join(dir, "consumer.ts");
    writeFileSync(file, `import type { TraceBundlePublicView } from ${JSON.stringify(index)};\n${source}`);
    const program = ts.createProgram([file], {
      strict: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: true,
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    });
    return ts.getPreEmitDiagnostics(program, program.getSourceFile(file)).map((diagnostic) => diagnostic.code);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("TraceBundlePublicView redaction fields", () => {
  it("still type-checks consumers that read them", () => {
    expect(consumerDiagnostics(`
      export const policyOf = (view: TraceBundlePublicView): string | undefined => view.redactionPolicyId;
      export const rulesOf = (view: TraceBundlePublicView): string | undefined => view.redactionRulesHash;
    `)).toEqual([]);
  });

  it("refuses consumers that set them", () => {
    expect(consumerDiagnostics(`
      export const withPolicy = (view: TraceBundlePublicView): TraceBundlePublicView => ({ ...view, redactionPolicyId: "strict" });
      export const withRules = (view: TraceBundlePublicView): TraceBundlePublicView => ({ ...view, redactionRulesHash: "00" });
    `)).toEqual([2322, 2322]);
  });
});
