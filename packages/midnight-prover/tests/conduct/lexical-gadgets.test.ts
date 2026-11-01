import { describe, expect, it } from "vitest";
import { loadUnit } from "./harness.js";
import { DECIMAL_WIDTHS, describeDisagreement, disagreements, GADGET_CLASSES, UTF8_CLASSES, UTF8_EDGES, utf8Inputs } from "./lexical.js";
import { OPENINGS_UNIT } from "./openings.js";
import { AUDITED_GADGETS } from "./structure.js";

const { pureCircuits } = await loadUnit(OPENINGS_UNIT);

describe("T-B18 every lexical gadget judges its whole input class as its reference does", () => {
  it.each(GADGET_CLASSES.map(c => [c.probe, c] as const))("%s", (_probe, c) => {
    expect(disagreements(pureCircuits, c, 20).map(d => describeDisagreement(c, d))).toEqual([]);
  });

  it("judges decU64 and dec53 at every width the generated openings instantiate them", () => {
    expect(DECIMAL_WIDTHS).toEqual({ decU64: [1, 2, 10, 16, 20], dec53: [1, 16] });
    expect(GADGET_CLASSES.map(c => c.probe).filter(probe => /^dec/.test(probe))).toEqual([
      ...DECIMAL_WIDTHS.decU64.map(width => `dec_u64_w${width}`), ...DECIMAL_WIDTHS.dec53.map(width => `dec53_w${width}`),
    ]);
  });

  // Each class is one edge or a run between two, so every comparison of the automaton, and the reference's judgement,
  // is the same for every byte of a class.
  it("splits the bytes at every literal the UTF-8 automaton compares a byte with, and at every bound of Unicode Table 3-7 and of JSON's raw bytes", () => {
    const literals = ["ConductGadgets.utf8Next", "ConductGadgets.jsonStep", "ConductGadgets.anyStep"].flatMap(name => AUDITED_GADGETS[name]!.literals).map(Number);
    expect(UTF8_EDGES).toEqual([...new Set(literals.filter(n => n > 8))].sort((a, b) => a - b));
    expect(UTF8_CLASSES.flat()).toEqual(Array.from({ length: 256 }, (_, b) => b));
    expect(UTF8_CLASSES.map(c => c[0])).toEqual(expect.arrayContaining([
      0x20, 0x22, 0x23, 0x5c, 0x5d, 0x80, 0x90, 0xa0, 0xc0, 0xc2, 0xe0, 0xe1, 0xed, 0xee, 0xf0, 0xf1, 0xf4, 0xf5,
    ]));
  });

  it.each([1, 2, 3, 4])("the UTF-8 probes of width %i meet every sequence of byte classes", width => {
    const classOf = new Map(UTF8_CLASSES.flatMap((c, i) => c.map(b => [b, i] as const)));
    const seen = new Set<string>();
    for (const bytes of utf8Inputs(width)) seen.add(bytes.map(b => classOf.get(b)).join(","));
    expect(seen.size).toBe(UTF8_CLASSES.length ** width);
  });
});
