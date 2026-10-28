/**
 * Hashing utilities for flight recorder.
 * Provides consistent SHA-256 hashing with domain separation.
 */

import { webcrypto } from "node:crypto";

const crypto = webcrypto as unknown as Crypto;

/**
 * Hash domain prefixes for different data types.
 */
export const HASH_DOMAINS = {
  event: "poi-flight:event:v2|",
  chunk: "poi-flight:chunk:v2|",
  manifest: "poi-flight:manifest:v2|",
  roll: "poi-flight:roll:v2|",
  merkleLeaf: "poi-flight:leaf:v2|",
  merkleNode: "poi-flight:node:v2|",
  encryptedChunk: "poi-flight:encrypted:v2|",
} as const;

export type HashDomain = keyof typeof HASH_DOMAINS;

/**
 * Compute SHA-256 hash of data with domain separation.
 */
export async function sha256(data: Uint8Array, domain?: HashDomain): Promise<string> {
  let input = data;

  if (domain) {
    const prefix = new TextEncoder().encode(HASH_DOMAINS[domain]);
    const combined = new Uint8Array(prefix.length + data.length);
    combined.set(prefix, 0);
    combined.set(data, prefix.length);
    input = combined;
  }

  const hashBuffer = await crypto.subtle.digest("SHA-256", input as unknown as ArrayBuffer);
  return bufferToHex(new Uint8Array(hashBuffer));
}

/**
 * Compute SHA-256 hash of a string.
 */
export async function sha256String(str: string, domain?: HashDomain): Promise<string> {
  const data = new TextEncoder().encode(str);
  return sha256(data, domain);
}

/**
 * Compute SHA-256 hash of JSON-serializable data.
 */
export async function sha256Json(obj: unknown, domain?: HashDomain): Promise<string> {
  const json = JSON.stringify(obj, null, 0);
  return sha256String(json, domain);
}

/**
 * Compute rolling hash by combining previous hash with new data.
 */
export async function rollingHash(prevHash: string, newData: Uint8Array): Promise<string> {
  const prevBytes = hexToBuffer(prevHash);
  const combined = new Uint8Array(prevBytes.length + newData.length);
  combined.set(prevBytes, 0);
  combined.set(newData, prevBytes.length);
  return sha256(combined, "roll");
}

/**
 * Compute Merkle tree leaf hash.
 */
export async function merkleLeaf(data: Uint8Array): Promise<string> {
  return sha256(data, "merkleLeaf");
}

/**
 * Compute Merkle tree internal node hash.
 */
export async function merkleNode(left: string, right: string): Promise<string> {
  const leftBytes = hexToBuffer(left);
  const rightBytes = hexToBuffer(right);
  const combined = new Uint8Array(leftBytes.length + rightBytes.length);
  combined.set(leftBytes, 0);
  combined.set(rightBytes, leftBytes.length);
  return sha256(combined, "merkleNode");
}

/**
 * Build a Merkle tree from leaf hashes and return the root.
 */
export async function buildMerkleRoot(leafHashes: string[]): Promise<string> {
  if (leafHashes.length === 0) {
    // Empty tree - hash of empty string
    return sha256(new Uint8Array(0), "merkleNode");
  }

  if (leafHashes.length === 1) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return leafHashes[0]!;
  }

  // Build tree level by level
  let currentLevel = leafHashes;

  while (currentLevel.length > 1) {
    const nextLevel: string[] = [];

    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = currentLevel[i + 1];
      if (left !== undefined && right !== undefined) {
        // Pair exists
        const nodeHash = await merkleNode(left, right);
        nextLevel.push(nodeHash);
      } else if (left !== undefined) {
        // Odd element - promote to next level
        nextLevel.push(left);
      }
    }

    currentLevel = nextLevel;
  }

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return currentLevel[0]!;
}

/**
 * Generate a Merkle proof for a leaf at the given index.
 */
