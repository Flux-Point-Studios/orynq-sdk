import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { followerChain } from "../../../anchors-midnight/src/__tests__/follower-chain.js";
import { followerPolicyDigest } from "../follower-block.js";
import { openFollowerState } from "../follower-state.js";
import { openFollowerCatchup, type FollowerStartupDiagnostic } from "../follower-catchup.js";
import { batchAuthors, batchScope } from "./batch-fixture.js";

const now = 1_800_000_000_000, day = 86_400_000, timestamp = (height: number) => now + (height - 1365) * day / 4;
let server: Server, root: string, url: string, state: ReturnType<typeof openFollowerState>, chain: ReturnType<typeof followerChain>;
let tip = 1365, corruptHeight = 0, requests = 0, httpRequests = 0, validFrom = 1350, serial = 1, shiftWindow = false;
let responseFault: "truncated" | "duplicate-id" | "wrong-id" | "rpc-error" | null = null;
let stallEffects: "headers" | "body" | null = null, effectRequests = 0, effectsStarted: (() => void) | undefined, effectsClosed: (() => void) | undefined;
const authors = () => batchAuthors({ validFrom }, serial, [{ ...chain.checkpoint, setId: chain.checkpoint.setId.toString(), authorities: chain.checkpoint.authorities.map(row => ({ key: row.key, weight: row.weight.toString() })) }]);
beforeEach(async () => {
  tip = 1365; corruptHeight = 0; requests = 0; httpRequests = 0; validFrom = 1350; serial = 1; shiftWindow = false;
  responseFault = null; stallEffects = null; effectRequests = 0; effectsStarted = undefined; effectsClosed = undefined;
  chain = followerChain((method, params, value) => {
    if (shiftWindow && method === "state_getReadProof" && params[1] === `0x${chain.ref(1301).hash}`) { validFrom = 1299; serial = 2; shiftWindow = false; }
    if (corruptHeight && method === "state_getReadProof" && params[1] === `0x${chain.ref(corruptHeight).hash}`) return { ...value, proof: [] };
    return value;
  }, timestamp);
  chain.checkpoint = chain.chain.chain.checkpoint(1);
  root = mkdtempSync(join(tmpdir(), "midnight-catchup-"));
  state = openFollowerState(join(root, "follower.sqlite"), { ...batchScope, genesis: "01".repeat(32), policyDigest: followerPolicyDigest([chain.checkpoint]), runtimeSpecVersion: 1000300 });
  server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      httpRequests++;
      const body = Buffer.concat(chunks);
      if (body.length > 8192) throw new Error("fixture request exceeds byte limit");
      const input = JSON.parse(body.toString());
      if (Array.isArray(input) && input.length > 32) throw new Error("fixture request exceeds call limit");
      const effects = Array.isArray(input) && input.some(call => call.method === "state_getReadProof");
      if (effects) effectRequests++;
      if (effects && stallEffects) {
        res.once("close", () => effectsClosed?.());
        if (stallEffects === "body") { res.writeHead(200, { "content-type": "application/json" }); res.write("["); }
        else effectsStarted?.();
        return;
      }
      const answer = async (request: { id: unknown; method: string; params?: unknown[] }) => {
        requests++;
        const result = request.method === "chain_getFinalizedHead" ? `0x${chain.ref(tip).hash}` : await chain.source.node.call(request.method, request.params);
        return { jsonrpc: "2.0", id: request.id, result };
      };
      const result: unknown = Array.isArray(input) ? (await Promise.all(input.map(answer))).reverse() : await answer(input);
      if (effects && Array.isArray(result)) {
        if (responseFault === "truncated") result.pop();
        if (responseFault === "duplicate-id") result[0].id = result[1].id;
        if (responseFault === "wrong-id") result[0].id = -1;
        if (responseFault === "rpc-error") result[0] = { jsonrpc: "2.0", id: result[0].id, error: { code: -32000, message: "fixture proof unavailable" } };
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result));
    } catch { res.writeHead(500); res.end("fixture failure"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { state?.close(); if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } if (root) rmSync(root, { recursive: true, force: true }); });
const open = (signal?: AbortSignal) => openFollowerCatchup({ state, node: url, authors, clock: () => ({ wallTime: now, monotonicMillis: 0 }), ...(signal ? { signal } : {}) });

it("authenticates startup without storing it before the complete-history floor", async () => {
  const follower = open(), startup = await follower.start();
  expect(startup.block).toEqual(chain.ref(1365)); expect(startup.timestamp).toBe(now); expect(state.head()).toBeNull();
  const first = await follower.turn();
  expect(first).toMatchObject({ state: "floor", head: chain.ref(1301) });
  expect(state.coverage().floor!.timestamp).toBeLessThanOrEqual(now - day);
  expect(state.coverage().floor!.height).toBeLessThanOrEqual(1350);
  await expect(follower.start()).rejects.toThrow(/start|already/i);
});

