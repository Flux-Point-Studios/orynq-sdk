import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeReceiptRecord } from "@fluxpointstudios/orynq-sdk-core/checkpoint";
import { batchChain } from "../../../anchors-midnight/src/__tests__/batch-chain.js";
import { openCensusState } from "../census-state.js";
import { publishCensusPlan } from "../publisher.js";
import type { Census } from "../census.js";
import type { PublicationOptions } from "../publisher.js";

let fixture: Awaited<ReturnType<typeof batchChain>>, census: Census, directory: string, path: string, state: ReturnType<typeof openCensusState>;
let servers: Server[], urls: string[], copies: Map<string, string>[], calls: string[], rejectSecond: boolean, afterSet: (() => void) | undefined;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const publication = () => ({ network: "preprod" as const, targets: urls.map((url, i) => ({ url, apiKey: `test-writer-${i}` })) });
const verification = () => ({ source: fixture.chain.source, registries: [fixture.chain.registry], knownAuthors: fixture.authors });
const options = () => ({ verify: verification, publication: publication() });
const confirm = async () => { await publishCensusPlan(state, publication()); state.confirm(fixture.set.commitment, census); };
beforeAll(async () => {
  fixture = await batchChain({ singleBatch: true, network: "preprod" });
  const raw = JSON.parse(readFileSync(new URL("../../../core/src/__tests__/fixtures/checkpoint-receipts.json", import.meta.url), "utf8"));
  census = { genesis: fixture.batch.genesis, finalizedHeight: fixture.batch.finalizedHeight, finalizedHash: "0x" + "ab".repeat(32),
    entries: raw.receipts.map((row: { receiptId: string; raw: string }) => ({ receiptId: row.receiptId, status: "certified", record: decodeReceiptRecord(Buffer.from(row.raw, "hex")) })) };
});
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "orynq-landed-set-")); path = join(directory, "state.sqlite");
  state = openCensusState(path, { network: "preprod", genesis: census.genesis, registry: fixture.set.midnight.registry });
  expect(state.prepare(census, 0n)!.commitment).toBe(fixture.set.commitment);
  servers = []; urls = []; copies = [new Map(), new Map()]; calls = []; rejectSecond = false; afterSet = undefined;
  for (let i = 0; i < 2; i++) {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part));
      const body = Buffer.concat(chunks).toString("utf8"), key = req.url!; calls.push(`${i}:${req.method}:${key}`);
      if (req.method === "PUT") {
        expect(req.headers["x-api-key"]).toBe(`test-writer-${i}`);
        if (i === 1 && rejectSecond && key.includes("/sets/")) { res.writeHead(503).end(); return; }
        expect(sha(body)).toBe(key.split("/").at(-1)); copies[i]!.set(key, body); res.writeHead(200).end("{}"); return;
      }
      expect(req.headers["x-api-key"]).toBeUndefined();
      const stored = copies[i]!.get(key); if (stored === undefined) { res.writeHead(404).end(); return; }
      if (i === 1 && key.includes("/sets/")) afterSet?.();
      res.writeHead(200, { "content-type": "application/json" }).end(stored);
    });
    server.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve)); servers.push(server);
    urls.push(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  }
});
afterEach(async () => {
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  state.close(); rmSync(directory, { recursive: true, force: true });
});
afterAll(() => vi.restoreAllMocks());

it("lands only a confirmed exact set after real consensus proofs and both fresh retained copies", async () => {
  await confirm(); calls.length = 0;
  const result = await state.publishLandedSet(fixture.set, options());
  expect(result).toEqual({ objects: 3, readbacks: 6 }); expect(state.currentPlan()).toBeNull(); expect(state.pendingObjects()).toEqual([]);
  const firstSet = calls.findIndex(call => call.includes("/sets/")); expect(firstSet).toBeGreaterThan(0);
  expect(calls.slice(0, firstSet).filter(call => call.includes(":GET:")).length).toBe(4);
  expect(calls.slice(firstSet).some(call => call.includes("/members/") || call.includes("/plans/"))).toBe(false);
  expect(state.prepare(census, 0n)).toBeNull();
  await expect(state.publishLandedSet(fixture.set, options())).resolves.toEqual(result);
});

