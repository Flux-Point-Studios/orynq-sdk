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

  it("pin exactly the predicate and openings units, and one provable circuit per verdict and compiled class", () => {
    const { events, mandates } = JSON.parse(readFileSync(join(pkg, "circuits/conduct/classes.json"), "utf8")).openings;
    expect(Object.keys(pins().units)).toEqual(["predicate", "openings"]);
    expect(Object.keys(pins().units.predicate!.circuits)).toEqual(["check_verdict"]);
    expect(Object.keys(pins().units.openings!.circuits)).toEqual([...Object.keys(events), ...Object.keys(mandates)].sort());
  });

  it.each(["predicate", "openings"])("the compiled %s unit under test carries the pinned ZKIR", unit => {
    for (const [name, pin] of Object.entries(pins().units[unit]!.circuits)) {
      const ir = relative(pkg, join(unitDir(unit), `zkir/${name}.zkir`));
      expect(existsSync(join(pkg, ir)), "conduct circuits not compiled: run pnpm --filter @fluxpointstudios/orynq-sdk-midnight-prover build:conduct").toBe(true);
      expect(sha256(ir), `${unit}/${name}`).toBe(pin.zkirSha256);
    }
  });

  // compile-conduct writes this only after an unexported recompile yielded identical ZKIR; it refuses otherwise, which
  // compile-conduct.test.ts exercises with a perturbing compiler.
  it.each(["predicate", "openings"])("T-A15: pin that exporting the %s unit's pure circuits leaves its provable circuits' ZKIR unchanged", unit => {
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
