import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mutants } from "./mutants.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const work = mkdtempSync(join(tmpdir(), "conduct-mutants-"));
const layout = join(work, "workspace");
mkdirSync(layout);
for (const file of ["package.json", "vitest.config.mts", "tsconfig.base.json"]) cpSync(join(root, file), join(layout, file));
symlinkSync(join(root, "node_modules"), join(layout, "node_modules"), "dir");
for (const name of ["conduct", "core", "process-trace"]) {
  const dest = join(layout, "packages", name);
  mkdirSync(dest, { recursive: true });
  for (const file of ["package.json", "src", ...(name === "conduct" ? ["tests"] : [])]) cpSync(join(root, "packages", name, file), join(dest, file), { recursive: true });
  symlinkSync(join(root, "packages", name, "node_modules"), join(dest, "node_modules"), "dir");
}
const tests = readdirSync(join(layout, "packages/conduct/tests"))
  .filter(name => name.endsWith(".test.ts") && !["restart.test.ts", "guard-state.test.ts"].includes(name))
  .map(name => `packages/conduct/tests/${name}`);
function run(name) {
  const report = join(work, `${name}.json`);
  const fd = openSync(join(work, `${name}.log`), "w");
  let result;
  try {
    result = spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", ...tests, "--maxWorkers=1", "--reporter=json", `--outputFile=${report}`], { cwd: layout, stdio: ["ignore", fd, fd], timeout: 120_000 });
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
assert.ok(baseline.report.numPassedTests >= 110);
console.log(`BASELINE ${baseline.report.numPassedTests} passed in isolated harness layout`);
let killed = 0;
for (const [name, file, from, to] of mutants) {
  const path = join(layout, "packages/conduct/src", file);
  const original = readFileSync(path, "utf8");
  assert.equal(original.split(from).length, 2, `${name}: mutation must match exactly once`);
  writeFileSync(path, original.replace(from, to));
  let result;
  try { result = run(name); } finally { writeFileSync(path, original); }
  assert.equal(result.assertions.length, baseline.assertions.length, `${name}: suite did not collect`);
  assert.equal(result.report.numPendingTests, 0, `${name}: skipped tests`);
  const failures = result.assertions.filter(t => t.status === "failed");
  assert.ok(result.exit !== 0 && failures.length > 0, `${name}: SURVIVED; evidence: ${work}`);
  assert.ok(failures.every(t => t.failureMessages.some(message => /AssertionError|Error: unknown guard event field/.test(message))), `${name}: unexpected failure; evidence: ${work}`);
  killed++;
  console.log(`${name} KILLED | ${failures.length} failed assertions | ${failures[0].fullName}`);
}
console.log(`${killed}/${mutants.length} killed; evidence: ${work}`);
rmSync(layout, { recursive: true });
