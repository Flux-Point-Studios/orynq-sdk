import { describe, it, expect } from "vitest";
import { merkleRoot, merkleInclusionProof, verifyMerkleProof } from "../merkle.js";
import { createHash } from "crypto";

function sha256hex(data: string): string {
  return "0x" + createHash("sha256").update(Buffer.from(data, "hex")).digest("hex");
}

/**
 * Pre-compute known leaf hashes: SHA-256 of a single byte [i].
 */
function makeLeaves(count: number): string[] {
  const leaves: string[] = [];
  for (let i = 0; i < count; i++) {
    const hash = createHash("sha256")
      .update(Buffer.from([i]))
      .digest("hex");
    leaves.push("0x" + hash);
  }
  return leaves;
}

describe("merkleRoot", () => {
  it("returns zero hash for empty leaves", () => {
    const root = merkleRoot([]);
    expect(root).toBe("0x" + "0".repeat(64));
  });

  it("returns the leaf itself for single leaf", () => {
    const leaves = makeLeaves(1);
    expect(merkleRoot(leaves)).toBe(leaves[0]);
  });

  it("computes root for 2 leaves", () => {
    const leaves = makeLeaves(2);
    const root = merkleRoot(leaves);
    // Manual: SHA256(leaf0 || leaf1)
    const expected = sha256hex(
      leaves[0]!.slice(2) + leaves[1]!.slice(2),
    );
    expect(root).toBe(expected);
  });

  it("computes root for 3 leaves (odd - duplicates last)", () => {
    const leaves = makeLeaves(3);
    const root = merkleRoot(leaves);
    // Manual: layer1 = [SHA256(L0||L1), SHA256(L2||L2)], root = SHA256(layer1[0]||layer1[1])
    const h01 = sha256hex(leaves[0]!.slice(2) + leaves[1]!.slice(2));
    const h22 = sha256hex(leaves[2]!.slice(2) + leaves[2]!.slice(2));
    const expected = sha256hex(h01.slice(2) + h22.slice(2));
    expect(root).toBe(expected);
  });

  it("computes root for 4 leaves (perfect binary tree)", () => {
    const leaves = makeLeaves(4);
    const root = merkleRoot(leaves);
    // Manual: layer1 = [SHA256(L0||L1), SHA256(L2||L3)], root = SHA256(layer1[0]||layer1[1])
    const h01 = sha256hex(leaves[0]!.slice(2) + leaves[1]!.slice(2));
    const h23 = sha256hex(leaves[2]!.slice(2) + leaves[3]!.slice(2));
    const expected = sha256hex(h01.slice(2) + h23.slice(2));
    expect(root).toBe(expected);
  });

  it("computes root for 5 leaves", () => {
    const leaves = makeLeaves(5);
    const root = merkleRoot(leaves);
    expect(root).toBeDefined();
    expect(root.startsWith("0x")).toBe(true);
    expect(root.length).toBe(66); // 0x + 64 hex chars
  });

  it("computes root for 8 leaves (perfect binary tree)", () => {
    const leaves = makeLeaves(8);
    const root = merkleRoot(leaves);
    expect(root).toBeDefined();
    expect(root.length).toBe(66);
  });

  it("is deterministic", () => {
    const leaves = makeLeaves(5);
    expect(merkleRoot(leaves)).toBe(merkleRoot(leaves));
  });

  it("different leaves produce different roots", () => {
    const a = makeLeaves(3);
    const b = makeLeaves(4);
    expect(merkleRoot(a)).not.toBe(merkleRoot(b));
  });
});

describe("merkleInclusionProof + verifyMerkleProof", () => {
  it("returns empty proof for single leaf", () => {
    const leaves = makeLeaves(1);
    const proof = merkleInclusionProof(leaves, 0);
    expect(proof.siblings).toHaveLength(0);
    const root = merkleRoot(leaves);
    expect(verifyMerkleProof(leaves[0]!, proof, root)).toBe(true);
  });

  // Round-trip test for various leaf counts
  for (const count of [2, 3, 4, 5, 7, 8, 13]) {
    it(`round-trips for ${count} leaves`, () => {
      const leaves = makeLeaves(count);
      const root = merkleRoot(leaves);
      for (let i = 0; i < count; i++) {
        const proof = merkleInclusionProof(leaves, i);
        expect(verifyMerkleProof(leaves[i]!, proof, root)).toBe(true);
      }
    });
  }

  it("rejects wrong leaf", () => {
    const leaves = makeLeaves(4);
    const root = merkleRoot(leaves);
    const proof = merkleInclusionProof(leaves, 0);
    // Use a different leaf
    expect(verifyMerkleProof(leaves[1]!, proof, root)).toBe(false);
  });

  it("rejects wrong root", () => {
    const leaves = makeLeaves(4);
    const proof = merkleInclusionProof(leaves, 0);
    const fakeRoot = "0x" + "ff".repeat(32);
    expect(verifyMerkleProof(leaves[0]!, proof, fakeRoot)).toBe(false);
  });

  it("rejects tampered proof sibling", () => {
    const leaves = makeLeaves(4);
    const root = merkleRoot(leaves);
    const proof = merkleInclusionProof(leaves, 0);
    // Tamper with the first sibling hash
    const tampered = {
      siblings: proof.siblings.map((s, i) =>
        i === 0 ? { ...s, hash: "0x" + "ab".repeat(32) } : s,
      ),
    };
    expect(verifyMerkleProof(leaves[0]!, tampered, root)).toBe(false);
  });

  it("proof for last leaf in odd-count tree works", () => {
    const leaves = makeLeaves(7);
    const root = merkleRoot(leaves);
    // Last leaf (index 6) — in an odd tree, this gets duplicated at layer 0
    const proof = merkleInclusionProof(leaves, 6);
    expect(verifyMerkleProof(leaves[6]!, proof, root)).toBe(true);
  });

  it("proof depth matches expected tree height", () => {
    // 8 leaves = perfect binary tree of height 3
    const leaves = makeLeaves(8);
    const proof = merkleInclusionProof(leaves, 0);
    expect(proof.siblings).toHaveLength(3); // log2(8) = 3

    // 4 leaves = height 2
    const leaves4 = makeLeaves(4);
    const proof4 = merkleInclusionProof(leaves4, 0);
    expect(proof4.siblings).toHaveLength(2); // log2(4) = 2
  });
});
