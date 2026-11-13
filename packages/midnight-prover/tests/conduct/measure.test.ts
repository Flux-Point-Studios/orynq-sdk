import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const pkg = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(tmpdir(), "conduct-measure-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Only the three parameter files the installer pins exist here, as on every host this repository builds on.
const params = join(scratch, "params");
mkdirSync(params);
for (const k of [13, 14, 16]) writeFileSync(join(params, `bls_midnight_2p${k}`), "");

// Loaded before measure.mjs: any socket the process opens, and any child it starts, leaves a line in the marker file.
const marker = join(scratch, "activity.log");
const preload = join(scratch, "preload.mjs");
writeFileSync(preload, `
import { appendFileSync } from "node:fs";
import net from "node:net";
import child from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const note = line => appendFileSync(${JSON.stringify(marker)}, line + "\\n");
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) { note("socket"); return connect.apply(this, args); };
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
  const original = child[name];
  child[name] = function (...args) { note("child " + name); return original.apply(this, args); };
}
syncBuiltinESMExports();
`);

const FAIL_CLOSED = "http://127.0.0.1:9/";
function measure(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  rmSync(marker, { force: true });
  const result = spawnSync(process.execPath, ["--import", preload, join(pkg, "bench/conduct/measure.mjs"), ...args], {
    encoding: "utf8", env: { ...process.env, MIDNIGHT_PP: params, MIDNIGHT_PARAM_SOURCE: FAIL_CLOSED, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, activity: existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n") : [] };
}
const out = (name: string) => join(scratch, name);
const pins = JSON.parse(readFileSync(join(pkg, "circuits/conduct/pins.json"), "utf8")) as { units: Record<string, { circuits: Record<string, { k: number }> }> };

describe("T-C08 measure.mjs refuses what it must not do, before it starts any tool or opens any socket", () => {
  // The recorder under test: a script that starts a child and dials the fail-closed source leaves both in the marker.
  it("control: the recorder sees a started child and an opened socket, through the bindings measure.mjs imports", () => {
    const probe = join(scratch, "probe.mjs");
    writeFileSync(probe, `
import { spawnSync } from "node:child_process";
import { connect } from "node:net";
spawnSync(process.execPath, ["-e", "0"]);
const socket = connect(9, "127.0.0.1");
socket.on("error", () => {});
socket.on("connect", () => socket.destroy());
`);
    rmSync(marker, { force: true });
    const result = spawnSync(process.execPath, ["--import", preload, probe], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(readFileSync(marker, "utf8").trim().split("\n").sort()).toEqual(["child spawnSync", "socket"]);
  });

  it("st_pa is pinned at k=17, for which no parameters are installed", () => {
    expect(pins.units.steps!.circuits.st_pa!.k).toBe(17);
    expect(readdirSync(params).sort()).toEqual(["bls_midnight_2p13", "bls_midnight_2p14", "bls_midnight_2p16"]);
  });

  it("refuses a circuit whose pinned k has no installed parameters, with exit 2 and no download", () => {
    const run = measure(["--dry-run", "--circuits", "st_pa", "--out", out("x")]);
    expect(run.stderr).toContain("params 2p17 absent; refusing download");
    expect(run.status).toBe(2);
    expect(run.activity).toEqual([]);
    expect(existsSync(out("x"))).toBe(false);
  });

  it("refuses the whole run when any selected circuit is above k=16, measuring none of the others", () => {
    const run = measure(["--dry-run", "--circuits", "ev_pa_ascii_min,st_pa", "--out", out("mixed")]);
    expect(run.stderr).toContain("params 2p17 absent; refusing download");
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
  });

  it("refuses a k above 16 even where a parameter file of that size is present: nothing above k=16 is pinned", () => {
    const more = join(scratch, "params-17");
    mkdirSync(more);
    for (const k of [13, 14, 16, 17]) writeFileSync(join(more, `bls_midnight_2p${k}`), "");
    const run = measure(["--dry-run", "--circuits", "st_pa", "--out", out("y")], { MIDNIGHT_PP: more });
    expect(run.stderr).toContain("st_pa is pinned at k=17; keys and proofs above k=16 are out of scope");
    expect(run.status).toBe(2);
  });

  it.each([["the package", pkg], ["the repository root", resolve(pkg, "../..")], ["a new directory under the repository", join(pkg, "bench/conduct/evidence")]])(
    "refuses to write evidence inside %s", (_label, dir) => {
      const run = measure(["--dry-run", "--circuits", "ev_pa_ascii_min", "--out", dir]);
      expect(run.stderr).toContain("evidence must be written outside the repository");
      expect(run.status).toBe(2);
      expect(run.activity).toEqual([]);
      expect(existsSync(join(pkg, "bench/conduct/evidence"))).toBe(false);
    });

  // From a linked worktree the checkout is not the whole repository: the main checkout holds it too.
  it("refuses to write evidence inside the main checkout of a linked worktree, without starting git", () => {
    const common = spawnSync("git", ["-C", pkg, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).stdout.trim();
    expect(common).toMatch(/\.git$/);
    const main = resolve(common, "..");
    const run = measure(["--dry-run", "--circuits", "ev_pa_ascii_min", "--out", join(main, "conduct-evidence-probe")]);
    expect(run.stderr).toContain("evidence must be written outside the repository");
    expect(run.status).toBe(2);
    expect(run.activity).toEqual([]);
    expect(existsSync(join(main, "conduct-evidence-probe"))).toBe(false);
  });

  it("refuses to run unless a missing parameter file fails closed", () => {
    for (const source of [undefined, "https://example.invalid/"]) {
      const run = measure(["--dry-run", "--circuits", "ev_pa_ascii_min", "--out", out("z")], { MIDNIGHT_PARAM_SOURCE: source });
      expect(run.stderr).toContain(`MIDNIGHT_PARAM_SOURCE must be ${FAIL_CLOSED}`);
      expect(run.status).toBe(2);
    }
  });

  it.each([
    [["--dry-run", "--circuits", "nope", "--out", out("a")], "unknown conduct circuit: nope"],
    [["--dry-run", "--circuits", "ev_pa_ascii_min"], "usage: measure.mjs"],
    [["--dry-run", "--circuits", "ev_pa_ascii_min", "--out", out("b"), "--reps", "0"], "--reps must be a whole number from 1 to 9"],
    [["--dry-run", "--circuits", "ev_pa_ascii_min", "--out", out("c"), "--surprise"], "usage: measure.mjs"],
  ])("refuses %j", (args, message) => {
    const run = measure(args);
    expect(run.stderr).toContain(message);
    expect(run.status).toBe(2);
    expect(run.activity).toEqual([]);
  });

  // The installer pins parameters for k = 13, 14 and 16 only, so a circuit pinned at any other k cannot be keyed here.
  it.each([["check_verdict", "predicate"], ["m_step", "openings"]])("refuses %s, whose pinned k is below 16 yet has no installed parameters", (id, unit) => {
    const { k } = pins.units[unit]!.circuits[id]!;
    expect([13, 14, 16]).not.toContain(k);
    const run = measure(["--dry-run", "--circuits", id, "--out", out(`small-${id}`)]);
    expect(run.stderr).toContain(`params 2p${k} absent; refusing download`);
    expect(run.status).toBe(2);
    expect(run.activity).toEqual([]);
  });

  it("a dry run of k=16 circuits names what it would measure and starts nothing", () => {
    const run = measure(["--dry-run", "--circuits", "ev_pa_ascii_min,m_base", "--out", out("dry"), "--reps", "3"]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const plan = JSON.parse(run.stdout) as { dryRun: boolean; reps: number; paramSource: string; circuits: { id: string; unit: string; k: number; params: string }[] };
    expect(plan).toMatchObject({ dryRun: true, reps: 3, paramSource: FAIL_CLOSED });
    expect(plan.circuits).toEqual([
      { id: "ev_pa_ascii_min", unit: "openings", k: 16, params: "bls_midnight_2p16" },
      { id: "m_base", unit: "openings", k: 16, params: "bls_midnight_2p16" },
    ]);
    expect(pins.units.openings!.circuits.ev_pa_ascii_min!.k).toBe(16);
    expect(run.activity).toEqual([]);
    expect(existsSync(out("dry"))).toBe(false);
  });
});
