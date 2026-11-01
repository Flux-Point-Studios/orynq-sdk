import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const { primitives }: { primitives: { id: string; desc: string; paths: string[]; consumes: string[] }[] } = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../substrate.json"), "utf8"));
const entry = primitives.find(p => p.id === "conduct-circuits");

// The substrate registry cuts a desc at 2,000 characters in SUBSTRATE.md and at 500 in its JSON projection.
describe("the conduct-circuits registry entry", () => {
  it("fits the registry, with its scope and non-claims inside the JSON projection", () => {
    expect(entry).toBeDefined();
    expect(entry!.desc.length).toBeLessThanOrEqual(2000);
    const late = ["Prototype", "not deployed", "ABI not frozen", "unauthenticated", "no key or proof", "D12", "assetTag"]
      .filter(phrase => !entry!.desc.slice(0, 500).includes(phrase));
    expect(late).toEqual([]);
  });

  it("names the opening sources, the process-trace hub they read, and the openings' non-claims", () => {
    expect(entry!.paths).toContain("packages/midnight-prover/scripts/conduct");
    expect(entry!.consumes).toContain("process-trace");
    expect(entry!.desc).toContain("chain continuity and anchoring are assumed, and K carries no authority");
  });
});