it("refuses unconfirmed or mismatched sets before any proof RPC or retained-store IO", async () => {
  const rpc = vi.spyOn(fixture.chain.source.node, "call");
  try {
    await expect(state.publishLandedSet(fixture.set, options())).rejects.toThrow(/confirm/i);
    await confirm(); calls.length = 0; rpc.mockClear();
    for (const set of [{ ...fixture.set, network: "mainnet" }, { ...fixture.set, materiosGenesis: "00".repeat(32) }, { ...fixture.set, anchorIds: ["00".repeat(32)] }, { ...fixture.set, midnight: { ...fixture.set.midnight, registry: "00".repeat(32) } }]) {
      await expect(state.publishLandedSet(set, options())).rejects.toThrow(/scope|member|plan/i);
    }
    expect(rpc).not.toHaveBeenCalled(); expect(calls).toEqual([]);
  } finally { rpc.mockRestore(); }
});

it("keeps a staged set confirmed after one-copy failure and recovers exact bytes after restart", async () => {
  await confirm(); rejectSecond = true;
  await expect(state.publishLandedSet(fixture.set, options())).rejects.toThrow(/store|publication/i);
  expect(state.currentPlan()!.state).toBe("confirmed");
  const staged = state.pendingObjects().filter(object => object.kind === "sets"); expect(staged).toHaveLength(1);
  state.close(); state = openCensusState(path, { network: "preprod", genesis: census.genesis, registry: fixture.set.midnight.registry });
  await expect(publishCensusPlan(state, publication())).resolves.toMatchObject({ objects: 2 });
  rejectSecond = false; await state.publishLandedSet(fixture.set, options());
  expect(state.currentPlan()).toBeNull(); expect(state.pendingObjects()).toEqual([]);
  for (const copy of copies) expect([...copy.values()]).toContain(staged[0]!.body);
});

it("rechecks current author policy after publication before completing landing", async () => {
  await confirm(); let revoked = false;
  afterSet = () => { revoked = true; };
  const verify = () => ({ ...verification(), knownAuthors: revoked ? fixture.chain.authors([{ key: fixture.key, role: "relay" }], "preprod") : fixture.authors });
  await expect(state.publishLandedSet(fixture.set, { ...options(), verify })).rejects.toThrow(/proof|author|verif/i);
  expect(state.currentPlan()!.state).toBe("confirmed");
  expect(state.pendingObjects()).toEqual([]);
  await expect(state.publishLandedSet(fixture.set, { ...options(), verify })).rejects.toThrow();
  expect(state.currentPlan()!.state).toBe("confirmed");
});

it("rolls back an atomic landing failure and retains confirmed claims for retry", async () => {
  await confirm();
  const db = new DatabaseSync(path); db.exec("create trigger reject_landing before update of state on plans when new.state='landed' begin select raise(abort,'injected landing conflict'); end"); db.close();
  await expect(state.publishLandedSet(fixture.set, options())).rejects.toThrow(/conflict/i);
  expect(state.currentPlan()!.state).toBe("confirmed");
  const fix = new DatabaseSync(path); fix.exec("drop trigger reject_landing"); fix.close();
  await state.publishLandedSet(fixture.set, options()); expect(state.prepare(census, 0n)).toBeNull();
});

it("captures scope, set bytes and publication targets before asynchronous proof reads", async () => {
  await confirm(); const set = structuredClone(fixture.set), publishing: PublicationOptions = publication();
  const verify = () => { set.midnight.txHash = "00".repeat(32); publishing.network = "mainnet"; publishing.targets[0]!.url = "https://changed.example.invalid"; return verification(); };
  await expect(state.publishLandedSet(set, { verify, publication: publishing })).resolves.toMatchObject({ objects: 3 });
});

it("keeps the opened scope independent of later caller mutations", async () => {
  const scope = { network: "preprod" as const, genesis: census.genesis, registry: fixture.set.midnight.registry };
  state.close(); state = openCensusState(path, scope); scope.registry = "00".repeat(32);
  await confirm(); await expect(state.publishLandedSet(fixture.set, options())).resolves.toMatchObject({ objects: 3 });
});

it("requires the exact staged set link to survive the final proof read", async () => {
  await confirm(); let reads = 0;
  const verify = () => {
    if (++reads === 2) { const db = new DatabaseSync(path); db.exec("delete from plan_objects where key like 'sets/%'"); db.close(); }
    return verification();
  };
  await expect(state.publishLandedSet(fixture.set, { ...options(), verify })).rejects.toThrow(/set|mapping|evidence/i);
  expect(state.currentPlan()!.state).toBe("confirmed");
});
