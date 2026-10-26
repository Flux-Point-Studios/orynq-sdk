import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { withResultsLock } from "../src/results-lock.js";

const root = mkdtempSync(join(tmpdir(), "orynq-results-lock-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
it("serializes concurrent processes across the read and rename without dropping either result", async () => {
  const file = join(root, "rows.json"); writeFileSync(file, "[]", { mode: 0o600 });
  const script = `import { readFileSync, writeFileSync, renameSync } from 'node:fs';
    const { withResultsLock } = await import(process.argv[1]); const [file, label] = process.argv.slice(2);
    await withResultsLock(file, () => { const rows=JSON.parse(readFileSync(file,'utf8'));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
      writeFileSync(file+'.'+label,JSON.stringify([...rows,label])); renameSync(file+'.'+label,file); });`;
  const run = promisify(execFile);
  await Promise.all(["a", "b"].map(label => run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, new URL("../src/results-lock.ts", import.meta.url).href, file, label])));
  expect(JSON.parse(readFileSync(file, "utf8")).sort()).toEqual(["a", "b"]);
  expect(existsSync(`${file}.lock`)).toBe(false);
});
it("recovers a dead writer's lock but never deletes a live writer's lock", async () => {
  const file = join(root, "recovered.json");
  writeFileSync(`${file}.lock`, JSON.stringify({ pid: 0x7fffffff, token: "ab".repeat(16) }), { mode: 0o600 });
  let writes = 0; await withResultsLock(file, () => { writes++; }); expect(writes).toBe(1);
  const owner = JSON.stringify({ pid: process.pid, token: "cd".repeat(16) });
  writeFileSync(`${file}.lock`, owner, { mode: 0o600 });
  await expect(withResultsLock(file, () => { writes++; }, 30)).rejects.toThrow("results writer lock is still held");
  expect(readFileSync(`${file}.lock`, "utf8")).toBe(owner); expect(writes).toBe(1);
});
