import assert from "node:assert/strict";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mutants } from "./mutants.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const only = new Set(process.argv.slice(2));
const selected = only.size === 0 ? mutants : mutants.filter(([name]) => only.has(name));
assert.equal(selected.length, only.size === 0 ? mutants.length : only.size, "unknown mutant name");
const work = mkdtempSync(join(tmpdir(), "conduct-mutants-"));
const layout = join(work, "workspace");
mkdirSync(layout);
for (const file of ["package.json", "vitest.config.mts", "tsconfig.base.json"]) cpSync(join(root, file), join(layout, file));
symlinkSync(join(root, "node_modules"), join(layout, "node_modules"), "dir");
for (const name of ["conduct", "core", "process-trace"]) {
  const dest = join(layout, "packages", name);
  mkdirSync(dest, { recursive: true });
  for (const file of ["package.json", "src", ...(name === "conduct" ? ["tests", "docs"] : [])]) cpSync(join(root, "packages", name, file), join(dest, file), { recursive: true });
  symlinkSync(join(root, "packages", name, "node_modules"), join(dest, "node_modules"), "dir");
}
// Each mutant must apply exactly once and produce source no other mutant produces, so counts are of distinct mutants.
const produced = new Map();
for (const [name, file, from, to] of selected) {
  const original = readFileSync(join(layout, "packages/conduct/src", file), "utf8");
  assert.equal(original.split(from).length, 2, `${name}: mutation must match exactly once`);
  const key = `${file}\0${original.replace(from, to)}`;
  assert.ok(!produced.has(key), `${name} duplicates ${produced.get(key)}`);
  produced.set(key, name);
}
// Every conduct test file, including the child-process restart and composition suites, runs against each mutant.
function run(name) {
  const report = join(work, `${name}.json`);
  const fd = openSync(join(work, `${name}.log`), "w");
  let result;
  try {
    result = spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "packages/conduct/tests", "--maxWorkers=4", "--reporter=json", `--outputFile=${report}`], { cwd: layout, stdio: ["ignore", fd, fd], timeout: 600_000 });
  } finally { closeSync(fd); }
  assert.equal(result.error, undefined, `${name}: runner error`);
  assert.equal(result.signal, null, `${name}: runner signal`);
  assert.ok(existsSync(report), `${name}: missing report`);
  const r = JSON.parse(readFileSync(report, "utf8"));
  const assertions = r.testResults.flatMap(t => t.assertionResults);
  return { exit: result.status, report: r, assertions };
}
const baseline = run("baseline");
assert.equal(baseline.exit, 0, `baseline failed; evidence: ${work}`);
assert.equal(baseline.report.numFailedTests, 0);
assert.equal(baseline.report.numPendingTests, 0);
assert.ok(baseline.report.numPassedTests >= 334, `baseline ran ${baseline.report.numPassedTests} tests`);
console.log(`BASELINE ${baseline.report.numPassedTests} passed in isolated harness layout`);
const rows = [];
for (const [name, file, from, to] of selected) {
  const path = join(layout, "packages/conduct/src", file);
  const original = readFileSync(path, "utf8");
  writeFileSync(path, original.replace(from, to));
  let result;
  try { result = run(name); } finally { writeFileSync(path, original); }
  assert.equal(result.assertions.length, baseline.assertions.length, `${name}: suite did not collect; evidence: ${work}`);
  assert.equal(result.report.numPendingTests, 0, `${name}: skipped tests`);
  const failures = result.assertions.filter(t => t.status === "failed");
  // Kills must come from an expectation; vitest reports .rejects/.resolves failures as plain Errors from @vitest/expect.
  const asserted = failures.some(t => t.failureMessages.some(message => message.startsWith("AssertionError") || message.includes("/@vitest/expect/")));
  const status = result.exit === 0 || failures.length === 0 ? "SURVIVED" : asserted ? "KILLED" : "UNASSERTED";
  rows.push({ name, status, failed: failures.length, first: failures[0]?.fullName ?? null });
  console.log(`${name} ${status} | ${failures.length} failed assertions | ${failures[0]?.fullName ?? ""}`);
}
const killed = rows.filter(row => row.status === "KILLED");
writeFileSync(join(work, "summary.json"), JSON.stringify({ baseline: baseline.report.numPassedTests, killed: killed.length, total: selected.length, rows }, null, 1));
console.log(`${killed.length}/${selected.length} killed; evidence: ${work}`);
assert.equal(killed.length, selected.length, `not killed: ${rows.filter(row => row.status !== "KILLED").map(row => `${row.name} ${row.status}`).join(", ")}`);
rmSync(layout, { recursive: true });
