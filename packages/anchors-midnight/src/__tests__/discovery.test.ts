import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { certHash } from "@fluxpointstudios/orynq-sdk-core/checkpoint";
import { discoverReceiptProof } from "../discovery.js";
import { batchChain } from "./batch-chain.js";

let fixture: Awaited<ReturnType<typeof batchChain>>, gateway: Server, rpc: Server, gatewayUrl: string, nodeUrl: string;
let objects: Map<string, string>, memberSha: string, sets: string[], calls: number, requests: number, corrupt: boolean, emptyFirst: boolean, nonadvancing: boolean;
let stallProof: boolean, proofClosed: Promise<void>, notifyProof: () => void;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const listen = async (server: Server) => { server.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve)); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; };
const close = async (server: Server) => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); };
const query = () => ({ network: "mainnet" as const, materiosGenesis: fixture.batch.genesis, receiptId: fixture.proof.receipt.receiptId, contentHash: fixture.proof.receipt.contentHash,
  certificateHash: certHash(fixture.batch.receipts[0]!.certFormat, fixture.batch.genesis, fixture.proof.receipt.receiptId, fixture.batch.receipts[0]!).slice(2) });
const options = () => ({ gatewayUrl, nodeUrl, registries: [fixture.chain.registry], knownAuthors: fixture.authors, budget: { requests: 128, bytes: 16 * 1024 * 1024, milliseconds: 30_000 } });

beforeAll(async () => {
  fixture = await batchChain();
  gateway = createServer((req, res) => {
    requests++;
    const url = new URL(req.url!, "http://localhost");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname.includes("/objects/")) {
      const key = url.pathname.split("/").at(-1)!, body = objects.get(key);
      if (!body) { res.writeHead(404).end("{}"); return; }
      res.end(corrupt && key === memberSha ? `${body} ` : body); return;
    }
    const cursor = url.searchParams.get("cursor");
    if (nonadvancing) { res.end(JSON.stringify({ candidates: [], unreadableCandidates: [], nextCursor: cursor ?? "00".repeat(32) })); return; }
    if (url.pathname.includes("/members/by-leaf/")) {
      if (emptyFirst && !cursor) { res.end(JSON.stringify({ candidates: [], unreadableCandidates: ["00".repeat(32)], nextCursor: "00".repeat(32) })); return; }
      res.end(JSON.stringify({ candidates: [{ sha256: memberSha, anchorId: fixture.batch.anchorId.slice(2) }], unreadableCandidates: [], nextCursor: null })); return;
    }
    const available = sets.filter(sha => !cursor || sha > cursor);
    res.end(JSON.stringify({ candidates: available.slice(0, 1).map(sha256 => ({ sha256 })), unreadableCandidates: [], nextCursor: available.length > 1 ? available[0] : null }));
  });
  rpc = createServer((req, res) => {
    let body = ""; req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      const incoming = JSON.parse(body);
      const answer = async (call: { id: number; method: string; params: unknown[] }) => { calls++; return { jsonrpc: "2.0", id: call.id, result: await fixture.chain.source.node.call(call.method, call.params) }; };
      if (stallProof && (Array.isArray(incoming) ? incoming : [incoming]).some(call => call.method === "state_getReadProof")) {
        res.on("close", notifyProof); return;
      }
      try { res.end(JSON.stringify(Array.isArray(incoming) ? await Promise.all(incoming.map(answer)) : await answer(incoming))); }
      catch (error) { res.writeHead(500).end(JSON.stringify({ error: error instanceof Error ? error.message : "test RPC error" })); }
    });
  });
  gatewayUrl = await listen(gateway); nodeUrl = await listen(rpc);
});
afterAll(async () => { await close(gateway); await close(rpc); });
beforeEach(() => {
  memberSha = digest(fixture.snapshot); const setText = JSON.stringify(fixture.set), setSha = digest(setText);
  objects = new Map([[memberSha, fixture.snapshot], [setSha, setText]]); sets = [setSha];
  calls = 0; requests = 0; corrupt = false; emptyFirst = false; nonadvancing = false; stallProof = false;
  proofClosed = new Promise(resolve => { notifyProof = resolve; });
});

it("discovers the exact receipt with portable proof and real consensus verification", async () => {
  const result = await discoverReceiptProof(query(), options());
  expect(result.status).toBe("valid");
  if (result.status !== "valid") throw new Error(JSON.stringify(result));
  expect(result.verification.receiptId).toBe(query().receiptId);
  expect(result.verification.certificateHash).toBe(query().certificateHash);
  expect(result.verification.anchor.assurance).toBe("consensus-verified");
  expect(result.proof).toEqual(fixture.proof); expect(calls).toBeGreaterThan(10);
});

it.each(["receiptId", "certificateHash", "contentHash"] as const)("rejects gateway identity substitution for %s before any RPC", async field => {
  const result = await discoverReceiptProof({ ...query(), [field]: "aa".repeat(32) }, options());
  expect(result.status).toBe("unresolved"); expect(calls).toBe(0);
});

