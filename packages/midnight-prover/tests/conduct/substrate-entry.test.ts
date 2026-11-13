import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const { primitives }: { primitives: { id: string; desc: string; paths: string[]; consumes: string[] }[] } = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../substrate.json"), "utf8"));
const entry = primitives.find(p => p.id === "conduct-circuits");

// The substrate registry cuts a desc at 2,000 characters in SUBSTRATE.md and at 500 in its JSON projection.
describe("the conduct-circuits registry entry", () => {
  it("fits the registry, with the scope and non-claims of the verdict and the openings inside the JSON projection", () => {
    expect(entry).toBeDefined();
    expect(entry!.desc.length).toBeLessThanOrEqual(2000);
    const late = [
      "Prototype", "not deployed", "ABI not frozen", "unauthenticated", "no key or proof", "D12", "assetTag",
      "out-of-class bytes refused", "chain continuity and anchoring assumed", "K carries no authority",
    ].filter(phrase => !entry!.desc.slice(0, 500).includes(phrase));
    expect(late).toEqual([]);
  });

  it("counts the compiled event classes and their kinds from classes.json, and moves statement fields by one, not byte by byte", () => {
    const { openings }: { openings: { events: Record<string, { kind: string }> } } = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../circuits/conduct/classes.json"), "utf8"));
    const events = Object.values(openings.events);
    expect(entry!.desc).toContain(`${events.length} compiled classes of ${new Set(events.map(e => e.kind)).size} kinds`);
    expect(entry!.desc).toContain("every statement field moved by one");
  });

  it("counts the step classes from classes.json and states what a step leaves assumed, refused and unclaimed", () => {
    const { steps }: { steps: Record<string, unknown> } = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../circuits/conduct/classes.json"), "utf8"));
    expect(entry!.desc).toContain(`st_* step circuits (${Object.keys(steps).length} classes)`);
    const missing = [
      "a stated prior spend", "verdicts 5 and 7 (non-membership) are refused, not accepted",
      "Prior spend, chain continuity, root authenticity and the K weld to a mandate opening are stated assumptions", "no cumulative or whole-run claim",
      "count and index gaps pinned", "only circuits with installed pinned parameters",
    ].filter(phrase => !entry!.desc.includes(phrase));
    expect(missing).toEqual([]);
  });

  it("names the opening and bench sources and the process-trace hub they read", () => {
    expect(entry!.paths).toContain("packages/midnight-prover/scripts/conduct");
    expect(entry!.paths).toContain("packages/midnight-prover/bench/conduct");
    expect(entry!.consumes).toContain("process-trace");
  });
});
