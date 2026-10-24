import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as L from "@midnight-ntwrk/ledger-v8";
import { censusBatch, decodeReceiptRecord, merklePath } from "@fluxpointstudios/orynq-sdk-core/checkpoint";
import { authorKey, batchSetCommitment } from "../commitment.js";
import { authorStatusAt } from "../known-authors.js";
import { auditCheckpoints, checkpointId } from "../checkpoints.js";
import { BatchSetCache, verifyBatchProof, verifyBatchSet } from "../batch-proof.js";
import { verifyMidnightAnchor } from "../verify.js";
import { registryInitialState } from "../registry.js";
import { toHex } from "../scale.js";
import { anchorChain, fixture } from "./anchor-chain.js";
import { finalBytes, unprovenRegistryCall } from "./registry-call.js";

const h = (byte: number) => byte.toString(16).padStart(2, "0").repeat(32);
const receiptFixture = JSON.parse(readFileSync(new URL("../../../core/src/__tests__/fixtures/checkpoint-receipts.json", import.meta.url), "utf8"));
const genesis = receiptFixture.genesis;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("batch-set commitment", () => {
  it("matches the independent SHA-256 encoding for one and many members", () => {
    const tag = Buffer.alloc(32); tag.write("orynq:anchor-batches:v1");
    for (const ids of [[h(1)], [h(1), h(2), h(3)]]) {
      expect(toHex(batchSetCommitment({ materiosGenesis: genesis, anchorIds: ids }))).toBe(sha(Buffer.concat([tag, Buffer.from(genesis, "hex"), ...ids.map((id) => Buffer.from(id, "hex"))])));
    }
  });

  it("requires 1..1024 strictly ascending, unique 32-byte identifiers", () => {
    for (const ids of [[], [h(1), h(1)], [h(2), h(1)], ["zz".repeat(32)], Array(1025).fill(h(1))]) {
      expect(() => batchSetCommitment({ materiosGenesis: genesis, anchorIds: ids })).toThrow();
    }
    const ids = Array.from({ length: 1024 }, (_, i) => i.toString(16).padStart(64, "0"));
    expect(batchSetCommitment({ materiosGenesis: genesis, anchorIds: ids })).toHaveLength(32);
    expect(() => batchSetCommitment({ materiosGenesis: h(7).slice(2), anchorIds: [h(1)] })).toThrow();
  });
});

describe("checkpoint history and lookup-only author revalidation", () => {
  it("identifies every checkpoint field and permits only a prefix extension", () => {
    const cp = anchorChain().chain.checkpoint(0);
    const next = { ...cp, setId: cp.setId + 1n, startsAfter: { height: cp.startsAfter.height + 300, hash: h(8) } };
    expect(() => auditCheckpoints([cp], [cp, next])).not.toThrow();
    expect(() => auditCheckpoints([cp], [])).toThrow(/prefix|remov|drop/i);
    for (const changed of [{ ...cp, setId: cp.setId + 1n }, { ...cp, startsAfter: { ...cp.startsAfter, hash: h(9) } }, { ...cp, authorities: cp.authorities.map((a, i) => i ? a : { ...a, weight: a.weight + 1n }) }]) {
      expect(checkpointId(changed)).not.toBe(checkpointId(cp));
      expect(() => auditCheckpoints([cp], [changed])).toThrow(/prefix|edit|chang/i);
    }
  });

  it("keeps inclusive windows and retires the initial mainnet relay at 3113847", () => {
    const authors = anchorChain().authors([{ key: "6a140f2346ec16bc587b506e3d447f05ddcc9bdd72778bee578767571b061f08", validFrom: 3113832, validTo: 3113847 }]);
    const key = authors.authors("mainnet")[0]!.key;
    expect(authorStatusAt(authors, "mainnet", key, 3113832).status).toBe("known");
    expect(authorStatusAt(authors, "mainnet", key, 3113847).status).toBe("known");
    expect(authorStatusAt(authors, "mainnet", key, 3113848).status).toBe("outside-window");
    expect(authorStatusAt(authors, "mainnet", h(3), 3113847).status).toBe("unknown");
    expect(authorStatusAt(authors, "preprod", key, 3113847).status).toBe("unknown");
  });
});

