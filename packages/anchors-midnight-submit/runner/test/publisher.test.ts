import { afterEach, beforeEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { certHash, decodeReceiptRecord } from "@fluxpointstudios/orynq-sdk-core/checkpoint";
import { openCensusState } from "../census-state.js";
import { publishCensusPlan } from "../publisher.js";
import type { Census } from "../census.js";

const fixture = JSON.parse(readFileSync(new URL("../../../core/src/__tests__/fixtures/checkpoint-receipts.json", import.meta.url), "utf8"));
const genesis = fixture.genesis as string, registry = "43".repeat(32), receiptId = "ab".repeat(32);
const record = decodeReceiptRecord(Buffer.from(fixture.receipts[0].raw, "hex"));
record.availabilityCertHash = certHash({ format: "scale-v1", chainId: null }, genesis, receiptId, record);
const census: Census = { genesis, finalizedHash: "0x" + "bb".repeat(32), finalizedHeight: 100, entries: [{ receiptId, status: "certified", record }] };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
let directory: string, state: ReturnType<typeof openCensusState>, servers: Server[], urls: string[], stored: Map<string, string>[], calls: string[];
let rejectSecond = false, corruptSecond = false, redirectSecond = false;
let holdMemberReads = false;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "orynq-publisher-"));
  state = openCensusState(join(directory, "census.sqlite"), { network: "preprod", genesis, registry }); state.prepare(census, 100n);
  servers = []; urls = []; stored = [new Map(), new Map()]; calls = []; rejectSecond = false; corruptSecond = false; redirectSecond = false;
  holdMemberReads = false;
  const waiting: (() => void)[] = [];
  for (let i = 0; i < 2; i++) {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8"), path = req.url!;
      calls.push(`${i}:${req.method}:${path}`);
      if (req.method === "PUT") {
        expect(req.headers["x-api-key"]).toBe(`fixture-writer-${i}`);
        if (i === 1 && rejectSecond) { res.writeHead(503).end(); return; }
        if (i === 1 && redirectSecond) { res.writeHead(307, { location: urls[0] + path }).end(); return; }
        const expected = path.split("/").at(-1)!; expect(sha(body)).toBe(expected);
        stored[i]!.set(path, body); res.writeHead(200).end("{}"); return;
      }
      expect(req.headers["x-api-key"]).toBeUndefined();
      if (i === 0 && holdMemberReads && path.includes("/members/")) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { res.writeHead(503).end(); resolve(); }, 750);
          waiting.push(() => { clearTimeout(timer); resolve(); });
          if (waiting.length === 2) { holdMemberReads = false; for (const release of waiting) release(); }
        });
        if (res.writableEnded) return;
      }
      const value = stored[i]!.get(path);
      if (value === undefined) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(i === 1 && corruptSecond ? value + " " : value);
    });
    server.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve)); servers.push(server);
    urls.push(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  }
});
afterEach(async () => {
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  state.close(); rmSync(directory, { recursive: true, force: true });
});
const options = () => ({ network: "preprod" as const, targets: urls.map((url, i) => ({ url, apiKey: `fixture-writer-${i}` })) });

it("publishes members before plans, reads exact bytes from both copies and only then acknowledges", async () => {
  await publishCensusPlan(state, options());
  expect(state.pendingObjects()).toEqual([]);
  for (let i = 0; i < 2; i++) {
    const puts = calls.filter(call => call.startsWith(`${i}:PUT`)); expect(puts).toHaveLength(2);
    expect(puts[0]).toContain("/members/"); expect(puts[1]).toContain("/plans/");
    expect(stored[i]!.size).toBe(2);
  }
});

it("does not acknowledge a one-copy success and retries unchanged bytes after restart", async () => {
  rejectSecond = true;
  await expect(publishCensusPlan(state, options())).rejects.toThrow(/publication|store/i);
  expect(state.pendingObjects()).toHaveLength(2);
  const original = state.pendingObjects(); state.close();
  state = openCensusState(join(directory, "census.sqlite"), { network: "preprod", genesis, registry });
  rejectSecond = false; await publishCensusPlan(state, options());
  expect(state.pendingObjects()).toEqual([]);
  for (const object of original) for (const copy of stored) expect([...copy.values()]).toContain(object.body);
});

