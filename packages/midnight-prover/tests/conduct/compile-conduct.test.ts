import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { OPENINGS_MUTANTS } from "./openings.js";

const pkg = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(tmpdir(), "conduct-compile-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const compile = (root: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, [join(root, "scripts/compile-conduct.mjs"), ...args], { encoding: "utf8", env: { ...process.env, ...env } });

const shipped: string[] = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).files;

// The copy holds only paths the npm tarball ships, so the script reads nothing a published package lacks.
function packageCopy(): string {
  const root = mkdtempSync(join(scratch, "pkg-"));
  for (const path of ["scripts/compile-conduct.mjs", "scripts/conduct", "circuits/conduct"]) {
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

// A copy that pins only the predicate unit, so a --check of that unit alone rebuilds every pin it keeps.
function predicateCopy(): string {
  const root = packageCopy();
  editPins(root, pins => { delete pins.units.openings; });
  return root;
}

// Mutants edit predicate.compact, so a copy whose predicate.compact a test edits carries an empty mutant list, pinned.
function withoutMutants(root: string): void {
  const none = "[]\n";
  writeFileSync(join(root, "circuits/conduct/mutants.json"), none);
  editPins(root, pins => { pins.sources["circuits/conduct/mutants.json"] = createHash("sha256").update(none).digest("hex"); });
}

// vitest reads the source map of every compiled unit it loads and warns once per map whose sources do not resolve; it
// skips a virtual source, which only compactc's built-in standard library is.
describe("compile-conduct output", () => {
  it("every compiled unit's source map names source files that exist", () => {
    const managed = join(pkg, "conduct-managed");
    const maps = readdirSync(managed, { recursive: true, encoding: "utf8" }).filter(name => name.endsWith("/contract/index.js.map"));
    expect(maps.length).toBeGreaterThan(0);
    const missing = maps.flatMap(name => {
      const file = join(managed, name);
      const map: { sourceRoot?: string; sources: string[] } = JSON.parse(readFileSync(file, "utf8"));
      return map.sources.filter(source => source !== "virtual:compiler/standard-library.compact")
        .map(source => resolve(dirname(file), map.sourceRoot ?? "", source)).filter(path => !existsSync(path)).map(path => `${name}: ${path}`);
    });
    expect(missing).toEqual([]);
  });

  // Only the predicate mutants are checked at ZKIR; the openings mutants are judged by their generated JS.
  it("mock-compiles no openings mutant", () => {
    for (const id of OPENINGS_MUTANTS) expect(readdirSync(join(pkg, "conduct-managed/mutants", id, "zkir")).filter(name => name.endsWith(".bzkir")), id).toEqual([]);
  });
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
    expect(result.stderr).toContain("usage: compile-conduct.mjs --write|--check [--units predicate,openings,mutants,reference]");
  });

  it("rejects an unknown unit", () => {
    const result = compile(pkg, ["--check", "--units", "nope"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown conduct unit: nope");
  });

  it("rejects a mutant that edits a file outside the compiled units' sources", () => {
    const root = packageCopy();
    writeFileSync(join(root, "circuits/conduct/mutants.json"), JSON.stringify([{ id: "elsewhere", file: "reference/poac_verdict_core.compact", find: "return 6;", replace: "return 7;" }]));
    const result = compile(root, ["--check"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("mutant elsewhere must edit one of predicate.compact, verdict_core.compact, openings.generated.compact");
  });

  // Each mutant compiles into conduct-managed/mutants/<id>/, so a repeated id would overwrite the earlier mutant.
  it("rejects a repeated mutant id", () => {
    const root = packageCopy();
    writeFileSync(join(root, "circuits/conduct/mutants.json"), JSON.stringify([
      { id: "dup", file: "verdict_core.compact", find: "if (action_timestamp >= not_after) { return 2; }", replace: "if (action_timestamp > not_after) { return 2; }" },
      { id: "dup", file: "verdict_core.compact", find: "if (egress_mode == 0) { return 6; }", replace: "if (egress_mode == 1) { return 6; }" },
    ]));
    const result = compile(root, ["--check"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("mutant id dup is repeated");
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

describe("compile-conduct regenerates the opening circuits from the template and classes", () => {
  it.each([
    ["a class added to classes.json", "circuits/conduct/classes.json", (text: string) => text.replace('"ev_pa_ascii_min": {', '"ev_pa_ascii_min_copy": { "kind": "payment-action", "lengths": { "amount": 2, "asset": 3, "counterparty": 4, "ts": 1, "enforcedAt": 1, "dataSeq": 1, "traceSeq": 1, "vis": 7 } },\n      "ev_pa_ascii_min": {')],
    ["a template constant changed", "circuits/conduct/templates/guard-event-v1.json", (text: string) => text.replace('\\",\\"asset\\":\\"', '\\",\\"Asset\\":\\"')],
    ["a hand edit of the generated circuits", "circuits/conduct/openings.generated.compact", (text: string) => `${text}\n`],
  ])("refuses %s until --write regenerates them", (_label, path, edit) => {
    const root = packageCopy();
    editFile(root, path, edit);
    const result = compile(root, ["--check"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("generated circuits differ from classes.json; run --write");
  });
});

describe("compile-conduct --check verifies every pin it keeps", () => {
  it("control: an untouched copy reproduces its pins", () => {
    const result = compile(predicateCopy(), ["--check", "--units", "predicate"]);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Conduct circuits reproduce their pins");
  });

  it("refuses a changed pin of a unit it rebuilds", () => {
    const root = predicateCopy();
    editPins(root, pins => { pins.units.predicate!.circuits.check_verdict!.rows += 1; });
    const result = compile(root, ["--check", "--units", "predicate"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Conduct circuits differ from their pins");
  });

  it("refuses pins for a unit it does not know", () => {
    const root = packageCopy();
    editPins(root, pins => { pins.units.steps = { circuits: { st_pa: { rows: 4000 } } }; });
    const result = compile(root, ["--check"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("pins.json names unknown conduct unit: steps");
  });

  it("refuses a --check that would carry a pinned unit without rebuilding it", () => {
    const root = packageCopy();
    editPins(root, pins => { pins.units.predicate!.circuits.check_verdict!.rows += 1; });
    const result = compile(root, ["--check", "--units", "mutants"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--check must rebuild every pinned unit: predicate is not selected");
  });

  // As many entries as there are units, but only two distinct: counted as entries, the list would not be partial and
  // --write would drop the pins of the predicate unit it skips.
  it("treats a repeated unit as one, so a partial --write keeps the pins of the units it skips", () => {
    const root = packageCopy();
    withoutMutants(root);
    const pinsFile = join(root, "circuits/conduct/pins.json");
    const before = readFileSync(pinsFile, "utf8");
    const result = compile(root, ["--write", "--units", "mutants,mutants,reference"]);
    expect(result.stderr).toBe("");
    expect(readFileSync(pinsFile, "utf8")).toBe(before);
    expect(existsSync(join(root, "conduct-managed/predicate")), "the skipped predicate unit is not rebuilt").toBe(false);
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
    withoutMutants(root);
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
  'case "$PERTURB" in extra) cp "$3/zkir/$PERTURB_ZKIR.zkir" "$3/zkir/extra.zkir" ;; bytes) printf " " >> "$3/zkir/$PERTURB_ZKIR.zkir" ;; esac',
  "",
].join("\n"));
chmodSync(perturbingCompiler, 0o755);

// A copy whose openings unit compiles the one step mandate class and pins nothing, so its --write stays short.
function openingsCopy(): string {
  const root = packageCopy();
  const classes = join(root, "circuits/conduct/classes.json");
  const { openings } = JSON.parse(readFileSync(classes, "utf8"));
  writeFileSync(classes, JSON.stringify({ openings: { events: {}, mandates: { m_step: openings.mandates.m_step } } }));
  writeFileSync(join(root, "circuits/conduct/mutants.json"), "[]\n");
  rmSync(join(root, "circuits/conduct/pins.json"));
  return root;
}

const EXPORTING_UNITS = [
  {
    unit: "predicate", entry: "predicate.compact", circuit: "check_verdict", args: ["--check", "--units", "predicate"], done: "Conduct circuits reproduce their pins", copy: predicateCopy,
    demote: (root: string) => {
      withoutMutants(root);
      editFile(root, "circuits/conduct/predicate.compact", text => text.replaceAll("export pure circuit ", "pure circuit "));
    },
  },
  {
    unit: "openings", entry: "openings.generated.compact", circuit: "m_step", args: ["--write", "--units", "openings"], done: "Compiled and pinned conduct circuits", copy: openingsCopy,
    demote: (root: string) => editFile(root, "scripts/conduct/template.mjs", text => text.replace("`export pure circuit ${name}(", "`pure circuit ${name}(")),
  },
];

describe.each(EXPORTING_UNITS)("compile-conduct measures export invariance of the $unit unit with a second, unexported compile", ({ entry, circuit, args, done, copy, demote }) => {
  // The refusal comes while the unit's ZKIR is still being mock-compiled; the script lets that finish and removes its
  // scratch before it exits.
  it("refuses a unit that exports no pure circuit, and leaves no scratch directory behind", () => {
    const root = copy();
    demote(root);
    const tmp = mkdtempSync(join(scratch, "tmp-"));
    const result = compile(root, args, { TMPDIR: tmp });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${entry} exports no pure circuit`);
    expect(readdirSync(tmp), "scratch left behind").toEqual([]);
  });

  const perturbed = (perturb: string) => compile(copy(), args, { COMPACTC: perturbingCompiler, REAL_COMPACTC: compactc, ZKIR: zkir, PERTURB: perturb, PERTURB_ZKIR: circuit });

  it("control: the wrapper with no perturbation compiles and pins the unit", () => {
    const result = perturbed("none");
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(done);
  });

  it.each([
    ["bytes", `${circuit}.zkir depends on which pure circuits are exported`],
    ["extra", "the provable circuits depend on which pure circuits are exported"],
  ])("refuses an unexported compile whose ZKIR differs (%s)", (perturb, message) => {
    const result = perturbed(perturb);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });
});
