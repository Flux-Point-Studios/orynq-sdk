import { sha256 } from "@noble/hashes/sha2.js";
import { certHash, checkpointLeaf, merklePath, parseMemberSnapshot, SNAPSHOT_BUDGET } from "@fluxpointstudios/orynq-sdk-core/checkpoint";
import { BATCH_PROOF_FORMAT, parseBatchSet, verifyBatchProof, type BatchProofResult } from "./batch-proof.js";
import { hash32, type Hash32 } from "./commitment.js";
import { checkpointId } from "./checkpoints.js";
import { knownAuthors } from "./known-authors.js";
import { MIDNIGHT_REGISTRIES, assertRegistryGenerations, type MidnightNetwork } from "./registries.js";
import { rpcOnlySource } from "./rpc-source.js";
import { toHex } from "./scale.js";
import type { VerifyOptions } from "./verify.js";

export interface ReceiptProofQuery {
  network: MidnightNetwork;
  materiosGenesis: Hash32;
  receiptId: Hash32;
  contentHash: Hash32;
  certificateHash: Hash32;
}

interface DiscoveryPosition {
  memberAfter: string | null;
  member: { sha256: string; anchorId: string; nextCursor: string | null } | null;
  registry: number;
  setAfter: string | null;
}
export interface DiscoveryContinuation extends DiscoveryPosition {
  format: "orynq-midnight-discovery/v1";
  context: string;
  retry: DiscoveryPosition | null;
}

export type ReceiptDiscoveryOptions = Pick<VerifyOptions, "registries" | "knownAuthors" | "checkpoints" | "maxSetChanges"> & {
  gatewayUrl: string;
  nodeUrl: string;
  signal?: AbortSignal;
  budget?: { requests?: number; bytes?: number; milliseconds?: number };
  continuation?: DiscoveryContinuation;
};

type PortableProof = {
  format: typeof BATCH_PROOF_FORMAT; network: MidnightNetwork; materiosGenesis: string;
  receipt: { receiptId: string; contentHash: string; baseRootSha256: string; storageLocatorHash: string; certFormat: "scale-v1" | "dcbor-v1"; certChainId: string | null };
  batch: { index: number; count: number; path: string[]; rootHash: string; manifest: ReturnType<typeof parseMemberSnapshot>["manifest"] };
  set: { commitment: string; anchorIds: string[] };
  midnight: ReturnType<typeof parseBatchSet>["midnight"];
};
export type ReceiptDiscoveryResult =
  | { status: "valid"; proof: PortableProof; verification: Extract<BatchProofResult, { status: "valid" }> }
  | { status: "unresolved"; exhaustedHints: boolean; continuation: DiscoveryContinuation | null; diagnostics: string[] };

const encode = new TextEncoder();
const digest = (text: string) => toHex(sha256(encode.encode(text)));
const canonicalHash = (value: unknown): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error("Invalid discovery digest");
  return value;
};
const nullableHash = (value: unknown) => value === null ? null : canonicalHash(value);
function endpoint(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) throw new Error("Discovery URL must be HTTPS or loopback HTTP without credentials, query or fragment");
  return url.href.replace(/\/$/, "");
}
function bounded(value: number | undefined, fallback: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new Error("Invalid discovery budget");
  return result;
}
function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) throw new Error("Invalid discovery fields");
  return value as Record<string, unknown>;
}

