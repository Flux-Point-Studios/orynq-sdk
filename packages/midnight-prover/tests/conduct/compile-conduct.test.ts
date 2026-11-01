import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const pkg = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(tmpdir(), "conduct-compile-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const compile = (root: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, [join(root, "scripts/compile-conduct.mjs"), ...args], { encoding: "utf8", env: { ...process.env, ...env } });

const shipped: string[] = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).files;

// The copy holds only paths the npm tarball ships, so the script reads nothing a published package lacks.
function packageCopy(): string {
  const root = mkdtempSync(join(scratch, "pkg-"));
  for (const path of ["scripts/compile-conduct.mjs", "circuits/conduct"]) {
    expect(shipped.some(entry => path === entry || path.startsWith(`${entry}/`)), `${path} ships in the npm tarball`).toBe(true);
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

const editPins = (root: string, edit: (pins: { sources: Record<string, string>; units: Record<string, { circuits: Record<string, { rows: number }> }> }) => void) =>
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

  it.each([
    ["a misspelled --units", ["--check", "--unit", "predicate"]],
    ["the unbuilt --keys", ["--check", "--keys"]],
    ["a second --units", ["--check", "--units", "predicate", "--units", "mutants"]],
    ["--units without a list", ["--check", "--units"]],
    ["both --check and --write", ["--check", "--write"]],
    ["neither --check nor --write", ["--units", "predicate"]],
  ])("rejects %s with the usage text", (_label, args) => {
    const result = compile(packageCopy(), args);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("usage: compile-conduct.mjs --write|--check [--units predicate,mutants,reference]");
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

  it("treats a repeated unit as one, so a partial --write keeps the pins of the units it skips", () => {
    const root = packageCopy();
    const noMutants = "[]\n";
    writeFileSync(join(root, "circuits/conduct/mutants.json"), noMutants);
    editPins(root, pins => { pins.sources["circuits/conduct/mutants.json"] = createHash("sha256").update(noMutants).digest("hex"); });
    const pinsFile = join(root, "circuits/conduct/pins.json");
    const before = readFileSync(pinsFile, "utf8");
    const result = compile(root, ["--write", "--units", "mutants,mutants"]);
    expect(result.stderr).toBe("");
    expect(readFileSync(pinsFile, "utf8")).toBe(before);
    expect(existsSync(join(root, "conduct-managed/reference")), "the mutants unit builds no PoAC reference").toBe(false);
  });

  it("builds the PoAC reference contract as its own unit, which pins nothing", () => {
    const root = packageCopy();
    const pinsFile = join(root, "circuits/conduct/pins.json");
    const before = readFileSync(pinsFile, "utf8");
    const result = compile(root, ["--write", "--units", "reference"]);
    expect(result.stderr).toBe("");
    expect(existsSync(join(root, "conduct-managed/reference/poac/contract/index.js"))).toBe(true);
    expect(existsSync(join(root, "conduct-managed/mutants"))).toBe(false);
    expect(readFileSync(pinsFile, "utf8")).toBe(before);
  });

  it("refuses a partial --write once the sources have changed, so skipped pins cannot go stale", () => {
    const root = packageCopy();
    editFile(root, "circuits/conduct/predicate.compact", text => text.replace("return CV_decide(enforced_at, not_before, not_after, cap_amount, egress_mode, action_kind, action_timestamp, action_amount,\n    cap_asset == action_asset", "return CV_decide(enforced_at, not_before, not_after, cap_amount, egress_mode, action_kind, action_timestamp, action_amount,\n    cap_asset != action_asset"));
    const result = compile(root, ["--write", "--units", "mutants"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("sources changed since pins.json was written; run --write without --units");
  });
});

const compactc = process.env.COMPACTC ?? "compactc";
const zkir = process.env.ZKIR ?? (process.env.COMPACTC ? join(dirname(process.env.COMPACTC), "zkir") : "zkir");
// Runs the real compiler, then changes the output of any compile whose source exports no pure circuit: a stand-in for a
// compiler whose provable circuits depend on which pure circuits are exported.
const perturbingCompiler = join(scratch, "perturbing-compactc");
writeFileSync(perturbingCompiler, [
  "#!/bin/sh",
  '"$REAL_COMPACTC" "$@" || exit $?',
  '[ "$1" = --skip-zk ] && ! grep -q "^export pure circuit " "$2" || exit 0',
  'case "$PERTURB" in extra) cp "$3/zkir/check_verdict.zkir" "$3/zkir/extra.zkir" ;; bytes) printf " " >> "$3/zkir/check_verdict.zkir" ;; esac',
  "",
].join("\n"));
chmodSync(perturbingCompiler, 0o755);

describe("compile-conduct --check measures export invariance with a second, unexported compile", () => {
  it("refuses a predicate.compact that exports no pure circuit", () => {
    const root = packageCopy();
    editFile(root, "circuits/conduct/predicate.compact", text => text.replaceAll("export pure circuit ", "pure circuit "));
    const result = compile(root, ["--check", "--units", "predicate"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("predicate.compact exports no pure circuit");
  });

  const perturbed = (perturb: string) =>
    compile(packageCopy(), ["--check", "--units", "predicate"], { COMPACTC: perturbingCompiler, REAL_COMPACTC: compactc, ZKIR: zkir, PERTURB: perturb });

  it("control: the wrapper with no perturbation reproduces the pins", () => {
    const result = perturbed("none");
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Conduct circuits reproduce their pins");
  });

  it.each([
    ["bytes", "check_verdict.zkir depends on which pure circuits are exported"],
    ["extra", "the provable circuits depend on which pure circuits are exported"],
  ])("refuses an unexported compile whose ZKIR differs (%s)", (perturb, message) => {
    const result = perturbed(perturb);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });
});
