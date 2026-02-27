/**
 * Merkle tree utilities.
 *
 * Ported from Python cert-daemon/scripts/verify.py to ensure hash
 * compatibility between the SDK and the daemon/verifier.
 *
 * CRITICAL: The tree construction must match the daemon exactly:
 *   - Empty list  -> 32 zero bytes (0x00...00)
 *   - Single leaf -> returned as-is (no additional hashing)
 *   - Odd layer   -> duplicate last element before pairing
 *   - Pairs concatenated as raw bytes, then SHA-256
 */

import { createHash } from "crypto";
import { stripPrefix, ensureHex } from "./hex.js";
import type { MerkleProof, MerkleProofSibling } from "./types.js";

/**
 * Compute SHA-256 of raw bytes.
 */
function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

/**
 * Convert a hex string (with or without 0x prefix) to a Buffer.
 */
function hexToBuffer(hex: string): Buffer {
  return Buffer.from(stripPrefix(hex), "hex");
}

/**
 * Compute the Merkle root from an array of leaf hashes (hex strings).
 *
 * Matches the Python implementation in cert-daemon/scripts/verify.py exactly:
 *   - Empty list  -> zero hash (32 zero bytes)
 *   - Single leaf -> that leaf (no extra hashing)
 *   - Multi-leaf  -> binary tree; odd layer duplicates last element
 *   - Pairs concatenated as bytes then SHA-256'd
 */
export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) {
    return ensureHex("0".repeat(64));
  }
  if (leaves.length === 1) {
    return ensureHex(stripPrefix(leaves[0]!));
  }

  let layer: Buffer[] = leaves.map(hexToBuffer);

  while (layer.length > 1) {
    // CRITICAL: Python does layer.append(layer[-1]) for odd count
    if (layer.length % 2 !== 0) {
      layer.push(layer[layer.length - 1]!);
    }
    const nextLayer: Buffer[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const combined = Buffer.concat([layer[i]!, layer[i + 1]!]);
      nextLayer.push(sha256(combined));
    }
    layer = nextLayer;
  }

  return ensureHex(layer[0]!.toString("hex"));
}

/**
 * Generate a Merkle inclusion proof for the leaf at `targetIndex`.
 *
 * Returns an object with an array of siblings. Each sibling records:
 *   - `hash`:     hex string of the sibling node
 *   - `position`: "L" if the sibling is on the left, "R" if on the right
 *
 * Walking the proof: at each level, if position is "L" the sibling goes
 * first (left), otherwise the current hash goes first (left).
 */
export function merkleInclusionProof(
  leaves: string[],
  targetIndex: number,
): MerkleProof {
  if (leaves.length <= 1) {
    return { siblings: [] };
  }

  const siblings: MerkleProofSibling[] = [];
  let layer: Buffer[] = leaves.map(hexToBuffer);
  let idx = targetIndex;

  while (layer.length > 1) {
    if (layer.length % 2 !== 0) {
      layer.push(layer[layer.length - 1]!);
    }

    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    const position: "L" | "R" = idx % 2 === 0 ? "R" : "L";
    siblings.push({
      hash: ensureHex(layer[siblingIdx]!.toString("hex")),
      position,
    });

    // Build next layer
    const nextLayer: Buffer[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const combined = Buffer.concat([layer[i]!, layer[i + 1]!]);
      nextLayer.push(sha256(combined));
    }
    layer = nextLayer;
    idx = Math.floor(idx / 2);
  }

  return { siblings };
}

/**
 * Verify a Merkle inclusion proof.
 *
 * Walks up the tree from `leaf` using the sibling list and compares the
 * final computed hash against the expected `root`.
 */
export function verifyMerkleProof(
  leaf: string,
  proof: MerkleProof,
  root: string,
): boolean {
  let current = hexToBuffer(leaf);

  for (const sibling of proof.siblings) {
    const sibBuf = hexToBuffer(sibling.hash);
    const combined =
      sibling.position === "L"
        ? Buffer.concat([sibBuf, current])
        : Buffer.concat([current, sibBuf]);
    current = sha256(combined);
  }

  return current.toString("hex") === stripPrefix(root);
}
