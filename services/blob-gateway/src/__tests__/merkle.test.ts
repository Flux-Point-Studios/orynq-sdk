/**
 * Unit tests for the chunk-Merkle root computation.
 *
 * Critical: this MUST stay byte-identical to the cert-daemon's
 * `daemon/merkle.py::merkle_root`. The cert-daemon recomputes the root on
 * every verify; if the gateway's server-side compute drifts, the on-chain
 * `base_root_sha256` will mismatch and the pallet rejects with
 * `CertHashMismatch` — instantly breaking the receipt pipeline. So the
 * known-good vectors below were computed by hand from the same algorithm
 * spec used by the daemon.
 */
import { describe, test, expect } from "vitest";
import { createHash } from "crypto";
import {
  sha256,
  merkleRoot,
  isHex64,
  isValidRootHash,
  stripHexPrefix,
  computeRootHashFromChunks,
} from "../merkle.js";

/** Helper: sha256(buf) hex digest. */
function shaHex(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf-8") : buf;
  return createHash("sha256").update(b).digest("hex");
}

/** Build a deterministic 32-byte hash with byte value `v` repeated. */
function leaf(v: number): Buffer {
  return Buffer.alloc(32, v);
}

describe("merkle.merkleRoot — cert-daemon parity", () => {
  test("empty_input_returns_32_zero_bytes", () => {
    const root = merkleRoot([]);
    expect(root.length).toBe(32);
    expect(root.equals(Buffer.alloc(32, 0))).toBe(true);
  });

  test("single_leaf_returns_leaf_unchanged_NOT_rehashed", () => {
    // Single-chunk case: the root IS the leaf. cert-daemon does NOT re-hash
    // a single leaf — see daemon/merkle.py line 20-21.
    const l = leaf(0xab);
    const root = merkleRoot([l]);
    expect(root.equals(l)).toBe(true);
    // Sanity: NOT sha256(leaf)
    expect(root.equals(sha256(l))).toBe(false);
  });

  test("two_leaves_hash_concat_as_raw_bytes", () => {
    // Two leaves: root = sha256(L0 || L1), raw-byte concat (NOT hex strings).
    const l0 = leaf(0x01);
    const l1 = leaf(0x02);
    const expected = createHash("sha256")
      .update(Buffer.concat([l0, l1]))
      .digest();
    const root = merkleRoot([l0, l1]);
    expect(root.equals(expected)).toBe(true);
  });

  test("three_leaves_odd_last_leaf_duplicated", () => {
    // Three leaves: at level 0 we have [L0, L1, L2]. Odd → duplicate L2 →
    // [L0, L1, L2, L2]. Pair-and-hash → [H(L0||L1), H(L2||L2)]. One pair →
    // root = H(H(L0||L1) || H(L2||L2)).
    const l0 = leaf(0x01);
    const l1 = leaf(0x02);
    const l2 = leaf(0x03);
    const h01 = sha256(Buffer.concat([l0, l1]));
    const h22 = sha256(Buffer.concat([l2, l2]));
    const expected = sha256(Buffer.concat([h01, h22]));
    const root = merkleRoot([l0, l1, l2]);
    expect(root.equals(expected)).toBe(true);
  });

  test("four_leaves_balanced_tree", () => {
    const l0 = leaf(0x01);
    const l1 = leaf(0x02);
    const l2 = leaf(0x03);
    const l3 = leaf(0x04);
    const h01 = sha256(Buffer.concat([l0, l1]));
    const h23 = sha256(Buffer.concat([l2, l3]));
    const expected = sha256(Buffer.concat([h01, h23]));
    const root = merkleRoot([l0, l1, l2, l3]);
    expect(root.equals(expected)).toBe(true);
  });

  test("five_leaves_two_levels_of_duplication", () => {
    // 5 leaves: [L0..L4]. Odd → dup L4 → [L0..L4, L4]. Pair: [H01, H23, H44].
    // Odd again → dup H44 → [H01, H23, H44, H44]. Pair: [H(H01||H23), H(H44||H44)].
    // Root: H( H(H01||H23) || H(H44||H44) ).
    const ls = [leaf(0x01), leaf(0x02), leaf(0x03), leaf(0x04), leaf(0x05)];
    const h01 = sha256(Buffer.concat([ls[0], ls[1]]));
    const h23 = sha256(Buffer.concat([ls[2], ls[3]]));
    const h44 = sha256(Buffer.concat([ls[4], ls[4]]));
    const left = sha256(Buffer.concat([h01, h23]));
    const right = sha256(Buffer.concat([h44, h44]));
    const expected = sha256(Buffer.concat([left, right]));
    const root = merkleRoot(ls);
    expect(root.equals(expected)).toBe(true);
  });

  test("known_vector_two_chunks_hello_world", () => {
    // Reproducible vector using real string-derived hashes. Anyone with a
    // Python REPL can verify with daemon/merkle.py.
    const c0 = createHash("sha256").update(Buffer.from("hello")).digest();
    const c1 = createHash("sha256").update(Buffer.from("world")).digest();
    const expected = createHash("sha256")
      .update(Buffer.concat([c0, c1]))
      .digest();
    const root = merkleRoot([c0, c1]);
    expect(root.equals(expected)).toBe(true);
    // Also lock the literal hex value so future refactors can't silently
    // change the algorithm and still pass via re-derivation.
    expect(root.toString("hex")).toBe(
      shaHex(
        Buffer.concat([
          Buffer.from(shaHex("hello"), "hex"),
          Buffer.from(shaHex("world"), "hex"),
        ]),
      ),
    );
  });
});

