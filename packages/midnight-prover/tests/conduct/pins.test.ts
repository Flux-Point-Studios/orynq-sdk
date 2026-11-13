import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { unitDir } from "./harness.js";

interface CircuitPin { zkirSha256: string; k: number; rows: number; ops: Record<string, number> }
interface Pins {
  toolchain: Record<string, string>;
  sources: Record<string, string>;
  units: Record<string, { pureExportInvariant?: boolean; circuits: Record<string, CircuitPin> }>;
}

const pkg = resolve(import.meta.dirname, "../..");
const pins = (): Pins => JSON.parse(readFileSync(join(pkg, "circuits/conduct/pins.json"), "utf8"));
const sha256 = (path: string) => createHash("sha256").update(readFileSync(join(pkg, path))).digest("hex");

describe("conduct circuit pins", () => {
  it("pin the compiler toolchain", () => {
    expect(pins().toolchain).toEqual({ compactc: "0.31.1", language: "0.23.0", runtime: "0.16.0", zkir: "midnight-zkir 2.1.0" });
  });

  it("pin the SHA-256 of every conduct circuit source", () => {
    const sources = readdirSync(join(pkg, "circuits/conduct"), { recursive: true, encoding: "utf8" })
      .filter(name => /^(?!pins\.json$).*\.(compact|json)$/.test(name)).map(name => `circuits/conduct/${name}`).sort();
    expect(sources.length).toBeGreaterThan(0);
    expect(Object.keys(pins().sources)).toEqual(sources);
    for (const path of sources) expect(pins().sources[path], path).toBe(sha256(path));
  });

  it("pin exactly the predicate, openings and steps units, and one provable circuit per verdict and compiled class", () => {
    const { openings: { events, mandates }, steps } = JSON.parse(readFileSync(join(pkg, "circuits/conduct/classes.json"), "utf8"));
    expect(Object.keys(pins().units)).toEqual(["predicate", "openings", "steps"]);
    expect(Object.keys(pins().units.predicate!.circuits)).toEqual(["check_verdict"]);
    expect(Object.keys(pins().units.openings!.circuits)).toEqual([...Object.keys(events), ...Object.keys(mandates)].sort());
    expect(Object.keys(pins().units.steps!.circuits)).toEqual(Object.keys(steps).sort());
  });

  it.each(["predicate", "openings", "steps"])("the compiled %s unit under test carries the pinned ZKIR", unit => {
    for (const [name, pin] of Object.entries(pins().units[unit]!.circuits)) {
      const ir = relative(pkg, join(unitDir(unit), `zkir/${name}.zkir`));
      expect(existsSync(join(pkg, ir)), "conduct circuits not compiled: run pnpm --filter @fluxpointstudios/orynq-sdk-midnight-prover build:conduct").toBe(true);
      expect(sha256(ir), `${unit}/${name}`).toBe(pin.zkirSha256);
    }
  });

  // compile-conduct writes this only after an unexported recompile yielded identical ZKIR; it refuses otherwise, which
  // compile-conduct.test.ts exercises with a perturbing compiler.
  it.each(["predicate", "openings", "steps"])("T-A15: pin that exporting the %s unit's pure circuits leaves its provable circuits' ZKIR unchanged", unit => {
    expect(pins().units[unit]!.pureExportInvariant).toBe(true);
  });

  it("pin k, rows, an op histogram and the ZKIR hash of every circuit", () => {
    for (const [unit, { circuits }] of Object.entries(pins().units)) {
      for (const [name, pin] of Object.entries(circuits)) {
        const label = `${unit}/${name}`;
        expect(Object.keys(pin), label).toEqual(["zkirSha256", "k", "rows", "ops"]);
        expect(Number.isInteger(pin.k), label).toBe(true);
        expect(Number.isInteger(pin.rows), label).toBe(true);
        expect(Number.isInteger(pin.ops.total), label).toBe(true);
        expect(Number.isInteger(pin.ops.persistent_hash), label).toBe(true);
        expect(pin.zkirSha256, label).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});

interface BenchPins { toolchain: Record<string, string>; sources: Record<string, string>; groups: Record<string, { circuits: Record<string, CircuitPin> }> }
const benchPins = (): BenchPins => JSON.parse(readFileSync(join(pkg, "bench/conduct/pins.json"), "utf8"));
const readme = readFileSync(join(pkg, "circuits/conduct/README.md"), "utf8");
const grouped = (n: number) => n.toLocaleString("en-US");

describe("the bench pins and the sizes the README states", () => {
  it("the bench pins hold the conduct toolchain, every conduct source and the bench's own sources, and one group per group of bench.json", () => {
    const { groups }: { groups: Record<string, { circuits: Record<string, unknown> }> } = JSON.parse(readFileSync(join(pkg, "bench/conduct/bench.json"), "utf8"));
    expect(benchPins().toolchain).toEqual(pins().toolchain);
    expect(benchPins().sources).toEqual({
      ...pins().sources, ...Object.fromEntries(["bench/conduct/bench.json", "scripts/conduct/bench.mjs", "scripts/conduct/template.mjs"].map(path => [path, sha256(path)])),
    });
    expect(Object.keys(benchPins().groups)).toEqual(Object.keys(groups));
    for (const [group, { circuits }] of Object.entries(groups)) expect(Object.keys(benchPins().groups[group]!.circuits), group).toEqual(Object.keys(circuits).sort());
  });

  // The README's tables are written from the pins; a re-pin that moves a size must move its row.
  it("the README states the pinned k, rows and hash count of every step and bench circuit, and the two sizes its comparisons start from", () => {
    const stated = [...Object.entries(pins().units.steps!.circuits), ...Object.values(benchPins().groups).flatMap(({ circuits }) => Object.entries(circuits))];
    expect(stated.length).toBeGreaterThan(30);
    const missing = stated.filter(([name, pin]) => !new RegExp(String.raw`^\| \`${name}\` \| [^|]+ \| ${pin.k} \| ${grouped(pin.rows)} \| ${pin.ops.persistent_hash} \|$`, "m").test(readme)).map(([name]) => name);
    expect(missing).toEqual([]);
    expect(readme).toContain(`\`ev_pa_ascii_min\` (${grouped(pins().units.openings!.circuits.ev_pa_ascii_min!.rows)} rows) and \`st_pa\` (${grouped(pins().units.steps!.circuits.st_pa!.rows)} rows)`);
  });
});
