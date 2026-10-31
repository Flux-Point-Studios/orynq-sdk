import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const pkg = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(tmpdir(), "conduct-compile-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const compile = (root: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, [join(root, "scripts/compile-conduct.mjs"), ...args], { encoding: "utf8", env: { ...process.env, ...env } });

function packageCopy(): string {
  const root = mkdtempSync(join(scratch, "pkg-"));
  for (const path of ["scripts/compile-conduct.mjs", "circuits/conduct", "bench/conduct/reference"]) {
    cpSync(join(pkg, path), join(root, path), { recursive: true });
  }
  return root;
}

function editFile(root: string, path: string, edit: (text: string) => string): void {
  const file = join(root, path);
  const text = readFileSync(file, "utf8");
  const edited = edit(text);
  expect(edited, `edit of ${path}`).not.toBe(text);
  writeFileSync(file, edited);
}

const editPins = (root: string, edit: (pins: { units: Record<string, { circuits: Record<string, { rows: number }> }> }) => void) =>
  editFile(root, "circuits/conduct/pins.json", text => {
    const pins = JSON.parse(text);
    edit(pins);
    return `${JSON.stringify(pins, null, 2)}\n`;
  });

describe("compile-conduct refusals", () => {
  it("requires Compact compiler 0.31.1", () => {
    const fake = join(scratch, "compactc");
    writeFileSync(fake, "#!/bin/sh\necho 0.31.0\n");
    chmodSync(fake, 0o755);
    const result = compile(pkg, ["--check"], { COMPACTC: fake });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Compact compiler 0.31.1 is required");
  });

  it("rejects an unknown unit", () => {
    const result = compile(pkg, ["--check", "--units", "nope"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown conduct unit: nope");
  });

  it.each([
    ["matches nothing", "assert(no_such_text);"],
    ["matches twice", "return 0;"],
  ])("rejects a mutant whose find text %s", (_label, find) => {
    const root = packageCopy();
    writeFileSync(join(root, "circuits/conduct/mutants.json"), JSON.stringify([{ id: "bad", file: "verdict_core.compact", find, replace: "" }]));
    const result = compile(root, ["--check"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("mutant bad does not apply exactly once");
  });
});

describe("compile-conduct --check verifies every pin it keeps", () => {
  it("control: an untouched copy reproduces its pins", () => {
    const result = compile(packageCopy(), ["--check", "--units", "predicate"]);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Conduct circuits reproduce their pins");
  });

  it("refuses a changed pin of a unit it rebuilds", () => {
    const root = packageCopy();
    editPins(root, pins => { pins.units.predicate!.circuits.check_verdict!.rows += 1; });
    const result = compile(root, ["--check", "--units", "predicate"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Conduct circuits differ from their pins");
  });

  it("refuses pins for a unit it does not know", () => {
    const root = packageCopy();
    editPins(root, pins => { pins.units.openings = { circuits: { ev_pa_ascii_min: { rows: 4000 } } }; });
    const result = compile(root, ["--check"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("pins.json names unknown conduct unit: openings");
  });

  it("refuses a --check that would carry a pinned unit without rebuilding it", () => {
    const root = packageCopy();
    editPins(root, pins => { pins.units.predicate!.circuits.check_verdict!.rows += 1; });
    const result = compile(root, ["--check", "--units", "mutants"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--check must rebuild every pinned unit: predicate is not selected");
  });

  it("refuses a partial --write once the sources have changed, so skipped pins cannot go stale", () => {
    const root = packageCopy();
    editFile(root, "circuits/conduct/predicate.compact", text => text.replace("return CV_decide(enforced_at, not_before, not_after, cap_amount, egress_mode, action_kind, action_timestamp, action_amount,\n    cap_asset == action_asset", "return CV_decide(enforced_at, not_before, not_after, cap_amount, egress_mode, action_kind, action_timestamp, action_amount,\n    cap_asset != action_asset"));
    const result = compile(root, ["--write", "--units", "mutants"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("sources changed since pins.json was written; run --write without --units");
  });
});