describe("portable receipt-to-Midnight proofs", () => {
  let chain: ReturnType<typeof anchorChain>;
  let bundle: any;
  let key: string;
  const options = () => ({ source: chain.source, registries: [chain.registry], knownAuthors: chain.authors([{ key, id: "fluxpoint-batch", role: "batch" }]) });
  const request = (proof = bundle) => ({ proof, network: "mainnet" as const, materiosGenesis: genesis, contentHash: bundle.receipt.contentHash });

  beforeAll(async () => {
    const receipts = receiptFixture.receipts.map((r: { raw: string; receiptId: string }) => ({ receiptId: r.receiptId, ...decodeReceiptRecord(Buffer.from(r.raw, "hex")) }));
    const batch = censusBatch({ genesis, finalizedHeight: 2416892, receipts });
    const anchorIds = [batch.anchorId.slice(2), h(0), h(255)].sort();
    const commitment = toHex(batchSetCommitment({ materiosGenesis: genesis, anchorIds }));
    const secret = new Uint8Array(32).fill(19);
    key = toHex(authorKey(secret));
    const { tx } = unprovenRegistryCall({ address: fixture.registry.address, state: registryInitialState(), call: { circuit: "anchor", args: [Buffer.from(commitment, "hex"), 3n] }, witnesses: { authorSecret: secret } });
    const bytes = await finalBytes(tx);
    const txHash = L.Transaction.deserialize("signature", "proof", "binding", bytes).transactionHash();
    chain = anchorChain({ place: [[2023, "anchor", toHex(bytes), txHash]] });
    const indexed = chain.indexed.get(txHash)!;
    const member = batch.receipts[0]!;
    bundle = {
      format: "orynq-midnight-batch-proof/v1", network: "mainnet", materiosGenesis: genesis,
      receipt: { receiptId: member.receiptId, contentHash: member.contentHash, baseRootSha256: member.baseRootSha256, storageLocatorHash: member.storageLocatorHash, certFormat: member.certFormat.format, certChainId: member.certFormat.chainId },
      batch: { index: 0, count: batch.receipts.length, path: merklePath(batch.leafHashes, 0).map((s) => s.slice(2)), rootHash: batch.rootHash.slice(2), manifest: batch.manifest },
      set: { commitment, anchorIds },
      midnight: { registry: fixture.registry.address, txHash, blockHeight: indexed.block.height, blockHash: indexed.block.hash },
    };
  });

  it("recomputes every link and checks the batch author, registry, inclusion and GRANDPA finality", async () => {
    const result = await verifyBatchProof(request(), options());
    expect(result.status).toBe("valid");
    expect(result.anchor).toMatchObject({ status: "valid", assurance: "consensus-verified", anchor: { kind: 3, author: key } });
    expect(result.anchorId).toBeDefined();
    const set = await verifyBatchSet({ network: "mainnet", materiosGenesis: genesis, ...bundle.set, midnight: bundle.midnight }, options());
    expect(set).toMatchObject({ status: "valid", facts: { authorKey: key, blockHeight: 2023, blockHash: bundle.midnight.blockHash, knownAuthorsSerial: 1 } });
    expect(set.facts?.checkpointId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reuses a verified set while rechecking current authors and trust policy", async () => {
    const cache = new BatchSetCache(2);
    const opts = { ...options(), setCache: cache };
    const calls = vi.spyOn(chain.source.node, "call");
    try {
      const first = await verifyBatchProof(request(), opts);
      expect(first.status).toBe("valid");
      const count = calls.mock.calls.length;
      expect(count).toBeGreaterThan(0);
      if (first.anchor) first.anchor.status = "invalid";
      const second = await verifyBatchProof(request(), opts);
      expect(second.status).toBe("valid");
      expect(second.anchor?.status).toBe("valid");
      expect(calls.mock.calls.length).toBe(count);
      const revoked = { ...opts, knownAuthors: chain.authors([{ key, role: "batch", validTo: 2022 }]) };
      expect((await verifyBatchProof(request(), revoked)).status).toBe("author-revoked");
      expect(calls.mock.calls.length).toBe(count);
      expect((await verifyBatchProof(request(), { ...opts, finality: "skip" })).status).toBe("unverified-finality");
      expect(calls.mock.calls.length).toBeGreaterThan(count);
    } finally { calls.mockRestore(); }
  });

  it("invalidates cached success when the same source changes network or execution policy", async () => {
    const cache = new BatchSetCache();
    const opts = { ...options(), setCache: cache };
    expect((await verifyBatchProof(request(), opts)).status).toBe("valid");
    chain.source.network = "preprod";
    try { expect((await verifyBatchProof(request(), opts)).status).toBe("invalid"); }
    finally { delete chain.source.network; }
    chain.source.verifyExecution = async () => { throw new Error("New source execution policy cannot authenticate this anchor"); };
    try { expect((await verifyBatchProof(request(), opts)).status).not.toBe("valid"); }
    finally { delete chain.source.verifyExecution; }
  });

  it("does not alias invalid numeric finality budgets to the default cache policy", async () => {
    const setCache = new BatchSetCache();
    const opts = { ...options(), setCache };
    expect((await verifyBatchProof(request(), opts)).status).toBe("valid");
    for (const maxSetChanges of [NaN, Infinity, -1, 1.5]) {
      expect((await verifyBatchProof(request(), { ...opts, maxSetChanges })).status).toBe("invalid");
    }
  });

  it("bounds verified-set cache capacity", () => {
    for (const capacity of [0, -1, 1.5, 4097]) expect(() => new BatchSetCache(capacity)).toThrow();
  });

  it("does not allow a relay, unknown author or expected-author pin to bypass the batch role", async () => {
    for (const authors of [chain.authors([{ key }]), chain.authors([])]) {
      const result = await verifyMidnightAnchor({ network: "mainnet", txHash: bundle.midnight.txHash, expect: { kind: 3, commitment: bundle.set.commitment }, expectedAuthor: key }, { ...options(), knownAuthors: authors });
      expect(result.status).toBe("unauthenticated");
      expect((await verifyBatchProof(request(), { ...options(), knownAuthors: authors })).status).toBe("unauthenticated");
    }
    const retired = chain.authors([{ key, role: "batch", validTo: 2022 }]);
    expect((await verifyBatchProof(request(), { ...options(), knownAuthors: retired })).status).toBe("author-revoked");
  });

  it.each([
    ["content", (p: any) => { p.receipt.contentHash = h(4); }],
    ["genesis", (p: any) => { p.materiosGenesis = h(4); }],
    ["network", (p: any) => { p.network = "preprod"; }],
    ["certificate domain", (p: any) => { p.receipt.certFormat = "dcbor-v1"; p.receipt.certChainId = h(4); }],
    ["receipt identifier", (p: any) => { p.receipt.receiptId = h(4); }],
    ["locator", (p: any) => { p.receipt.storageLocatorHash = h(4); }],
    ["path", (p: any) => { p.batch.path[0] = h(4); }],
    ["index", (p: any) => { p.batch.index = 1; }],
    ["count", (p: any) => { p.batch.count = 0; }],
    ["oversized count", (p: any) => { p.batch.count = 4097; }],
    ["manifest root", (p: any) => { p.batch.manifest.root = h(4); }],
    ["manifest network", (p: any) => { p.batch.manifest.cardano_network_id = "mainnet"; }],
    ["manifest height range", (p: any) => { p.batch.manifest.to_block++; }],
    ["manifest count", (p: any) => { p.batch.manifest.count++; }],
    ["missing membership", (p: any) => { p.set.anchorIds = [h(4)]; }],
    ["commitment", (p: any) => { p.set.commitment = h(4); }],
    ["registry", (p: any) => { p.midnight.registry = h(4); }],
    ["unknown field", (p: any) => { p.receipt.extra = true; }],
    ["fractional height", (p: any) => { p.batch.manifest.to_block = p.batch.manifest.from_block = 1.5; }],
  ])("refuses a changed %s", async (_, mutate) => {
    const proof = structuredClone(bundle); mutate(proof);
    expect((await verifyBatchProof(request(proof), options())).status).not.toBe("valid");
  });

  it("rejects every noncanonical member permutation and missing/extra proof sibling", async () => {
    for (const ids of [[...bundle.set.anchorIds].reverse(), [bundle.set.anchorIds[1], bundle.set.anchorIds[0], bundle.set.anchorIds[2]]]) {
      const proof = structuredClone(bundle); proof.set.anchorIds = ids;
      expect((await verifyBatchProof(request(proof), options())).status).toBe("invalid");
    }
    for (const path of [[], [...bundle.batch.path, h(4)]]) {
      const proof = structuredClone(bundle); proof.batch.path = path;
      expect((await verifyBatchProof(request(proof), options())).status).toBe("invalid");
    }
  });

  it("does not turn a wrong block hint or skipped finality into success", async () => {
    const proof = structuredClone(bundle); proof.midnight.blockHash = h(4);
    expect((await verifyBatchProof(request(proof), options())).status).toBe("conflict");
    expect((await verifyBatchProof(request(), { ...options(), finality: "skip" })).status).toBe("unverified-finality");
  });
});

it("rejects oversized batch sets before iterating untrusted members", () => {
  const ids = new Proxy(Array(1025).fill(h(1)), { get(target, key) { if (key === Symbol.iterator) throw new Error("Oversized input was iterated"); return Reflect.get(target, key); } });
  expect(() => batchSetCommitment({ materiosGenesis: genesis, anchorIds: ids })).toThrow(/1\.\.1024/);
});
