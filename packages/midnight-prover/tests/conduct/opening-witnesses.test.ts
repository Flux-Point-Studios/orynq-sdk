import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLASSES } from "../../scripts/conduct/template.mjs";
import { unitDir } from "./harness.js";
import { OPENINGS_UNIT, privateInputs, witnessFunctions, witnessWidth } from "./openings.js";

const CIRCUITS = [...Object.keys(CLASSES.openings.events), ...Object.keys(CLASSES.openings.mandates)];

// A second read of a witness is a private input of its own, which the hashed bytes do not bind. A test witness that
// answered it again would hide such a read, so every opening test runs with witnesses that refuse it.
describe("T-B19 every opening circuit reads each witness once", () => {
  it("the test witnesses refuse a second read of any witness in one circuit run", () => {
    const read = witnessFunctions({ ev_x_amount: Uint8Array.of(0x35) }) as Record<string, (context: { privateState: unknown }) => unknown>;
    expect(read.ev_x_amount!({ privateState: "p" })).toEqual(["p", [0x35n]]);
    expect(() => read.ev_x_amount!({ privateState: "p" })).toThrow("witness ev_x_amount read twice");
  });

  it("the unit under test compiles one circuit per class", () => {
    const compiled = readdirSync(join(unitDir(OPENINGS_UNIT), "zkir")).filter(name => name.endsWith(".zkir")).map(name => name.slice(0, -".zkir".length));
    expect(compiled.sort()).toEqual([...CIRCUITS].sort());
  });

  it.each(CIRCUITS)("%s: its ZKIR takes one private input per witness byte of its class", circuit => {
    expect(privateInputs(OPENINGS_UNIT, circuit)).toBe(witnessWidth(circuit));
  });
});
