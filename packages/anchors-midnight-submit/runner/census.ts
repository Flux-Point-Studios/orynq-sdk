import { blake2b } from "@noble/hashes/blake2.js";
import { fetch } from "undici";
import { certFormatOf, decodeReceiptRecord, type ReceiptRecord } from "@fluxpointstudios/orynq-sdk-core/checkpoint";

// Twox128(OrinqReceipts) || Twox128(Receipts); the runtime uses Blake2_128Concat<H256>.
const PREFIX = "0xf2f45ef88f71bc25f444a160450145be5087a88ab53079a394ab62a465d46183";
const RESPONSE_LIMIT = 16 * 1024 * 1024;
const RECEIPT_LIMIT = 262_144;
const PAGE_SIZE = 256;

export type CensusEntry =
  | { receiptId: string; status: "pending"; reason: "missing" | "decode" }
  | { receiptId: string; status: "certified" | "uncertified" | "contradicted"; record: ReceiptRecord };

export interface Census {
  genesis: string;
  finalizedHash: string;
  finalizedHeight: number;
  entries: CensusEntry[];
}

export async function readCensus(options: { rpcUrl: string; genesis: string; signal?: AbortSignal }): Promise<Census> {
  const url = new URL(options.rpcUrl);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error("Census requires an explicit HTTPS RPC or loopback test endpoint without credentials");
  if (!/^(?:0x)?[a-f0-9]{64}$/.test(options.genesis)) throw new Error("Invalid census genesis");
  const genesis = options.genesis.replace(/^0x/, "");
  const runSignal = AbortSignal.any([AbortSignal.timeout(90_000), ...(options.signal ? [options.signal] : [])]);
  let sequence = 0;
  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    runSignal.throwIfAborted();
    const id = ++sequence;
    const response = await fetch(url, {
      method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", "User-Agent": "orynq-midnight-census/1.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.any([runSignal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok || Number(response.headers.get("content-length")) > RESPONSE_LIMIT) {
      await response.body?.cancel();
      throw new Error(response.ok ? "Census RPC response exceeds size limit" : `Census RPC HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("Empty census RPC response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > RESPONSE_LIMIT) throw new Error("Census RPC response exceeds size limit");
      chunks.push(chunk);
    }
    runSignal.throwIfAborted();
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new Error("Malformed census RPC response"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid census RPC envelope");
    const envelope = value as Record<string, unknown>;
    if (envelope.jsonrpc !== "2.0" || envelope.id !== id || !("result" in envelope) || "error" in envelope) throw new Error("Invalid census RPC envelope");
    return envelope.result;
  }

  if (await rpc("chain_getBlockHash", [0]) !== `0x${genesis}`) throw new Error("Census RPC genesis differs from policy");
  const finalizedHash = await rpc("chain_getFinalizedHead", []);
  if (typeof finalizedHash !== "string" || !/^0x[a-f0-9]{64}$/.test(finalizedHash)) throw new Error("Invalid finalized census hash");
  const header = await rpc("chain_getHeader", [finalizedHash]);
  if (!header || typeof header !== "object" || Array.isArray(header)) throw new Error("Invalid finalized census header");
  const number = (header as Record<string, unknown>).number;
  if (typeof number !== "string" || !/^0x[a-f0-9]{1,16}$/.test(number)) throw new Error("Invalid finalized census height");
  const finalizedHeight = Number(BigInt(number));
  if (!Number.isSafeInteger(finalizedHeight)) throw new Error("Invalid finalized census height");
  const entries: CensusEntry[] = [];
  let cursor: string | null = null;
  while (true) {
    const keys = await rpc("state_getKeysPaged", [PREFIX, PAGE_SIZE, cursor, finalizedHash]);
    if (!Array.isArray(keys) || keys.length > PAGE_SIZE) throw new Error("Invalid receipt storage key page");
    if (!keys.length) break;
    const page: { key: string; receiptId: string }[] = [];
    for (const key of keys) {
      if (typeof key !== "string" || !/^0x[a-f0-9]{160}$/.test(key) || !key.startsWith(PREFIX)) throw new Error("Invalid receipt storage key");
      if (cursor !== null && key <= cursor) throw new Error("Receipt pagination did not advance");
      const receiptId = key.slice(-64);
      const hash = Buffer.from(blake2b(Buffer.from(receiptId, "hex"), { dkLen: 16 })).toString("hex");
      if (key.slice(PREFIX.length, PREFIX.length + 32) !== hash) throw new Error("Invalid receipt storage key concat hash");
      cursor = key;
      page.push({ key, receiptId });
    }
    if (entries.length + page.length > RECEIPT_LIMIT) throw new Error("Census receipt limit exceeded; coverage is incomplete");
    const result = await rpc("state_queryStorageAt", [page.map(row => row.key), finalizedHash]);
    if (!Array.isArray(result) || result.length !== 1) throw new Error("Invalid census storage response");
    const changeSet = result[0] as { block?: unknown; changes?: unknown } | null;
    if (!changeSet || changeSet.block !== finalizedHash || !Array.isArray(changeSet.changes)) throw new Error("Invalid census storage response block");
    const wanted = new Set(page.map(row => row.key));
    const values = new Map<string, unknown>();
    for (const change of changeSet.changes) {
      if (!Array.isArray(change) || change.length !== 2 || !wanted.has(change[0]) || values.has(change[0])) throw new Error("Invalid census storage response keys");
      values.set(change[0] as string, change[1]);
    }
    for (const { key, receiptId } of page) {
      const raw = values.get(key);
      if (raw === null || raw === undefined) { entries.push({ receiptId, status: "pending", reason: "missing" }); continue; }
      let record: ReceiptRecord;
      try {
        if (typeof raw !== "string" || !/^0x(?:[a-f0-9]{2}){1,394}$/.test(raw)) throw new Error("Invalid receipt encoding");
        record = decodeReceiptRecord(Buffer.from(raw.slice(2), "hex"));
      } catch { entries.push({ receiptId, status: "pending", reason: "decode" }); continue; }
      const status = record.availabilityCertHash.replace(/^0x/, "") === "00".repeat(32) ? "uncertified" : certFormatOf(record, genesis, receiptId) ? "certified" : "contradicted";
      entries.push({ receiptId, status, record });
    }
  }
  runSignal.throwIfAborted();
  return { genesis, finalizedHash, finalizedHeight, entries };
}
