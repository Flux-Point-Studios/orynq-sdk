import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
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
  expect(existsSync(`${file}.lock`)).toBe(true);
});
it("keeps a live descriptor locked and automatically releases it after its process dies", async () => {
  const file = join(root, "recovered.json");
  const script = `const { withResultsLock } = await import(process.argv[1]);
    await withResultsLock(process.argv[2], () => { process.stdout.write("held\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000); });`;
  const holder = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, new URL("../src/results-lock.ts", import.meta.url).href, file], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await once(holder.stdout, "data");
    await expect(withResultsLock(file, () => { throw new Error("concurrent operation entered"); }, 30)).rejects.toThrow("results writer lock is still held");
  } finally { holder.kill("SIGKILL"); await once(holder, "close"); }
  let writes = 0;
  await withResultsLock(file, () => { writes++; }, 100);
  expect(writes).toBe(1);
  expect(existsSync(`${file}.lock`)).toBe(true);
});
it("serializes two stale-owner recoverers behind a barrier without replacing their shared lock inode", async () => {
  const file = join(root, "two-recoverers.json");
  writeFileSync(file, "[]", { mode: 0o600 });
  // Migration from the old PID/token protocol: this record is deliberately stale. Both
  // processes are paused before acquiring it, then released into the former recovery race.
  writeFileSync(`${file}.lock`, JSON.stringify({ pid: 0x7fffffff, token: "ab".repeat(16) }), { mode: 0o600 });
  const script = `import { once } from "node:events"; import { readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, statSync } from "node:fs";
    const { withResultsLock } = await import(process.argv[1]); const [file,label] = process.argv.slice(2);
    const inode = statSync(file+'.lock').ino; process.stdout.write('ready\\n'); await once(process.stdin,'data');
    await withResultsLock(file, () => { const active=openSync(file+'.active','wx');
      try { if(statSync(file+'.lock').ino!==inode) throw new Error('lock inode replaced');
        const rows=JSON.parse(readFileSync(file,'utf8')); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
        writeFileSync(file+'.'+label,JSON.stringify([...rows,label])); renameSync(file+'.'+label,file);
      } finally {closeSync(active);unlinkSync(file+'.active');} });`;
  const children = ["a", "b"].map(label => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, new URL("../src/results-lock.ts", import.meta.url).href, file, label], { stdio: ["pipe", "pipe", "pipe"] }));
  await Promise.all(children.map(child => once(child.stdout, "data")));
  const done = children.map(child => once(child, "close"));
  for (const child of children) child.stdin.end("go");
  expect((await Promise.all(done)).map(([code]) => code)).toEqual([0, 0]);
  expect(JSON.parse(readFileSync(file, "utf8")).sort()).toEqual(["a", "b"]);
});
