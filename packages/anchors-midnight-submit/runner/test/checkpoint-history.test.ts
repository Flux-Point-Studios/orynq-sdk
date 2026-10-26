import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkpointToJson, deriveCheckpointAdvance, finalityRpc, verifyCheckpointAdvance } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { followerChain } from "../../../anchors-midnight/src/__tests__/follower-chain.js";
import { followerPolicyDigest, openFollowerReader, verifyFollowerBlock } from "../follower-block.js";
import { openFollowerState } from "../follower-state.js";
import { openStandingStatus } from "../standing-status.js";
import { batchAuthors, batchBytes, batchScope } from "./batch-fixture.js";

const now = 1_800_000_000_000, day = 86_400_000;
const roots: string[] = [], handles: ReturnType<typeof openFollowerState>[] = [];
afterEach(() => { for (const state of handles.splice(0)) state.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "checkpoint-history-")); roots.push(root);
  const chain = followerChain(undefined, height => height <= 1301 ? now - day - 5000 : now + (height - 1303) * 6000);
  const source = { ...chain.source, network: "preprod" as const }, originals = [chain.checkpoint];
  const scope = { network: batchScope.network, registry: batchScope.registry, author: batchScope.author, genesis: "01".repeat(32), policyDigest: followerPolicyDigest(originals), runtimeSpecVersion: 1000300 };
  const file = join(root, "follower.sqlite"), state = openFollowerState(file, scope); handles.push(state);
  for (const height of [1301, 1302, 1303]) state.recordVerifiedBlock(await verifyFollowerBlock({ source, block: chain.ref(height), checkpoints: originals }));
  const authors = batchAuthors({ validFrom: 1301 }, 1, originals.map(checkpointToJson));
  const bytes = await batchBytes({ ttl: now + 600_000 });
  state.reserveStandingAttempt(bytes, { commitment: batchScope.commitment, authors,
    started: { wallTime: now - 1_260_000, chainTime: now - 1_260_000, monotonicMillis: 0 },
    current: { wallTime: now, chainTime: now, monotonicMillis: 1_260_000, ...chain.ref(1303) } });
  const first = await deriveCheckpointAdvance({ network: "preprod", predecessor: originals[0]!, rpc: finalityRpc(source), block: chain.ref(1601) });
  const tip = await verifyCheckpointAdvance({ artifact: first, predecessor: originals[0]!, expectedNetwork: "preprod", expectedSequence: 1, previousDigest: null });
  const second = await deriveCheckpointAdvance({ network: "preprod", predecessor: tip.checkpoint, rpc: finalityRpc(source), block: chain.ref(1901), sequence: 2, previousDigest: tip.digest, rootId: first.rootId });
  const snapshot = () => {
    const db = new DatabaseSync(file);
    try { return JSON.stringify(db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name<>'follower_checkpoints' order by name").all().map(row => [row.name, db.prepare(`select * from ${String(row.name)}`).all().map(value => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item)).sort()])); }
    finally { db.close(); }
  };
  return { root, file, state, scope, chain, source, originals, first, second, snapshot };
}

it("advances without changing scope, blocks, observations, admissions, fees, claims or monitoring caps", async () => {
  const f = await setup(), before = f.snapshot(), fees = f.state.feeFacts(), admissions = f.state.admissions();
  const status = openStandingStatus(f.root, { ...f.scope, mode: "observe" }, () => now); status.hold("controller", "dust-cap"); const cap = status.read().cap;
  for (const file of ["census.sqlite", "attempts.sqlite"]) writeFileSync(join(f.root, file), `retained-${file}`, { mode: 0o600 });
  await f.state.retainCheckpointHistory(f.originals, [f.first, f.second]);
  expect(f.snapshot()).toBe(before); expect(f.state.scope()).toEqual(f.scope);
  expect(f.state.feeFacts()).toEqual(fees); expect(f.state.admissions()).toEqual(admissions);
  expect(openStandingStatus(f.root, { ...f.scope, mode: "observe" }, () => now).read().cap).toEqual(cap);
  for (const file of ["census.sqlite", "attempts.sqlite"]) expect(readFileSync(join(f.root, file), "utf8")).toBe(`retained-${file}`);
  f.state.close(); handles.splice(handles.indexOf(f.state), 1);
  const reopened = openFollowerState(f.file, f.scope); handles.push(reopened);
  expect(reopened.checkpointHistory()).toEqual([f.first, f.second]); expect(reopened.admissions()).toEqual(admissions);
});

it.each(["rollback", "fork", "gap", "root"] as const)("refuses %s checkpoint state and retains every prior row", async mode => {
  const f = await setup(); await f.state.retainCheckpointHistory(f.originals, [f.first]);
  const before = f.snapshot(), input = structuredClone([f.first, f.second]);
  if (mode === "rollback") input.splice(0);
  if (mode === "fork") input[0]!.successor.authorities[0]!.key = "00".repeat(32);
  if (mode === "gap") input.splice(0, 1);
  if (mode === "root") input[1]!.rootId = "00".repeat(32);
  await expect(f.state.retainCheckpointHistory(f.originals, input)).rejects.toThrow();
  expect(f.state.checkpointHistory()).toEqual([f.first]); expect(f.snapshot()).toBe(before);
});

it("refuses a retained-history gap instead of using checkpoint advancement to reset it", async () => {
  const f = await setup(), db = new DatabaseSync(f.file); db.exec("delete from follower_blocks where height=1302"); db.close();
  await expect(f.state.retainCheckpointHistory(f.originals, [f.first])).rejects.toThrow(/coverage|contiguous|incomplete/i);
  expect(f.state.checkpointHistory()).toEqual([]);
});

it("commits the complete checkpoint extension or none, then recovers a refused transaction", async () => {
  const f = await setup(), before = f.snapshot(), db = new DatabaseSync(f.file);
  db.exec("create trigger interrupt_checkpoint before insert on follower_checkpoints when new.sequence=2 begin select raise(abort,'interrupted checkpoint transaction'); end;");
  await expect(f.state.retainCheckpointHistory(f.originals, [f.first, f.second])).rejects.toThrow(/interrupted/);
  expect(f.state.checkpointHistory()).toEqual([]); expect(f.snapshot()).toBe(before);
  db.exec("drop trigger interrupt_checkpoint"); db.close();
  await f.state.retainCheckpointHistory(f.originals, [f.first, f.second]);
  expect(f.state.checkpointHistory()).toEqual([f.first, f.second]); expect(f.snapshot()).toBe(before);
});

it("recovers unchanged retained histories after a real process dies before the checkpoint commit", async () => {
  const f = await setup(), before = f.snapshot(), input = join(f.root, "checkpoint-input.json");
  writeFileSync(input, JSON.stringify({ scope: f.scope, originals: f.originals.map(checkpointToJson), artifacts: [f.first, f.second] }), { mode: 0o600 });
  const stateModule = new URL("../follower-state.ts", import.meta.url).href;
  const checkpointModule = new URL("../../../anchors-midnight/src/checkpoint-advance.ts", import.meta.url).href;
  const source = `import { readFileSync } from 'node:fs'; import { DatabaseSync } from 'node:sqlite';
    import { openFollowerState } from ${JSON.stringify(stateModule)};
    import { checkpointFromJson } from ${JSON.stringify(checkpointModule)};
    const input = JSON.parse(readFileSync(process.argv[1], 'utf8'));
    const state = openFollowerState(process.argv[2], input.scope), execute = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) {
      if (sql === 'commit') { console.log('checkpoint-before-commit'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
      return execute.call(this, sql);
    };
    await state.retainCheckpointHistory(input.originals.map(checkpointFromJson), input.artifacts);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, input, f.file], { cwd: fileURLToPath(new URL("../../", import.meta.url)), stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error("Checkpoint interruption fixture did not reach its commit")), 60_000);
      child.stdout.on("data", chunk => { output += chunk.toString(); if (output.includes("checkpoint-before-commit")) { clearTimeout(timeout); resolve(); } });
      child.once("error", error => { clearTimeout(timeout); reject(error); });
      child.once("close", () => { clearTimeout(timeout); reject(new Error("Checkpoint interruption fixture exited before its commit")); });
    });
    const stopped = new Promise(resolve => child.once("close", resolve)); child.kill("SIGKILL"); await stopped;
    expect(f.state.checkpointHistory()).toEqual([]); expect(f.snapshot()).toBe(before);
    await f.state.retainCheckpointHistory(f.originals, [f.first, f.second]);
    expect(f.state.checkpointHistory()).toEqual([f.first, f.second]); expect(f.snapshot()).toBe(before);
  } finally { child.kill("SIGKILL"); }
});

it("uses advanced proofs for future ranges while retaining historical replay under the original scope", async () => {
  const f = await setup(); await f.state.retainCheckpointHistory(f.originals, [f.first, f.second]);
  const reader = openFollowerReader({ source: f.source, checkpoints: f.originals, advances: f.state.checkpointHistory(), maxSetChanges: 0 });
  const future = []; for await (const block of reader.range({ after: f.chain.ref(1901), end: f.chain.ref(1902) })) future.push(block);
  const policyDigest = followerPolicyDigest(f.originals, 0);
  expect(future).toHaveLength(1); expect(future[0]!.policyDigest).toBe(policyDigest);
  const historical = []; for await (const block of reader.range({ after: f.chain.ref(1100), end: f.chain.ref(1101) })) historical.push(block);
  expect(historical).toHaveLength(1); expect(historical[0]!.policyDigest).toBe(policyDigest);
  const unadvanced = openFollowerReader({ source: f.source, checkpoints: f.originals, maxSetChanges: 0 });
  await expect((async () => { for await (const _block of unadvanced.range({ after: f.chain.ref(1901), end: f.chain.ref(1902) })) { /* exhaust */ } })()).rejects.toThrow(/final|change|budget/i);
});