export interface MerkleProof {
  leafIndex: number;
  leafHash: string;
  siblings: Array<{ hash: string; position: "left" | "right" }>;
  root: string;
}

export async function generateMerkleProof(
  leafHashes: string[],
  leafIndex: number
): Promise<MerkleProof> {
  if (leafIndex < 0 || leafIndex >= leafHashes.length) {
    throw new Error(`Invalid leaf index: ${leafIndex}`);
  }

  const siblings: Array<{ hash: string; position: "left" | "right" }> = [];
  let currentLevel = leafHashes;
  let currentIndex = leafIndex;

  while (currentLevel.length > 1) {
    const isLeft = currentIndex % 2 === 0;
    const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;

    const siblingHash = currentLevel[siblingIndex];
    if (siblingIndex < currentLevel.length && siblingHash !== undefined) {
      siblings.push({
        hash: siblingHash,
        position: isLeft ? "right" : "left",
      });
    }

    // Build next level
    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = currentLevel[i + 1];
      if (left !== undefined && right !== undefined) {
        const nodeHash = await merkleNode(left, right);
        nextLevel.push(nodeHash);
      } else if (left !== undefined) {
        nextLevel.push(left);
      }
    }

    currentLevel = nextLevel;
    currentIndex = Math.floor(currentIndex / 2);
  }

  const leafHash = leafHashes[leafIndex];
  const root = currentLevel[0];
  if (leafHash === undefined || root === undefined) {
    throw new Error("Invalid merkle tree state");
  }

  return {
    leafIndex,
    leafHash,
    siblings,
    root,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isSha256Hex = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

function isProof(value: unknown): value is MerkleProof {
  return (
    isRecord(value) &&
    isSha256Hex(value.leafHash) &&
    isSha256Hex(value.root) &&
    Array.isArray(value.siblings) &&
    value.siblings.every(
      (sibling) => isRecord(sibling) && isSha256Hex(sibling.hash) && (sibling.position === "left" || sibling.position === "right")
    )
  );
}

/**
 * The sibling positions on the path from leaf `index` in a tree of
 * `leafCount` leaves, where the odd last node of a level moves up unpaired.
 */
function pathPositions(index: number, leafCount: number): Array<"left" | "right"> {
  const positions: Array<"left" | "right"> = [];
  for (let width = leafCount; width > 1; width = Math.ceil(width / 2)) {
    if (index % 2 === 1) positions.push("left");
    else if (index + 1 < width) positions.push("right");
    index = Math.floor(index / 2);
  }
  return positions;
}

/**
 * Verify a Merkle proof for a tree of `leafCount` leaves, a count the caller
 * takes from an authenticated source such as the manifest's chunk list. The
 * proof must follow exactly the path `generateMerkleProof` gives its
 * `leafIndex` in such a tree, so neither the root nor an internal node passes
 * as a leaf, except the root of a one-leaf tree, and every hash must be
 * lowercase SHA-256 hex. The caller must still compare `proof.root` with the
 * authenticated root.
 */
export async function verifyMerkleProof(proof: MerkleProof, leafCount: number): Promise<boolean> {
  if (
    !isProof(proof) ||
    !Number.isSafeInteger(leafCount) ||
    !Number.isSafeInteger(proof.leafIndex) ||
    proof.leafIndex < 0 ||
    proof.leafIndex >= leafCount
  ) {
    return false;
  }
  const positions = pathPositions(proof.leafIndex, leafCount);
  if (
    positions.length !== proof.siblings.length ||
    proof.siblings.some((sibling, level) => sibling.position !== positions[level])
  ) {
    return false;
  }

  let currentHash = proof.leafHash;
  for (const sibling of proof.siblings) {
    if (sibling.position === "left") {
      currentHash = await merkleNode(sibling.hash, currentHash);
    } else {
      currentHash = await merkleNode(currentHash, sibling.hash);
    }
  }

  return currentHash === proof.root;
}

// === Utility functions ===

function bufferToHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBuffer(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
