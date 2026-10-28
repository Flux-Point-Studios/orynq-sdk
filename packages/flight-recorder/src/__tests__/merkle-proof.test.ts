import { describe, expect, it } from "vitest";
import {
  buildMerkleRoot,
  generateMerkleProof,
  merkleLeaf,
  merkleNode,
  verifyMerkleProof,
  type MerkleProof,
} from "../crypto/hashing.js";

const chunkLeaves = (count: number) =>
  Promise.all(Array.from({ length: count }, (_, i) => merkleLeaf(new TextEncoder().encode(`chunk-${i}`))));

describe("verifyMerkleProof", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 17])("verifies every leaf of a %i-leaf tree against its leaf count", async (count) => {
    const leaves = await chunkLeaves(count);
    const root = await buildMerkleRoot(leaves);
    for (let index = 0; index < count; index++) {
      const proof = await generateMerkleProof(leaves, index);
      expect(proof.root).toBe(root);
      expect(await verifyMerkleProof(proof, count)).toBe(true);
    }
  });

  it("accepts the root as a leaf only in a one-leaf tree", async () => {
    for (const count of [1, 2, 3, 5]) {
      const root = await buildMerkleRoot(await chunkLeaves(count));
      const rootAsLeaf: MerkleProof = { leafIndex: 0, leafHash: root, siblings: [], root };
      expect(await verifyMerkleProof(rootAsLeaf, count)).toBe(count === 1);
    }
  });

  it.each([2, 3, 4, 5, 8, 9])("rejects an internal node of a %i-leaf tree presented as a leaf", async (count) => {
    const leaves = await chunkLeaves(count);
    for (let index = 0; index < count; index++) {
      const honest = await generateMerkleProof(leaves, index);
      const [first, ...rest] = honest.siblings;
      const internal = first!.position === "left"
        ? await merkleNode(first!.hash, honest.leafHash)
        : await merkleNode(honest.leafHash, first!.hash);
      const forged: MerkleProof = { ...honest, leafIndex: Math.floor(index / 2), leafHash: internal, siblings: rest };
      expect(await verifyMerkleProof(forged, count)).toBe(false);
    }
  });

  it("rejects a leaf index the path does not lead to", async () => {
    const leaves = await chunkLeaves(4);
    const proof = await generateMerkleProof(leaves, 1);
    expect(await verifyMerkleProof(proof, 4)).toBe(true);
    for (const leafIndex of [0, 2, 3, 4, -1, 1.5, Number.NaN]) {
      expect(await verifyMerkleProof({ ...proof, leafIndex }, 4)).toBe(false);
    }
  });

  it("requires a whole leaf count that holds the leaf index", async () => {
    const proof = await generateMerkleProof(await chunkLeaves(4), 3);
    for (const leafCount of [undefined, 0, -4, 3, 4.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await verifyMerkleProof(proof, leafCount as number)).toBe(false);
    }
  });

  it("requires lowercase SHA-256 hex for every hash", async () => {
    const proof = await generateMerkleProof(await chunkLeaves(4), 2);
    const variants: MerkleProof[] = [
      { ...proof, leafHash: proof.leafHash.toUpperCase() },
      { ...proof, root: `${proof.root}00` },
      { ...proof, siblings: proof.siblings.map((s, i) => (i === 0 ? { ...s, hash: s.hash.replace(/^../, "zz") } : s)) },
    ];
    for (const variant of variants) expect(await verifyMerkleProof(variant, 4)).toBe(false);
  });

  it.each([null, undefined, 7, {}, { leafIndex: 0, leafHash: "a", root: "a" }, { leafIndex: 0, leafHash: "a", root: "a", siblings: [null] }])(
    "returns false for the malformed proof %j", async (proof) => {
      expect(await verifyMerkleProof(proof as unknown as MerkleProof, 1)).toBe(false);
    },
  );
});
