import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  anchorId, censusBatch, certFormatOf, certHash, checkpointLeaf,
  decodeReceiptRecord, encodeCert, memberSnapshot, merklePath, merkleRoot,
  parseMemberSnapshot, rootFromPath, SNAPSHOT_BUDGET, manifestHash,
} from "../checkpoint.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/checkpoint-receipts.json", import.meta.url), "utf8"));
const corpus = JSON.parse(readFileSync(new URL("./fixtures/checkpoint-corpus.json", import.meta.url), "utf8"));
const manifestDel = JSON.parse(readFileSync(new URL("./fixtures/checkpoint-manifest-del.json", import.meta.url), "utf8"));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bare = (value: string) => value.replace(/^0x/, "");
const hex = (byte: number) => byte.toString(16).padStart(2, "0").repeat(32);
const records = fixture.receipts.map((r: Record<string, string>) => ({ receiptId: r.receiptId!, ...decodeReceiptRecord(Buffer.from(r.raw!, "hex")) }));

describe("checkpoint parity with the daemon tree", () => {
  function pythonTree(leaves: string[]): string {
    let layer = leaves.map((leaf) => Buffer.from(leaf, "hex"));
    if (!layer.length) return "00".repeat(32);
    while (layer.length > 1) {
      if (layer.length % 2) layer.push(layer.at(-1)!);
      const next: Buffer[] = [];
      for (let i = 0; i < layer.length; i += 2) next.push(Buffer.from(hash(Buffer.concat([layer[i]!, layer[i + 1]!])), "hex"));
      layer = next;
    }
    return layer[0]!.toString("hex");
  }

  for (const count of [0, 1, 2, 3, 5, 100, 603, 4096]) {
    it(`matches the daemon tree and shape-bound paths for ${count} leaves`, () => {
      const leaves = Array.from({ length: count }, (_, i) => hash(Buffer.from(String(i))));
      const root = merkleRoot(leaves);
      expect(bare(root)).toBe(pythonTree(leaves));
      for (const index of new Set([0, Math.floor(count / 2), count - 1])) {
        if (!count) continue;
        const path = merklePath(leaves, index);
        expect(rootFromPath(leaves[index]!, index, count, path)).toBe(root);
      }
    });
  }

  it("refuses invalid hashes, indices, path lengths and odd-node siblings", () => {
    expect(() => merkleRoot(["gg".repeat(32)])).toThrow(/hash/i);
    expect(() => merklePath([], 0)).toThrow(/index|count/i);
    expect(() => merklePath([hex(1)], -1)).toThrow(/index/i);
    expect(() => rootFromPath(hex(1), 0, 1, [hex(2)])).toThrow(/path/i);
    expect(() => rootFromPath(hex(1), 0, 2, [])).toThrow(/path/i);
    expect(() => rootFromPath(hex(3), 2, 3, [hex(4), hex(5)])).toThrow(/odd|duplicate|sibling/i);
    expect(() => rootFromPath(hex(1), 1.5, 3, [hex(2), hex(3)])).toThrow(/index/i);
  });
});

describe("public receipt and certificate vectors", () => {
  it("classifies 300 public receipts exactly against independent Python encodings", () => {
    expect(corpus.receipts).toHaveLength(300);
    for (const r of corpus.receipts) {
      const record = decodeReceiptRecord(Buffer.from(r.raw, "hex"));
      expect(certFormatOf(record, fixture.genesis, r.receiptId)).toEqual({ format: r.format, chainId: r.chainId });
      expect(bare(checkpointLeaf(fixture.genesis, r.receiptId, record.availabilityCertHash))).toBe(r.leaf);
    }
  });
  for (const r of fixture.receipts) {
    it(`reproduces ${r.format}/${r.chainId ?? "canonical"} bytes, hash and checkpoint leaf`, () => {
      const record = decodeReceiptRecord(Buffer.from(r.raw, "hex"));
      expect(record.createdAtMillis).toBe(BigInt(r.createdAtMillis));
      for (const field of ["contentHash", "baseRootSha256", "storageLocatorHash", "availabilityCertHash"] as const) expect(bare(record[field])).toBe(r[field]);
      const format = { format: r.format, chainId: r.chainId };
      const encoded = encodeCert(format, fixture.genesis, r.receiptId, record);
      expect(Buffer.from(encoded).toString("hex")).toBe(r.certBytes);
      expect(encoded.length).toBe(r.format === "scale-v1" ? 202 : 277);
      expect(bare(certHash(format, fixture.genesis, r.receiptId, record))).toBe(r.availabilityCertHash);
      expect(certFormatOf(record, fixture.genesis, r.receiptId)).toEqual(format);
      expect(bare(checkpointLeaf(fixture.genesis, r.receiptId, record.availabilityCertHash))).toBe(r.leaf);
    });
  }

  it("rejects truncated, trailing and noncanonical Option receipt encodings", () => {
    const raw = Buffer.from(fixture.receipts[0].raw, "hex");
    expect(() => decodeReceiptRecord(raw.subarray(0, -1))).toThrow(/receipt|truncat/i);
    expect(() => decodeReceiptRecord(Buffer.concat([raw, Buffer.from([0])]))).toThrow(/trailing|receipt/i);
    raw[96] = 2;
    expect(() => decodeReceiptRecord(raw)).toThrow(/option/i);
  });

  it("does not accept unknown legacy domains or a forged certificate", () => {
    const r = records[0]!;
    expect(certFormatOf({ ...r, availabilityCertHash: hex(0) }, fixture.genesis, r.receiptId)).toBeNull();
    expect(() => encodeCert({ format: "dcbor-v1", chainId: hex(7) }, fixture.genesis, r.receiptId, r)).toThrow(/chain|genesis/i);
    expect(() => encodeCert({ format: "dcbor-v1", chainId: fixture.legacyGenesis }, hex(7), r.receiptId, r)).toThrow(/chain|genesis/i);
  });
});

