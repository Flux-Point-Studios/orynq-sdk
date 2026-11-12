import { describe, expect, it } from "vitest";
import { classCounts, TEMPLATE, valueSpecs } from "../../scripts/conduct/template.mjs";

// One circuit, and so one verifier key, per exact length tuple: the count of tuples is what an exact-class encoding
// costs. The figures are arithmetic over the template's bounds, never a measurement.
describe("T-C09 the exact-length classes a guard event template spans", () => {
  it("counts the v1 payment-action envelope, a realistic slice of it, the DID pairs of a mandate and the fixed-width candidate", () => {
    expect(classCounts()).toEqual({
      paymentActionEnvelope: 167_772_160_000n,
      paymentActionFixedTimesAndAsset: 3_276_800n,
      mandateDidPairs: 62_001n,
      fixedWidthPerTemplate: 32n,
    });
  });

  it("the envelope is the product of the template's own length bounds, the action time counted once", () => {
    const widths = (lex: string, max?: number) => (lex === "vis" ? 2n : BigInt(max!));
    const variable = [...valueSpecs("payment-action").values()].filter(s => !["hex64", "uuid", "iso24"].includes(s.lex!));
    expect(variable.map(s => s.v)).toEqual(["amount", "asset", "counterparty", "ts", "enforcedAt", "dataSeq", "traceSeq", "vis"]);
    expect(variable.reduce((n, s) => n * widths(s.lex!, s.max), 1n)).toBe(classCounts().paymentActionEnvelope);
    expect(20n * 128n * 256n * 20n * 20n * 20n * 16n * 2n).toBe(167_772_160_000n);
    expect(20n * 256n * 20n * 16n * 2n).toBe(3_276_800n);
    expect(249n ** 2n).toBe(62_001n);
    expect(TEMPLATE.version).toBe(1);
  });
});
