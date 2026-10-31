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
const filesUnder = (dir: string, pattern: RegExp) =>
  readdirSync(join(pkg, dir), { recursive: true, encoding: "utf8" }).filter(name => pattern.test(name)).map(name => `${dir}/${name}`);

describe("conduct circuit pins", () => {
  it("pin the compiler toolchain", () => {
    expect(pins().toolchain).toEqual({ compactc: "0.31.1", language: "0.23.0", runtime: "0.16.0", zkir: "midnight-zkir 2.1.0" });
  });

  it("pin the SHA-256 of every conduct circuit source", () => {
    const sources = [
      ...filesUnder("circuits/conduct", /^(?!pins\.json$).*\.(compact|json)$/),
      ...filesUnder("bench/conduct/reference", /\.compact$/),
    ].sort();
    expect(sources.length).toBeGreaterThan(0);
    expect(Object.keys(pins().sources)).toEqual(sources);
    for (const path of sources) expect(pins().sources[path], path).toBe(sha256(path));
  });

  it("pin exactly the predicate unit and its one provable circuit", () => {
    expect(Object.keys(pins().units)).toEqual(["predicate"]);
    expect(Object.keys(pins().units.predicate!.circuits)).toEqual(["check_verdict"]);
  });

  it("the compiled predicate unit under test carries the pinned ZKIR", () => {
    const ir = relative(pkg, join(unitDir("predicate"), "zkir/check_verdict.zkir"));
    expect(existsSync(join(pkg, ir)), "conduct circuits not compiled: run pnpm --filter @fluxpointstudios/orynq-sdk-midnight-prover build:circuits").toBe(true);
    expect(sha256(ir)).toBe(pins().units.predicate!.circuits.check_verdict!.zkirSha256);
  });

  it("T-A15: pin that exporting the pure circuits leaves the provable circuit's ZKIR unchanged", () => {
    expect(pins().units.predicate!.pureExportInvariant).toBe(true);
  });

  it("pin k, rows, an op histogram and the ZKIR hash of every circuit", () => {
    for (const [unit, { circuits }] of Object.entries(pins().units)) {
      for (const [name, pin] of Object.entries(circuits)) {
        const label = `${unit}/${name}`;
        expect(Number.isInteger(pin.k), label).toBe(true);
        expect(Number.isInteger(pin.rows), label).toBe(true);
        expect(Number.isInteger(pin.ops.total), label).toBe(true);
        expect(Number.isInteger(pin.ops.persistent_hash), label).toBe(true);
        expect(pin.zkirSha256, label).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});