// Gateway candidates locate evidence; exhaustion never proves absence or coverage.
export async function discoverReceiptProof(request: ReceiptProofQuery, options: ReceiptDiscoveryOptions): Promise<ReceiptDiscoveryResult> {
  if (request.network !== "mainnet" && request.network !== "preprod") throw new Error("Unknown Midnight network");
  const query = { network: request.network, materiosGenesis: toHex(hash32(request.materiosGenesis, "materiosGenesis")), receiptId: toHex(hash32(request.receiptId, "receiptId")), contentHash: toHex(hash32(request.contentHash, "contentHash")), certificateHash: toHex(hash32(request.certificateHash, "certificateHash")) };
  const gateway = endpoint(options.gatewayUrl), node = endpoint(options.nodeUrl);
  const registries = structuredClone(options.registries ?? MIDNIGHT_REGISTRIES[query.network]);
  assertRegistryGenerations(registries);
  if (registries.length > 64) throw new Error("Discovery accepts at most 64 registry generations");
  if (options.maxSetChanges !== undefined && (!Number.isSafeInteger(options.maxSetChanges) || options.maxSetChanges < 0 || options.maxSetChanges > 2016)) throw new Error("Invalid finality budget");
  const authors = options.knownAuthors ?? knownAuthors();
  const contextOf = () => digest(JSON.stringify({ query, gateway, node, registries, serial: authors.serial, authors: authors.authors(query.network), checkpoints: [...authors.checkpoints(query.network), ...(options.checkpoints ?? [])].map(checkpointId), maxSetChanges: options.maxSetChanges ?? null }));
  const context = contextOf();
  let cursor: DiscoveryContinuation = { format: "orynq-midnight-discovery/v1", context, memberAfter: null, member: null, registry: 0, setAfter: null, retry: null };
  const position = (value: DiscoveryPosition): DiscoveryPosition => structuredClone({ memberAfter: value.memberAfter, member: value.member, registry: value.registry, setAfter: value.setAfter });
  const checkedPosition = (supplied: Record<string, unknown>): DiscoveryPosition => {
    if (!Number.isSafeInteger(supplied.registry) || (supplied.registry as number) < 0 || (supplied.registry as number) > registries.length) throw new Error("scope");
    const member = supplied.member === null ? null : record(supplied.member, ["sha256", "anchorId", "nextCursor"]);
    const result = { memberAfter: nullableHash(supplied.memberAfter), setAfter: nullableHash(supplied.setAfter), registry: supplied.registry as number,
      member: member ? { sha256: canonicalHash(member.sha256), anchorId: canonicalHash(member.anchorId), nextCursor: nullableHash(member.nextCursor) } : null };
    if (!result.member && (result.registry !== 0 || result.setAfter !== null)) throw new Error("state");
    if (result.member && ((result.memberAfter !== null && result.member.sha256 <= result.memberAfter) || (result.member.nextCursor !== null && result.member.nextCursor < result.member.sha256))) throw new Error("order");
    return result;
  };
  if (options.continuation) {
    try {
      const supplied = record(options.continuation, ["format", "context", "memberAfter", "member", "registry", "setAfter", "retry"]);
      if (supplied.format !== cursor.format || supplied.context !== context) throw new Error("scope");
      const retry = supplied.retry === null ? null : checkedPosition(record(supplied.retry, ["memberAfter", "member", "registry", "setAfter"]));
      cursor = { ...cursor, ...checkedPosition(supplied), retry };
    } catch { throw new Error("Continuation differs from the discovery query or policy"); }
  }
  const budget = { requests: bounded(options.budget?.requests, 64, 256), bytes: bounded(options.budget?.bytes, 8 * 1024 * 1024, 64 * 1024 * 1024), abort: new AbortController() };
  const deadline = new AbortController(), milliseconds = bounded(options.budget?.milliseconds, 30_000, 90_000);
  const signal = AbortSignal.any([budget.abort.signal, deadline.signal, ...(options.signal ? [options.signal] : [])]);
  const timer = setTimeout(() => deadline.abort(), milliseconds);
  const diagnostics = new Set<string>();
  const retain = (code: string) => { diagnostics.add(code); cursor.retry ??= position(cursor); };
  const unresolved = (exhaustedHints = false): ReceiptDiscoveryResult => ({ status: "unresolved", exhaustedHints: exhaustedHints && cursor.retry === null,
    continuation: exhaustedHints ? (cursor.retry ? { ...cursor, ...cursor.retry, retry: null } : null) : structuredClone(cursor), diagnostics: [...diagnostics] });
  const active = () => { if (signal.aborted) throw new Error("Discovery interrupted"); };
  const get = async (path: string, maxBytes: number): Promise<string> => {
    active();
    if (budget.requests === 0) { budget.abort.abort(); throw new Error("Discovery request budget"); }
    budget.requests--;
    const attempt = new AbortController(), attemptTimer = setTimeout(() => attempt.abort(), 15_000);
    try {
      const response = await fetch(`${gateway}${path}`, { redirect: "error", signal: AbortSignal.any([signal, attempt.signal]) });
      if (!response.ok || !response.body) throw new Error("Discovery HTTP unavailable");
      const decoder = new TextDecoder("utf-8", { fatal: true }); let text = "", bytes = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value: chunk } = await reader.read(); if (done) break;
          bytes += chunk.byteLength;
          if (chunk.byteLength > budget.bytes) { budget.bytes = 0; budget.abort.abort(); throw new Error("Discovery byte budget"); }
          budget.bytes -= chunk.byteLength;
          if (bytes > maxBytes) throw new Error("Discovery object budget");
          text += decoder.decode(chunk, { stream: true }); active();
        }
      } finally { reader.releaseLock(); }
      text += decoder.decode(); active(); return text;
    } catch { attempt.abort(); throw new Error("Discovery read unavailable"); }
    finally { clearTimeout(attemptTimer); }
  };
  const prefix = `/midnight/${query.network}`;
  const page = async (path: string, after: string | null, members: boolean) => {
    const response = record(JSON.parse(await get(`${prefix}/${path}?limit=1${after ? `&cursor=${after}` : ""}`, 16_384)), ["candidates", "unreadableCandidates", "nextCursor"]);
    if (!Array.isArray(response.candidates) || !Array.isArray(response.unreadableCandidates) || response.candidates.length + response.unreadableCandidates.length > 1) throw new Error("Invalid discovery page");
    const nextCursor = nullableHash(response.nextCursor);
    if (nextCursor !== null && after !== null && nextCursor <= after) throw new Error("Nonadvancing discovery page");
    for (const value of response.unreadableCandidates) {
      const sha = canonicalHash(value); if (after !== null && sha <= after) throw new Error("Invalid discovery order");
    }
    const candidates = response.candidates.map(value => {
      const candidate = record(value, members ? ["sha256", "anchorId"] : ["sha256"]), sha256 = canonicalHash(candidate.sha256);
      if ((after !== null && sha256 <= after) || (nextCursor !== null && sha256 > nextCursor)) throw new Error("Invalid discovery order");
      return { sha256, anchorId: members ? canonicalHash(candidate.anchorId) : "" };
    });
    return { candidates, nextCursor, damaged: response.unreadableCandidates.length > 0 };
  };
  const object = async (kind: string, sha: string) => {
    const body = await get(`${prefix}/objects/${kind}/${sha}`, SNAPSHOT_BUDGET);
    if (digest(body) !== sha) throw new Error("Discovery object digest differs");
    return body;
  };
  const nextMember = (): boolean => {
    const next = cursor.member!.nextCursor;
    if (next === null) return false;
    cursor = { ...cursor, memberAfter: next, member: null, registry: 0, setAfter: null }; return true;
  };
  try {
    while (true) {
      active();
      if (!cursor.member) {
        const found = await page(`members/by-leaf/${query.materiosGenesis}/${checkpointLeaf(query.materiosGenesis, query.receiptId, query.certificateHash).slice(2)}`, cursor.memberAfter, true);
        if (found.damaged) retain("unreadable-member-hint");
        const candidate = found.candidates[0];
        if (!candidate) {
          if (found.nextCursor === null) return unresolved(true);
          cursor.memberAfter = found.nextCursor; continue;
        }
        cursor.member = { ...candidate, nextCursor: found.nextCursor };
      }
      let batch: ReturnType<typeof parseMemberSnapshot>;
      try { batch = parseMemberSnapshot(await object("members", cursor.member.sha256)); }
      catch { active(); retain("unreadable-members"); if (nextMember()) continue; return unresolved(true); }
      const index = batch.receipts.findIndex(member => member.receiptId === query.receiptId), member = batch.receipts[index];
      if (batch.genesis !== query.materiosGenesis || batch.anchorId.slice(2) !== cursor.member.anchorId || !member || member.contentHash !== query.contentHash || certHash(member.certFormat, batch.genesis, member.receiptId, member).slice(2) !== query.certificateHash) {
        diagnostics.add("receipt-identity-mismatch"); if (nextMember()) continue; return unresolved(true);
      }
      while (cursor.registry < registries.length) {
        active(); const registry = registries[cursor.registry]!;
        const found = await page(`sets/by-anchor/${query.materiosGenesis}/${registry.address}/${batch.anchorId.slice(2)}`, cursor.setAfter, false);
        if (found.damaged) retain("unreadable-set-hint");
        const candidate = found.candidates[0];
        if (candidate) {
          let set: ReturnType<typeof parseBatchSet> | undefined;
          try { set = parseBatchSet(JSON.parse(await object("sets", candidate.sha256))); }
          catch { active(); retain("unreadable-set"); }
          if (set) {
            if (set.network !== query.network || set.materiosGenesis !== query.materiosGenesis || set.midnight.registry !== registry.address || !set.anchorIds.includes(batch.anchorId.slice(2))) diagnostics.add("set-scope-mismatch");
            else {
              const proof: PortableProof = { format: BATCH_PROOF_FORMAT, network: query.network, materiosGenesis: query.materiosGenesis,
                receipt: { receiptId: member.receiptId, contentHash: member.contentHash, baseRootSha256: member.baseRootSha256, storageLocatorHash: member.storageLocatorHash, certFormat: member.certFormat.format, certChainId: member.certFormat.chainId },
                batch: { index, count: batch.receipts.length, path: merklePath(batch.leafHashes, index).map(value => value.slice(2)), rootHash: batch.rootHash.slice(2), manifest: batch.manifest },
                set: { commitment: set.commitment, anchorIds: set.anchorIds }, midnight: set.midnight };
              try {
                const source = rpcOnlySource({ network: query.network, node, registries, hints: [set.midnight], signal, httpBudget: budget });
                const verification = await verifyBatchProof({ proof, network: query.network, materiosGenesis: query.materiosGenesis, contentHash: query.contentHash }, { source, registries, knownAuthors: authors, ...(options.checkpoints ? { checkpoints: options.checkpoints } : {}), ...(options.maxSetChanges !== undefined ? { maxSetChanges: options.maxSetChanges } : {}) });
                active();
                if (contextOf() !== context) { retain("policy-changed"); return unresolved(); }
                if (verification.status === "valid") return { status: "valid", proof, verification };
                diagnostics.add(verification.status);
                if (verification.status === "unavailable") retain("unavailable-proof");
              } catch { active(); retain("unavailable-proof"); }
            }
          }
        }
        active();
        if (found.nextCursor !== null) cursor.setAfter = found.nextCursor;
        else { cursor.registry++; cursor.setAfter = null; }
      }
      if (!nextMember()) return unresolved(true);
    }
  } catch { diagnostics.add(signal.aborted ? "interrupted" : "unavailable-hints"); return unresolved(); }
  finally { clearTimeout(timer); deadline.abort(); }
}
