import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const pkg = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(tmpdir(), "conduct-measure-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// A host that holds only the k = 13, 14 and 16 parameter files, of the six the installer pins.
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
const benchPins = JSON.parse(readFileSync(join(pkg, "bench/conduct/pins.json"), "utf8")) as { groups: Record<string, { circuits: Record<string, { k: number }> }> };

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

  it("st_pa is pinned at k=17, for which this host holds no parameters", () => {
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

  it("refuses the whole run when any selected circuit has no installed parameters, measuring none of the others", () => {
    const run = measure(["--dry-run", "--circuits", "ev_pa_ascii_min,st_pa", "--out", out("mixed")]);
    expect(run.stderr).toContain("params 2p17 absent; refusing download");
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
  });

  // A host that holds a file for every k a conduct circuit is pinned at, k=18 included, which the installer does not pin.
  const more = join(scratch, "params-18");
  mkdirSync(more);
  for (const k of [10, 13, 14, 15, 16, 17, 18]) writeFileSync(join(more, `bls_midnight_2p${k}`), "");

  it("a dry run of the k=17 step circuits names what it would measure and starts nothing", () => {
    const steps = Object.entries(pins.units.steps!.circuits).filter(([, pin]) => pin.k === 17).map(([id]) => id);
    expect(steps).toEqual(["st_ea", "st_ed1", "st_ed2", "st_ed6", "st_pa", "st_pd1", "st_pd2", "st_pd3", "st_pd4"]);
    const run = measure(["--dry-run", "--circuits", steps.join(","), "--out", out("steps")], { MIDNIGHT_PP: more });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect((JSON.parse(run.stdout) as { circuits: unknown[] }).circuits).toEqual(steps.map(id => ({ id, unit: "steps", k: 17, params: "bls_midnight_2p17" })));
    expect(run.activity).toEqual([]);
    expect(existsSync(out("steps"))).toBe(false);
  });

  it("refuses a k above 17 even where a parameter file of that size is present: keys and proofs above k=17 are out of scope", () => {
    expect(pins.units.steps!.circuits.st_pa_max_d8!.k).toBe(18);
    for (const circuits of ["st_pa_max_d8", "st_pa,st_pa_max_d8"]) {
      const run = measure(["--dry-run", "--circuits", circuits, "--out", out("y")], { MIDNIGHT_PP: more });
      expect(run.stderr).toContain("st_pa_max_d8 is pinned at k=18; keys and proofs above k=17 are out of scope");
      expect(run.status).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.activity).toEqual([]);
      expect(existsSync(out("y"))).toBe(false);
    }
  });

  it("refuses a k above 17 whose parameter file is absent without a download", () => {
    const run = measure(["--dry-run", "--circuits", "st_pa_max_d8", "--out", out("y18")]);
    expect(run.stderr).toContain("params 2p18 absent; refusing download");
    expect(run.status).toBe(2);
    expect(run.activity).toEqual([]);
  });

  // The files of `more` are empty, so none is the file the installer pins. A real run reads the compiler's version,
  // here a stand-in's, then refuses before it compiles, loads the runtime or opens a socket.
  it.each([["st_pa", 17], ["check_verdict", 10]])("a run of %s refuses a k=%i parameter file that differs from the installer's pin", (id, k) => {
    const compiler = join(scratch, "compactc-stand-in");
    writeFileSync(compiler, "#!/bin/sh\necho 0.31.1\n", { mode: 0o755 });
    const run = measure(["--circuits", id, "--out", out(`unpinned-${id}`), "--native", compiler], { MIDNIGHT_PP: more, COMPACTC: compiler });
    expect(run.stderr).toContain(`params 2p${k} differ from the installer's pin`);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.activity).toEqual(["child spawnSync"]);
    expect(existsSync(out(`unpinned-${id}`))).toBe(false);
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

  // The path given is outside the repository; where it leads is not.
  it("refuses an --out whose symbolic link resolves into the repository", () => {
    const link = join(scratch, "into-repository");
    symlinkSync(pkg, link, "dir");
    for (const dir of [link, join(link, "bench/conduct/evidence")]) {
      const run = measure(["--dry-run", "--circuits", "ev_pa_ascii_min", "--out", dir]);
      expect(run.stderr).toContain("evidence must be written outside the repository");
      expect(run.status).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.activity).toEqual([]);
    }
    expect(existsSync(join(pkg, "bench/conduct/evidence"))).toBe(false);
  });

  it("refuses to run without MIDNIGHT_PP, the directory of the installed parameters", () => {
    const run = measure(["--dry-run", "--circuits", "ev_pa_ascii_min", "--out", out("no-pp")], { MIDNIGHT_PP: undefined });
    expect(run.stderr).toBe("MIDNIGHT_PP must name the directory of the installed proving parameters\n");
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.activity).toEqual([]);
  });

  it("refuses to run unless a missing parameter file fails closed", () => {
    for (const source of [undefined, "https://example.invalid/"]) {
      const run = measure(["--dry-run", "--circuits", "ev_pa_ascii_min", "--out", out("z")], { MIDNIGHT_PARAM_SOURCE: source });
      expect(run.stderr).toContain(`MIDNIGHT_PARAM_SOURCE must be ${FAIL_CLOSED}`);
      expect(run.status).toBe(2);
    }
  });

  // The pin check covers every selected circuit's file, not the first alone: the refusal names each file that differs.
  it("a run of two circuits refuses both parameter files that differ from their pins, naming each", () => {
    const compiler = join(scratch, "compactc-stand-in");
    writeFileSync(compiler, "#!/bin/sh\necho 0.31.1\n", { mode: 0o755 });
    const run = measure(["--circuits", "check_verdict,st_pa", "--out", out("unpinned-two"), "--native", compiler], { MIDNIGHT_PP: more, COMPACTC: compiler });
    expect(run.stderr).toBe("params 2p10, 2p17 differ from the installer's pin\n");
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.activity).toEqual(["child spawnSync"]);
    expect(existsSync(out("unpinned-two"))).toBe(false);
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

  // This host holds parameters for k = 13, 14 and 16 only, so a circuit pinned at any other k cannot be keyed here.
  it.each([["check_verdict", "predicate"], ["m_step", "openings"], ["b_allowlist_d4", "bench"]])("refuses %s, whose pinned k is below 16 yet has no installed parameters", (id, unit) => {
    const { k } = unit === "bench" ? benchPins.groups.allowlist!.circuits[id]! : pins.units[unit]!.circuits[id]!;
    expect([13, 14, 16]).not.toContain(k);
    const run = measure(["--dry-run", "--circuits", id, "--out", out(`small-${id}`)]);
    expect(run.stderr).toContain(`params 2p${k} absent; refusing download`);
    expect(run.status).toBe(2);
    expect(run.activity).toEqual([]);
  });

  // The reason a circuit outside the run has no key or proof is the one that holds: the tool's limit, parameters the
  // installer does not pin, or only that the run did not select it.
  it("a dry run states the actual reason each circuit it leaves out is unmeasured", () => {
    const run = measure(["--dry-run", "--circuits", "ev_pa_ascii_min", "--out", out("why")]);
    expect(run.status).toBe(0);
    const { unmeasured } = JSON.parse(run.stdout) as { unmeasured: { id: string; k: number; status: string }[] };
    const status = (id: string) => unmeasured.find(u => u.id === id)?.status;
    expect(status("st_pa_max_d8")).toBe("UNMEASURED: k=18 is above this tool's limit of k=17, and the installer pins no 2p18 params");
    expect(status("b_span_d16_s1")).toBe("UNMEASURED: k=19 is above this tool's limit of k=17, and the installer pins no 2p19 params");
    for (const id of ["st_pa", "check_verdict", "m_step", "m_base"]) expect(status(id)).toBe("not selected in this run");
    expect(status("ev_pa_ascii_min")).toBeUndefined();
    expect(unmeasured.filter(u => u.status.startsWith("UNMEASURED")).map(u => u.k).every(k => k > 17)).toBe(true);
    expect(unmeasured.filter(u => u.k > 17).every(u => u.status.startsWith(`UNMEASURED: k=${u.k} is above`))).toBe(true);
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
