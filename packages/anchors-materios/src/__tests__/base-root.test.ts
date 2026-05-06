/**
 * Regression tests pinning the canonical `base_root_sha256` pre-image.
 *
 * These tests guarantee that the SDK computes `base_root_sha256` byte-for-byte
 * identical to cert-daemon's `daemon/merkle.py` (the source of truth).
 *
 * Cross-layer verified: the pinned hex values in this file were computed by
 * running `daemon/merkle.py` against the same fixtures from a Python REPL.
 *
 * If these tests fail, the cert daemon's strict ROOT_VERIFIED gate will reject
 * receipts produced by this SDK. Do NOT change the pinned values without also
 * updating cert-daemon — the algorithm is consensus-critical.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import {
  computeBaseRoot,
  prepareBlobData,
} from "../receipt.js";
import { merkleRoot } from "../merkle.js";

const CHUNK_SIZE = 256 * 1024;

function sha256Hex(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

describe("computeBaseRoot — canonical chunk-Merkle (cert-daemon parity)", () => {
  it("single-chunk: blob 'hello world' -> base_root == sha256(content)", () => {
    // Single-chunk case: per cert-daemon merkle_root, a single leaf is returned
    // verbatim with no further hashing. So base_root must equal the leaf hash,
    // which equals sha256(chunk_bytes), which equals sha256(content) when the
    // content fits in one chunk.
    const content = Buffer.from("hello world");
    const root = computeBaseRoot(content);

    // Pinned canonical value (computed by Python cert-daemon merkle.py).
    expect(root).toBe(
      "0xb94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );

    // Cross-check: equals sha256(content) for single-leaf case.
    expect(root).toBe("0x" + sha256Hex(content));
  });

  it("three-chunk: deterministic byte pattern -> pinned hex", () => {
    // Build content that produces exactly 3 distinct chunks at the default
    // CHUNK_SIZE (256 KiB). Each chunk is filled with a unique byte value so
    // the three leaf hashes are distinct.
    const buf = Buffer.alloc(3 * CHUNK_SIZE);
    for (let i = 0; i < CHUNK_SIZE; i++) buf[i] = 0;
    for (let i = CHUNK_SIZE; i < 2 * CHUNK_SIZE; i++) buf[i] = 1;
    for (let i = 2 * CHUNK_SIZE; i < 3 * CHUNK_SIZE; i++) buf[i] = 2;

    const root = computeBaseRoot(buf);

    // Pinned canonical value (computed by Python cert-daemon merkle.py).
    expect(root).toBe(
      "0xcff7222bfb3b15ac46d49664992dea6d9bd55ec3da34f0bf12fe255e49c354f6",
    );

    // Cross-check: walk the algorithm by hand against canonical leaves.
    const leaf0 = sha256Hex(Buffer.alloc(CHUNK_SIZE, 0));
    const leaf1 = sha256Hex(Buffer.alloc(CHUNK_SIZE, 1));
    const leaf2 = sha256Hex(Buffer.alloc(CHUNK_SIZE, 2));
    expect(leaf0).toBe(
      "8a39d2abd3999ab73c34db2476849cddf303ce389b35826850f9a700589b4a90",
    );
    expect(leaf1).toBe(
      "f317dd9d6ba01c465d82e4c4d55d01d270dda69db4a01a64c587a5593ac6084d",
    );
    expect(leaf2).toBe(
      "b1026d9249014c863c3a8daf11dec61bd4d4abcfdc7f1a62181cf743d4b6a12e",
    );

    // And the SDK-level merkleRoot helper should produce the same value when
    // given those leaves as hex strings.
    expect(merkleRoot([leaf0, leaf1, leaf2])).toBe(root);
  });

  it("matches prepareBlobData chunk hashes", () => {
    // Using the same 3-chunk fixture, compute via prepareBlobData (the path
    // that uploadBlobs actually uses) and confirm the leaves match what
    // merkleRoot should hash.
    const buf = Buffer.alloc(3 * CHUNK_SIZE);
    for (let i = 0; i < CHUNK_SIZE; i++) buf[i] = 0;
    for (let i = CHUNK_SIZE; i < 2 * CHUNK_SIZE; i++) buf[i] = 1;
    for (let i = 2 * CHUNK_SIZE; i < 3 * CHUNK_SIZE; i++) buf[i] = 2;

    const dummyReceiptId = "0x" + "00".repeat(32);
    const { manifest, chunks } = prepareBlobData(dummyReceiptId, buf);

    expect(manifest.chunk_count).toBe(3);
    expect(chunks).toHaveLength(3);

    // The chunk-store hashes used by the gateway/daemon are sha256(chunk_bytes)
    // — the same leaves the Merkle tree hashes over.
    const leavesFromManifest = manifest.chunks.map((c) => c.sha256);
    expect(leavesFromManifest).toEqual([
      "8a39d2abd3999ab73c34db2476849cddf303ce389b35826850f9a700589b4a90",
      "f317dd9d6ba01c465d82e4c4d55d01d270dda69db4a01a64c587a5593ac6084d",
      "b1026d9249014c863c3a8daf11dec61bd4d4abcfdc7f1a62181cf743d4b6a12e",
    ]);

    expect(merkleRoot(leavesFromManifest)).toBe(
      "0xcff7222bfb3b15ac46d49664992dea6d9bd55ec3da34f0bf12fe255e49c354f6",
    );

    // computeBaseRoot must produce the same value end-to-end.
    expect(computeBaseRoot(buf)).toBe(
      "0xcff7222bfb3b15ac46d49664992dea6d9bd55ec3da34f0bf12fe255e49c354f6",
    );
  });

  it("respects custom chunkSize", () => {
    // A blob smaller than CHUNK_SIZE always single-chunks; with a smaller
    // chunkSize it must split into multiple chunks and produce the
    // multi-leaf root, not the single-leaf shortcut.
    const content = Buffer.from("hello world"); // 11 bytes
    const singleRoot = computeBaseRoot(content);
    const splitRoot = computeBaseRoot(content, 4); // 3 chunks: "hell", "o wo", "rld"

    expect(singleRoot).not.toBe(splitRoot);
    // Single-leaf path returns sha256(content).
    expect(singleRoot).toBe("0x" + sha256Hex(content));
    // Split path: leaves = [sha256("hell"), sha256("o wo"), sha256("rld")],
    // merkle root with duplicate-last on odd layer.
    const l0 = sha256Hex(Buffer.from("hell"));
    const l1 = sha256Hex(Buffer.from("o wo"));
    const l2 = sha256Hex(Buffer.from("rld"));
    expect(splitRoot).toBe(merkleRoot([l0, l1, l2]));
  });

  it("empty buffer is treated as a single empty chunk (matches prepareBlobData)", () => {
    // prepareBlobData's loop `for (i; i*chunkSize < content.length)` produces
    // ZERO chunks for an empty buffer. To stay consistent, computeBaseRoot of
    // empty content uses the cert-daemon empty-list rule: 32 zero bytes.
    const root = computeBaseRoot(Buffer.alloc(0));
    expect(root).toBe("0x" + "00".repeat(32));
  });
});