it("rejects corrupt readback even after a successful PUT", async () => {
  corruptSecond = true;
  await expect(publishCensusPlan(state, options())).rejects.toThrow(/digest|readback/i);
  expect(state.pendingObjects()).toHaveLength(2);
});

it("freshly reads all objects after acknowledgements rather than trusting prior delivery", async () => {
  await publishCensusPlan(state, options()); calls.length = 0; corruptSecond = true;
  await expect(publishCensusPlan(state, options())).rejects.toThrow(/digest|readback/i);
  expect(calls.some(call => call.startsWith("1:GET"))).toBe(true);
});

it("refuses redirects before sending a writer credential to another origin", async () => {
  redirectSecond = true;
  await expect(publishCensusPlan(state, options())).rejects.toThrow(/publication|store|redirect/i);
  expect(state.pendingObjects()).toHaveLength(2);
});

it("rejects missing or duplicate copies, unsafe URLs and a different plan network before IO", async () => {
  const valid = options();
  for (const targets of [valid.targets.slice(0, 1), [valid.targets[0]!, valid.targets[0]!], [valid.targets[0]!, { url: "http://example.com", apiKey: "fixture" }], [valid.targets[0]!, { url: urls[1] + "?key=fixture", apiKey: "fixture" }]]) {
    await expect(publishCensusPlan(state, { ...valid, targets })).rejects.toThrow();
  }
  await expect(publishCensusPlan(state, { ...valid, network: "mainnet" })).rejects.toThrow(/network/i);
  expect(calls).toEqual([]);
});

it("mainnet refuses loopback storage and hostname aliases before network IO", async () => {
  state.close();
  state = openCensusState(join(directory, "mainnet.sqlite"), { network: "mainnet", genesis, registry }); state.prepare(census, 100n);
  await expect(publishCensusPlan(state, { ...options(), network: "mainnet" })).rejects.toThrow(/store|configuration|host/i);
  await expect(publishCensusPlan(state, { network: "mainnet", targets: [{ url: "https://proofs.example.com", apiKey: "fixture" }, { url: "https://proofs.example.com.", apiKey: "fixture" }] })).rejects.toThrow(/host|store/i);
  expect(calls).toEqual([]);
});

it("mainnet refuses literal IP and localhost DNS aliases during configuration validation", async () => {
  state.close();
  state = openCensusState(join(directory, "mainnet.sqlite"), { network: "mainnet", genesis, registry }); state.prepare(census, 100n);
  const original = getGlobalDispatcher(), mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock);
  try {
    for (const host of ["127.0.0.2", "[::ffff:127.0.0.1]", "proofs.localhost", "192.168.0.131"]) {
      await expect(publishCensusPlan(state, { network: "mainnet", targets: [{ url: `https://${host}`, apiKey: "fixture" }, { url: "https://independent.example.invalid", apiKey: "fixture" }] })).rejects.toThrow(/configuration/i);
    }
  } finally { setGlobalDispatcher(original); await mock.close(); }
});

it("reads bounded member groups concurrently and finishes every member before the plan", async () => {
  state.abandon(state.currentPlan()!.commitment);
  state.prepare({ ...census, finalizedHeight: 101, finalizedHash: "0x" + "cc".repeat(32), entries: Array.from({ length: 4097 }, (_, i) => {
    const id = i === 0 ? receiptId : sha(`parallel-receipt-${i}`), fields = { ...record };
    fields.availabilityCertHash = certHash({ format: "scale-v1", chainId: null }, genesis, id, fields);
    return { receiptId: id, status: "certified" as const, record: fields };
  }) }, 100n);
  holdMemberReads = true;
  const result = await publishCensusPlan(state, options());
  expect(result.objects).toBe(3); expect(state.pendingObjects()).toEqual([]);
  const firstPlan = calls.findIndex(call => call.includes("/plans/"));
  for (const call of calls.slice(firstPlan)) expect(call).not.toContain("/members/");
});