describe("deterministic census batches and compact member snapshots", () => {
  it("breaks timestamp ties by byte order independently of the host locale", () => {
    const tied = records.map((r) => ({ ...r, createdAtMillis: 1n }));
    const expected = tied.map((r) => r.receiptId).sort();
    const locale = vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (this: string, other: string) { return this < other ? 1 : this > other ? -1 : 0; });
    try {
      expect(censusBatch({ genesis: fixture.genesis, finalizedHeight: 1, receipts: tied }).receipts.map((r) => r.receiptId)).toEqual(expected);
    } finally {
      locale.mockRestore();
    }
  });

  it("matches Python manifest hashing across counts, heights and insertion orders", () => {
    for (const { manifest, hash } of [...corpus.manifests, manifestDel]) {
      expect(bare(manifestHash(Object.fromEntries(Object.entries(manifest).reverse()) as Parameters<typeof manifestHash>[0]))).toBe(hash);
    }
  });

  it("preserves prefixed live certificate domains in compact snapshots", () => {
    const batch = censusBatch({ genesis: fixture.genesis, finalizedHeight: 1, receipts: records });
    const prefixed = structuredClone(batch);
    for (const member of prefixed.receipts) {
      if (member.certFormat.chainId !== null) member.certFormat.chainId = `0x${member.certFormat.chainId}`;
    }
    expect(parseMemberSnapshot(memberSnapshot(prefixed)).anchorId).toBe(batch.anchorId);
  });

  it("fits 4096 members in the byte budget and preserves every recomputed leaf", () => {
    const receipt = fixture.receipts.find((r: { format: string }) => r.format === "scale-v1");
    const tuples = Array.from({ length: 4096 }, (_, i) => [hash(Buffer.from(String(i))), receipt.contentHash, receipt.baseRootSha256, receipt.storageLocatorHash, 0]);
    const batch = parseMemberSnapshot(JSON.stringify({ genesis: fixture.genesis, finalizedHeight: 4294967295, receipts: tuples }));
    const snapshot = memberSnapshot(batch);
    expect(Buffer.byteLength(snapshot)).toBeLessThan(SNAPSHOT_BUDGET);
    expect(parseMemberSnapshot(snapshot).leafHashes).toEqual(batch.leafHashes);
  });
  it("orders by creation time then receipt id, binds the manifest and round-trips public members", () => {
    const input = [...records].reverse();
    const batch = censusBatch({ genesis: fixture.genesis, finalizedHeight: 2391371, receipts: input });
    expect(batch.receipts.map((r) => r.receiptId)).toEqual([...records].sort((a, b) => a.createdAtMillis < b.createdAtMillis ? -1 : a.createdAtMillis > b.createdAtMillis ? 1 : a.receiptId.localeCompare(b.receiptId)).map((r) => r.receiptId));
    const manifest = batch.manifest;
    const pythonJson = `{"cardano_network_id": "", "count": 3, "from_block": 2391371, "materios_chain_id": "${fixture.genesis}", "root": "${bare(batch.rootHash)}", "to_block": 2391371}`;
    expect(bare(batch.manifestHash)).toBe(hash(Buffer.from(pythonJson)));
    expect(batch.anchorId).toBe(anchorId(batch.rootHash, batch.manifestHash));
    expect(manifest.from_block).toBe(manifest.to_block);
    expect(manifest.root).toBe(bare(batch.rootHash));
    const snapshot = memberSnapshot(batch);
    expect(Buffer.byteLength(snapshot)).toBeLessThan(SNAPSHOT_BUDGET);
    const parsed = parseMemberSnapshot(snapshot);
    expect(parsed.anchorId).toBe(batch.anchorId);
    expect(parsed.rootHash).toBe(batch.rootHash);
    expect(parsed.receipts.map((r) => r.receiptId)).toEqual(batch.receipts.map((r) => r.receiptId));
    expect(input.map((r) => r.receiptId)).toEqual([...records].reverse().map((r) => r.receiptId));
  });

  it("rejects empty, oversized, duplicate and uncertified input before producing a batch", () => {
    const base = { genesis: fixture.genesis, finalizedHeight: 1 };
    expect(() => censusBatch({ ...base, receipts: [] })).toThrow(/count|receipt/i);
    expect(() => censusBatch({ ...base, receipts: Array(4097).fill(records[0]) })).toThrow(/4096|count/i);
    expect(() => censusBatch({ ...base, receipts: [records[0], records[0]] })).toThrow(/duplicate/i);
    expect(() => censusBatch({ ...base, receipts: [{ ...records[0], availabilityCertHash: hex(0) }] })).toThrow(/cert/i);
    expect(() => censusBatch({ ...base, finalizedHeight: -1, receipts: records })).toThrow(/height/i);
  });

  it("refuses malformed, oversized, duplicate or unknown-format member snapshots", () => {
    const snapshot = memberSnapshot(censusBatch({ genesis: fixture.genesis, finalizedHeight: 1, receipts: records }));
    const value = JSON.parse(snapshot);
    expect(() => parseMemberSnapshot(" ".repeat(SNAPSHOT_BUDGET + 1))).toThrow(/budget|size/i);
    expect(() => parseMemberSnapshot(JSON.stringify({ ...value, surprise: true }))).toThrow(/field/i);
    expect(() => parseMemberSnapshot(JSON.stringify({ ...value, receipts: [value.receipts[0], value.receipts[0]] }))).toThrow(/duplicate/i);
    value.receipts[0][4] = 99;
    expect(() => parseMemberSnapshot(JSON.stringify(value))).toThrow(/format/i);
  });
});