it("reports bounded startup phases and work counters without upstream or configuration text", async () => {
  const events: FollowerStartupDiagnostic[] = [];
  const follower = openFollowerCatchup({ state, node: url, authors, clock: () => ({ wallTime: now, monotonicMillis: 0 }), startupDiagnostic: event => events.push(event) });
  await follower.start();
  expect(events.map(event => [event.phase, event.outcome])).toEqual([["policy", "start"], ["head", "start"], ["finality", "start"], ["policy", "start"], ["clock", "start"], ["clock", "success"]]);
  for (const event of events) {
    expect(event.elapsedMs).toBeGreaterThanOrEqual(0); expect(event.elapsedMs).toBeLessThanOrEqual(86_400_000);
    expect(event.requests).toBeGreaterThanOrEqual(0); expect(event.requests).toBeLessThanOrEqual(256);
    expect(event.responseBytes).toBeGreaterThanOrEqual(0); expect(event.responseBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(Object.keys(event).sort()).toEqual(["category", "elapsedMs", "outcome", "phase", "requests", "responseBytes"]);
  }
  expect(events.at(-1)!.requests).toBeGreaterThan(0); expect(events.at(-1)!.responseBytes).toBeGreaterThan(0);
  expect(JSON.stringify(events)).not.toContain(url);
  expect(state.head()).toBeNull();
});

it.each(["clock", "source-or-integrity", "policy"] as const)("retains only the bounded %s startup failure category", async category => {
  const events: FollowerStartupDiagnostic[] = [];
  if (category === "clock") tip = 1364;
  if (category === "source-or-integrity") responseFault = "rpc-error";
  const follower = openFollowerCatchup({ state, node: url, authors, clock: () => ({ wallTime: now, monotonicMillis: 0 }), startupDiagnostic: event => events.push(event) });
  if (category === "policy") serial = 0;
  await expect(follower.start()).rejects.toThrow();
  expect(events.at(-1)).toMatchObject({ outcome: "failure", category });
  expect(JSON.stringify(events)).not.toContain("fixture proof unavailable");
  expect(JSON.stringify(events)).not.toContain(url);
  expect(state.head()).toBeNull();
});

it("appends bounded complete ranges from the actual durable cursor across turns", async () => {
  const follower = open(); await follower.start(); await follower.turn();
  expect(await follower.turn()).toMatchObject({ state: "progress", blocks: 32, head: chain.ref(1333) });
  expect(await follower.turn()).toMatchObject({ state: "progress", blocks: 32, head: chain.ref(1365) });
  expect(await follower.turn()).toMatchObject({ state: "idle", head: chain.ref(1365) });
  expect(state.feeFacts().chainTime).toBe(now); expect(requests).toBeGreaterThan(0);
});

it("keeps a 32-block catch-up turn within the shared proxy capacity", async () => {
  const follower = open(); await follower.start(); await follower.turn();
  const before = { httpRequests, requests };
  expect(await follower.turn()).toMatchObject({ state: "progress", blocks: 32, head: chain.ref(1333) });
  expect(httpRequests - before.httpRequests).toBeLessThan(50);
  expect(requests - before.requests).toBeLessThan(110);
});

it.each(["truncated", "duplicate-id", "wrong-id", "rpc-error"] as const)("retains its cursor when a shared HTTP proof response is %s", async fault => {
  const follower = open(); await follower.start(); await follower.turn();
  const head = state.head(), before = effectRequests; responseFault = fault;
  await expect(follower.turn()).rejects.toThrow();
  expect(state.head()).toEqual(head); expect(effectRequests - before).toBe(1);
});

it.each(["headers", "body"] as const)("drains a shared HTTP proof request cancelled during %s without starting another group", async phase => {
  const abort = new AbortController(), follower = open(abort.signal); await follower.start(); await follower.turn();
  const head = state.head(), before = effectRequests;
  const started = new Promise<void>(resolve => { effectsStarted = resolve; });
  const closed = new Promise<void>(resolve => { effectsClosed = resolve; });
  stallEffects = phase;
  const originalFetch = globalThis.fetch, spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const response = await originalFetch(input, init);
    const calls = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (phase !== "body" || !Array.isArray(calls) || !calls.some(call => call.method === "state_getReadProof") || !response.body) return response;
    return new Response(response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
      controller.enqueue(chunk); effectsStarted?.();
    } })), { status: response.status, headers: response.headers });
  });
  try {
    const turn = follower.turn(), rejected = expect(turn).rejects.toThrow();
    await started; abort.abort(); await rejected; await closed;
    expect(state.head()).toEqual(head); expect(effectRequests - before).toBe(1);
  } finally { abort.abort(); spy.mockRestore(); }
});

