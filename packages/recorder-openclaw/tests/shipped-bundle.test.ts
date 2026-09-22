/**
 * Runs every .probe.mjs against the SHIPPED bundle, and refuses to run at all
 * against a stale one.
 *
 * Both halves matter. The freshness guard exists because a bundle older than
 * src means the probes are testing yesterday's code while reporting on today's
 * — which is how the earlier suites stayed green against a restored bug. The
 * non-empty guard exists because a glob that matches nothing passes, and green
 * by absence reads exactly like green by correctness.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(pkgRoot, "dist", "index.js");
const probeDir = join(pkgRoot, "test");

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
  );

describe("the shipped bundle", () => {
  it("exists — run `pnpm build` first", () => {
    expect(existsSync(bundle), `missing ${bundle}`).toBe(true);
  });

  it("is newer than every source file, so probes cannot test a stale build", () => {
    const built = statSync(bundle).mtimeMs;
    const stale = walk(join(pkgRoot, "src"))
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => statSync(f).mtimeMs > built)
      .map((f) => f.slice(pkgRoot.length + 1));
    expect(stale, `source newer than the bundle: ${stale.join(", ")}`).toEqual([]);
  });
});

const probes = existsSync(probeDir)
  ? readdirSync(probeDir).filter((f) => f.endsWith(".probe.mjs")).sort()
  : [];

describe("bundle probes", () => {
  it("there is at least one probe — an empty glob passes, which is the bug", () => {
    expect(probes.length).toBeGreaterThan(0);
  });

  // The contract is the EXIT CODE: execFileSync throws on non-zero, so a
  // failing probe fails this test with its own output attached.
  //
  // An earlier version also asserted the output contained "ALL TESTS PASS".
  // That was the wording of one probe, and it failed four probes that were
  // passing perfectly well while printing "ALL PASS", "51 passed, 0 failed"
  // and a summary block. A harness must not encode one probe's prose.
  //
  // What IS worth asserting beyond the exit code: that the probe said
  // something, and that nothing in it announced a failure — so a probe that
  // exits 0 while printing FAIL lines cannot slip through.
  it.each(probes)("%s exits 0 against dist/index.js", (name) => {
    const out = execFileSync(process.execPath, [join(probeDir, name)], {
      encoding: "utf-8",
      timeout: 90_000
    });
    expect(out.trim().length, `${name} produced no output`).toBeGreaterThan(0);
    const failed = out.split("\n").filter((l) => /^\s*FAIL\b/.test(l));
    expect(failed, `${name} printed FAIL lines but exited 0`).toEqual([]);
  });
});