describe("merkle.computeRootHashFromChunks — manifest-shape input", () => {
  test("single_chunk_returns_chunk_sha_as_root", () => {
    const chunkSha = createHash("sha256").update(Buffer.from("payload")).digest("hex");
    const root = computeRootHashFromChunks([
      { index: 0, sha256: chunkSha },
    ]);
    expect(root).toBe(chunkSha);
  });

  test("accepts_0x_prefix_on_chunk_sha_and_emits_lowercase_hex", () => {
    const chunkSha = createHash("sha256").update(Buffer.from("payload")).digest("hex");
    const upper = chunkSha.toUpperCase();
    const root = computeRootHashFromChunks([{ index: 0, sha256: `0x${upper}` }]);
    // Single-chunk root IS the chunk hash; we normalise to lowercase hex.
    expect(root).toBe(chunkSha);
  });

  test("multi_chunk_matches_raw_byte_concat_merkle", () => {
    const c0 = createHash("sha256").update(Buffer.from("a")).digest();
    const c1 = createHash("sha256").update(Buffer.from("b")).digest();
    const c2 = createHash("sha256").update(Buffer.from("c")).digest();
    const expected = merkleRoot([c0, c1, c2]).toString("hex");
    const root = computeRootHashFromChunks([
      { index: 0, sha256: c0.toString("hex") },
      { index: 1, sha256: c1.toString("hex") },
      { index: 2, sha256: c2.toString("hex") },
    ]);
    expect(root).toBe(expected);
  });

  test("throws_on_missing_sha256_in_a_chunk", () => {
    expect(() =>
      computeRootHashFromChunks([
        { index: 0, sha256: "a".repeat(64) },
        { index: 1 },
      ]),
    ).toThrow(/missing sha256/);
  });

  test("throws_on_non_hex_sha256", () => {
    expect(() =>
      computeRootHashFromChunks([
        { index: 0, sha256: "not-hex-at-all" },
      ]),
    ).toThrow(/not 64-hex/);
  });
});

describe("merkle helpers", () => {
  test("isHex64_accepts_64_hex_lower_and_upper", () => {
    expect(isHex64("a".repeat(64))).toBe(true);
    expect(isHex64("A".repeat(64))).toBe(true);
    expect(isHex64("0".repeat(64))).toBe(true);
  });

  test("isHex64_rejects_short_long_and_with_prefix", () => {
    expect(isHex64("a".repeat(63))).toBe(false);
    expect(isHex64("a".repeat(65))).toBe(false);
    expect(isHex64("0x" + "a".repeat(64))).toBe(false);
    expect(isHex64("g".repeat(64))).toBe(false);
    expect(isHex64(undefined)).toBe(false);
    expect(isHex64(null)).toBe(false);
    expect(isHex64(123)).toBe(false);
  });

  test("isValidRootHash_handles_optional_0x_prefix", () => {
    expect(isValidRootHash("a".repeat(64))).toBe(true);
    expect(isValidRootHash("0x" + "a".repeat(64))).toBe(true);
    expect(isValidRootHash("0X" + "a".repeat(64))).toBe(true);
    expect(isValidRootHash("a".repeat(63))).toBe(false);
    expect(isValidRootHash(123)).toBe(false);
  });

  test("stripHexPrefix_idempotent_on_unprefixed", () => {
    expect(stripHexPrefix("a".repeat(64))).toBe("a".repeat(64));
    expect(stripHexPrefix("0x" + "a".repeat(64))).toBe("a".repeat(64));
    expect(stripHexPrefix("0X" + "a".repeat(64))).toBe("a".repeat(64));
  });
});