it("keeps only complete yielded blocks on an effects failure and resumes there", async () => {
  const follower = open(); await follower.start(); await follower.turn(); corruptHeight = 1310;
  await expect(follower.turn()).rejects.toThrow(); expect(state.head()).toEqual(chain.ref(1309));
  corruptHeight = 0; await follower.turn(); expect(state.head()).toEqual(chain.ref(1341));
});

it("holds an existing insufficient floor without replacing accounting storage", async () => {
  const follower = open(), startup = await follower.start(); state.recordVerifiedBlock(startup);
  await expect(follower.turn()).rejects.toThrow(/floor|history|repair/i);
  expect(state.head()).toEqual(startup.block);
});

it("refuses stale authenticated startup even if the RPC names it finalized", async () => {
  tip = 1364; await expect(open().start()).rejects.toThrow(/stale/i); expect(state.head()).toBeNull();
});

it("never rewinds durable progress for a lagging finalized-head hint", async () => {
  const follower = open(); await follower.start(); await follower.turn(); await follower.turn(); tip = 1320;
  expect(await follower.turn()).toMatchObject({ state: "idle", head: chain.ref(1333) });
  expect(state.head()).toEqual(chain.ref(1333));
});

it("honors caller cancellation and never starts a second overlapping turn", async () => {
  const abort = new AbortController(), follower = open(abort.signal);
  const starting = follower.start(); await expect(follower.start()).rejects.toThrow(/active|already/i); await starting;
  abort.abort(); await expect(follower.turn()).rejects.toThrow(); expect(state.head()).toBeNull();
});

it("rechecks retained author windows after an awaited floor probe", async () => {
  const follower = open(); await follower.start(); shiftWindow = true;
  await expect(follower.turn()).rejects.toThrow(/history|window|earlier/i); expect(state.head()).toBeNull();
});

it("replays migrated batch indexes at the exact retained block digests", async () => {
  const follower = open(); await follower.start(); await follower.turn(); await follower.turn();
  const db = new DatabaseSync(join(root, "follower.sqlite")); db.exec("update follower_blocks set batch_indexed=0 where height=1301"); db.close();
  expect(await follower.turn()).toMatchObject({ state: "progress", blocks: 32, head: chain.ref(1333) });
  expect(state.coverage().replay).toBeNull(); await follower.turn(); expect(state.head()).toEqual(chain.ref(1365));
});

it("retains a restart hold after observed history loss is repaired", async () => {
  const follower = open(); await follower.start(); await follower.turn();
  const floor = state.coverage().floor!, db = new DatabaseSync(join(root, "follower.sqlite")); db.exec("delete from follower_blocks"); db.close();
  await expect(follower.turn()).rejects.toThrow(/restart|rewound/i);
  state.recordVerifiedBlock({ network: "preprod", policyDigest: followerPolicyDigest([chain.checkpoint]), block: { height: floor.height, hash: floor.hash }, parentHash: floor.parentHash, timestamp: floor.timestamp, runtimeSpecVersion: 1000300, sends: [] });
  await expect(follower.turn()).rejects.toThrow(/restart/i);
});

it.each([false, true])("retains policy seen at construction before an older reload, restored=%s", async restored => {
  serial = 2; const follower = open();
  if (restored) { const db = new DatabaseSync(join(root, "follower.sqlite")); db.exec("delete from follower_policies"); db.close(); }
  serial = 1;
  await expect(follower.start()).rejects.toThrow(/serial|policy|continuity/i);
  expect(requests).toBe(0);
});

it("retains a newer mismatched checkpoint policy before refusing construction", () => {
  serial = 2; const original = chain.checkpoint; chain.checkpoint = { ...original, setId: original.setId + 1n };
  expect(open).toThrow(/checkpoint|policy/i);
  chain.checkpoint = original; serial = 1;
  expect(open).toThrow(/serial|policy|continuity/i);
});

it("accepts a sibling observer's legitimate policy advance before its next turn", async () => {
  const follower = open(); serial = 2; state.observeStandingPolicy(authors());
  await expect(follower.start()).resolves.toMatchObject({ block: chain.ref(1365) });
  serial = 1; await expect(follower.turn()).rejects.toThrow(/serial|policy|continuity/i);
});