it("isolates a bad first set hint and continues to a valid later candidate", async () => {
  const bad = { ...fixture.set, midnight: { ...fixture.set.midnight, txHash: "aa".repeat(32) } };
  let body = JSON.stringify(bad), sha = digest(body);
  for (let i = 0; sha >= sets[0]! && i < 1024; i++) { body += " "; sha = digest(body); }
  expect(sha < sets[0]!).toBe(true); objects.set(sha, body); sets.unshift(sha);
  const result = await discoverReceiptProof(query(), options()); expect(result.status).toBe("valid");
});

it("preserves forward progress beyond an unreadable first set when a later budget stops the run", async () => {
  const good = sets[0]!; let bad = "00".repeat(32);
  if (bad >= good) throw new Error("Fixture digest ordering");
  objects.set(bad, "corrupt object"); sets.unshift(bad);
  const first = await discoverReceiptProof(query(), { ...options(), budget: { requests: 6, bytes: 16 * 1024 * 1024, milliseconds: 30_000 } });
  expect(first.status).toBe("unresolved"); if (first.status !== "unresolved") return;
  expect(first.continuation?.setAfter).toBe(bad);
  expect((await discoverReceiptProof(query(), { ...options(), continuation: first.continuation! })).status).toBe("valid");
});

it("retains a byte-corrupt object for repair and resumes with fresh verification", async () => {
  corrupt = true; const failed = await discoverReceiptProof(query(), options());
  expect(failed.status).toBe("unresolved"); if (failed.status !== "unresolved") return;
  expect(failed.exhaustedHints).toBe(false); expect(failed.continuation).not.toBeNull(); expect(calls).toBe(0);
  corrupt = false; expect((await discoverReceiptProof(query(), { ...options(), continuation: failed.continuation! })).status).toBe("valid");
});

it("follows an empty damaged page's continuation without claiming absence", async () => {
  emptyFirst = true; const result = await discoverReceiptProof(query(), options()); expect(result.status).toBe("valid");
});

it("resumes after the shared request budget stops immediately after a member page", async () => {
  const failed = await discoverReceiptProof(query(), { ...options(), budget: { requests: 1, bytes: 1024 * 1024, milliseconds: 30_000 } });
  expect(failed.status).toBe("unresolved"); if (failed.status !== "unresolved") return;
  expect(requests).toBe(1); expect(failed.exhaustedHints).toBe(false);
  expect((await discoverReceiptProof(query(), { ...options(), continuation: failed.continuation! })).status).toBe("valid");
});

it("binds continuation to the caller's full policy, even at the same author serial", async () => {
  corrupt = true; const failed = await discoverReceiptProof(query(), options()); if (failed.status !== "unresolved") throw new Error("Expected held proof");
  const before = requests;
  const authors = { ...fixture.authors, authors: (network: "mainnet" | "preprod") => fixture.authors.authors(network).map(author => ({ ...author, validTo: 0 })) };
  await expect(discoverReceiptProof(query(), { ...options(), knownAuthors: authors, continuation: failed.continuation! })).rejects.toThrow("Continuation");
  expect(requests).toBe(before);
});

it("aborts real proof RPC sockets and retains the current candidate despite verifier error handling", async () => {
  stallProof = true;
  const failed = await discoverReceiptProof(query(), { ...options(), budget: { requests: 128, bytes: 16 * 1024 * 1024, milliseconds: 250 } });
  expect(failed.status).toBe("unresolved"); if (failed.status !== "unresolved") return;
  expect(failed.exhaustedHints).toBe(false); await proofClosed;
  stallProof = false; expect((await discoverReceiptProof(query(), { ...options(), continuation: failed.continuation! })).status).toBe("valid");
});

it("stops a nonadvancing candidate cursor within the shared budget", async () => {
  nonadvancing = true; const result = await discoverReceiptProof(query(), options());
  expect(result.status).toBe("unresolved"); if (result.status !== "unresolved") return;
  expect(result.exhaustedHints).toBe(false); expect(requests).toBe(2); expect(calls).toBe(0);
});

it("charges RPC response bytes to the same budget and resumes the unfinished set", async () => {
  const failed = await discoverReceiptProof(query(), { ...options(), budget: { requests: 128, bytes: 2048, milliseconds: 30_000 } });
  expect(failed.status).toBe("unresolved"); if (failed.status !== "unresolved") return;
  expect(failed.exhaustedHints).toBe(false); expect(calls).toBeGreaterThan(0);
  expect((await discoverReceiptProof(query(), { ...options(), continuation: failed.continuation! })).status).toBe("valid");
});

it("returns unresolved without HTTP and never exposes a caller's private abort reason", async () => {
  const abort = new AbortController(); abort.abort("private caller information");
  const result = await discoverReceiptProof(query(), { ...options(), signal: abort.signal });
  expect(result.status).toBe("unresolved"); expect(requests).toBe(0); expect(calls).toBe(0);
  expect(JSON.stringify(result)).not.toContain("private caller information");
});

it("checks the current author window and never treats hint exhaustion as verified coverage", async () => {
  const authors = { ...fixture.authors, author: () => ({ status: "outside-window" as const, id: "revoked", role: "batch" as const, validFrom: 0, validTo: 1 }) };
  const result = await discoverReceiptProof(query(), { ...options(), knownAuthors: authors });
  expect(result.status).toBe("unresolved"); if (result.status !== "unresolved") return;
  expect(result.diagnostics).toContain("author-revoked"); expect("proof" in result).toBe(false);
});
