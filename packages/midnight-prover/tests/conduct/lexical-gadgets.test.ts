import { describe, expect, it } from "vitest";
import { loadUnit } from "./harness.js";
import { describeDisagreement, disagreements, GADGET_CLASSES } from "./lexical.js";
import { OPENINGS_UNIT } from "./openings.js";

const { pureCircuits } = await loadUnit(OPENINGS_UNIT);

describe("T-B18 every lexical gadget judges its whole input class as its reference does", () => {
  it.each(GADGET_CLASSES.map(c => [c.probe, c] as const))("%s", (_probe, c) => {
    expect(disagreements(pureCircuits, c, 20).map(d => describeDisagreement(c, d))).toEqual([]);
  });
});
