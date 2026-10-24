import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { readCensus } from "../census.js";

const fixture = JSON.parse(readFileSync(new URL("../../../core/src/__tests__/fixtures/checkpoint-receipts.json", import.meta.url), "utf8")) as { genesis: string; receipts: { receiptId: string; raw: string }[] };
const PREFIX = "0xf2f45ef88f71bc25f444a160450145be5087a88ab53079a394ab62a465d46183";
// Independent Polkadot util-crypto Blake2_128Concat vectors for the public receipt fixtures.
const KEYS = ["0004f641535f31320e2f33446bd0ce80", "00353395d259bd6fabf482b74a7f6411", "0073a4f77d67da2b84ef562293c5cc5e"].map((hash, i) => PREFIX + hash + fixture.receipts[i]!.receiptId);
const FINAL = "0x" + "ab".repeat(32);
type Call = { method: string; params: unknown[]; agent: string | undefined };
type Mutate = (call: Call, result: unknown) => unknown;

async function withRpc(run: (rpcUrl: string, calls: Call[], values: Map<string, string | null>) => Promise<void>, mutate: Mutate = (_, result) => result) {
  const calls: Call[] = [];
  const values = new Map(KEYS.map((key, i) => [key, "0x" + fixture.receipts[i]!.raw]));
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
    const call = { method, params, agent: request.headers["user-agent"] };
    calls.push(call);
    const results: Record<string, () => unknown> = {
      chain_getBlockHash: () => "0x" + fixture.genesis,
      chain_getFinalizedHead: () => FINAL,
      chain_getHeader: () => ({ number: "0x1234" }),
      state_getKeysPaged: () => KEYS.filter(key => params[2] === null || key > String(params[2])),
      state_queryStorageAt: () => [{ block: FINAL, changes: (params[0] as string[]).map(key => [key, values.get(key) ?? null]) }],
    };
    const result = mutate(call, results[method]?.());
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`, calls, values); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

it("reads every receipt at one finalized block with a named User-Agent and explicit genesis", () => withRpc(async (rpcUrl, calls) => {
  const census = await readCensus({ rpcUrl, genesis: fixture.genesis });
  expect(census.finalizedHash).toBe(FINAL);
  expect(census.finalizedHeight).toBe(0x1234);
  expect(census.entries.map(entry => entry.receiptId)).toEqual(fixture.receipts.slice(0, 3).map(row => row.receiptId));
  expect(census.entries.every(entry => entry.status === "certified")).toBe(true);
  for (const call of calls) {
    expect(call.agent).toBe("orynq-midnight-census/1.0");
    if (call.method === "state_getKeysPaged") expect(call.params.at(-1)).toBe(FINAL);
    if (call.method === "state_queryStorageAt" || call.method === "chain_getHeader") expect(call.params.at(-1)).toBe(FINAL);
  }
  expect(calls.filter(call => call.method === "state_getKeysPaged")).toHaveLength(2);
}));

it("rescans uncertified keys and observes certification on a later run", () => withRpc(async (rpcUrl, _calls, values) => {
  const raw = fixture.receipts[0]!.raw;
  values.set(KEYS[0]!, "0x" + raw.slice(0, -144) + "00".repeat(32) + raw.slice(-80));
  expect((await readCensus({ rpcUrl, genesis: fixture.genesis })).entries[0]!.status).toBe("uncertified");
  values.set(KEYS[0]!, "0x" + raw);
  expect((await readCensus({ rpcUrl, genesis: fixture.genesis })).entries[0]!.status).toBe("certified");
}));

it("keeps missing, malformed and contradicted receipts visible instead of claiming coverage", () => withRpc(async (rpcUrl, _calls, values) => {
  values.delete(KEYS[0]!);
  values.set(KEYS[1]!, "0xab");
  const raw = fixture.receipts[2]!.raw;
  values.set(KEYS[2]!, "0x" + raw.slice(0, -144) + "ff".repeat(32) + raw.slice(-80));
  const census = await readCensus({ rpcUrl, genesis: fixture.genesis });
  expect(census.entries.map(entry => entry.status)).toEqual(["pending", "pending", "contradicted"]);
}));

it.each(["wrong prefix", "wrong concat hash", "repeat cursor", "unordered keys"])("refuses %s", name => withRpc(async rpcUrl => {
  await expect(readCensus({ rpcUrl, genesis: fixture.genesis })).rejects.toThrow(/storage key|pagination/i);
}, (call, result) => {
  if (call.method !== "state_getKeysPaged") return result;
  if (name === "repeat cursor") return [KEYS[0]];
  if (name === "unordered keys") return [...KEYS].reverse();
  return [name === "wrong prefix" ? "0x" + "ff".repeat(32) + KEYS[0]!.slice(66) : PREFIX + "ff".repeat(16) + fixture.receipts[0]!.receiptId];
}));

it.each(["wrong block", "duplicate key", "unexpected key"])("refuses storage response %s", name => withRpc(async rpcUrl => {
  await expect(readCensus({ rpcUrl, genesis: fixture.genesis })).rejects.toThrow(/storage response/i);
}, (call, result) => {
  if (call.method !== "state_queryStorageAt") return result;
  const row = (result as { block: string; changes: unknown[][] }[])[0]!;
  if (name === "wrong block") row.block = "0x" + "00".repeat(32);
  if (name === "duplicate key") row.changes.push(row.changes[0]!);
  if (name === "unexpected key") row.changes.push([PREFIX + "ff".repeat(48), null]);
  return [row];
}));

it("refuses a different chain before enumerating any receipts", () => withRpc(async (rpcUrl, calls) => {
  await expect(readCensus({ rpcUrl, genesis: "00".repeat(32) })).rejects.toThrow(/genesis/i);
  expect(calls.some(call => call.method.startsWith("state_"))).toBe(false);
}));

it("bounds decoded HTTP response bytes before parsing", () => withRpc(async rpcUrl => {
  await expect(readCensus({ rpcUrl, genesis: fixture.genesis })).rejects.toThrow(/size|limit/i);
}, (call, result) => call.method === "state_getKeysPaged" ? "x".repeat(16 * 1024 * 1024 + 1) : result));
