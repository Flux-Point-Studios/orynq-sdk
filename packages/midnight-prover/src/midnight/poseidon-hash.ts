/**
 * @fileoverview Poseidon hash utilities for ZK-friendly Merkle trees.
 *
 * Location: packages/midnight-prover/src/midnight/poseidon-hash.ts
 *
 * Summary:
 * This module provides interfaces and utilities for computing ZK-friendly
 * Merkle roots using the Poseidon hash function. The Poseidon hash is used
 * inside ZK circuits (dual-root approach) where SHA-256 is too expensive.
 *
 * Usage:
 * Consumers must provide a PoseidonHasher implementation (e.g., from circomlibjs):
 * ```typescript
 * import { computeZkRoot, PoseidonHasher } from '@fluxpointstudios/poi-sdk-midnight-prover';
 *
 * const hasher: PoseidonHasher = {
 *   hash: async (inputs) => poseidon(inputs),
 *   getParams: () => ({ field: 'bn128', arity: 2, roundConstants: 'v1' }),
 * };
 *
 * const zkRoot = await computeZkRoot(leafHashes, hasher);
 * ```
 *
 * Related files:
 * - types.ts: PoseidonParams and DualRootInput type definitions
 * - witness-builder.ts: Builds witnesses that may include dual roots
 */

import type { PoseidonParams } from "../types.js";

// =============================================================================
// POSEIDON HASHER INTERFACE
// =============================================================================

/**
 * Interface for Poseidon hash implementation.
 * Consumers provide their own implementation (e.g., circomlibjs).
 *
 * The Poseidon hash is a ZK-friendly hash function designed for efficient
 * computation inside arithmetic circuits. Unlike SHA-256 which operates on
 * bits, Poseidon operates on field elements natively.
 */
export interface PoseidonHasher {
  /**
   * Compute Poseidon hash of field element inputs.
   *
   * @param inputs - Array of field elements (as bigints)
   * @returns Promise resolving to the hash as a bigint field element
   */
  hash(inputs: bigint[]): Promise<bigint>;

  /**
   * Get the Poseidon parameters used by this hasher.
   *
   * @returns The parameter configuration
   */
  getParams(): PoseidonParams;
}

// =============================================================================
// ZK MERKLE ROOT COMPUTATION
// =============================================================================

/**
 * Compute a ZK-friendly Merkle root using Poseidon hash.
 *
 * This builds a binary Merkle tree bottom-up from the provided leaf hashes.
 * If the number of leaves is odd, the last leaf is duplicated to fill the level.
 * An empty leaf set returns a zero hash (64 hex zeros).
 *
 * @param leafHashes - Hex-encoded leaf hashes (SHA-256 hashes converted to field elements)
 * @param hasher - PoseidonHasher implementation
 * @returns Promise resolving to the hex-encoded Poseidon Merkle root
 *
 * @example
 * ```typescript
 * const root = await computeZkRoot(["aabb...", "ccdd..."], hasher);
 * console.log("ZK root:", root); // 64-char hex string
 * ```
 */
export async function computeZkRoot(
  leafHashes: string[],
  hasher: PoseidonHasher
): Promise<string> {
  if (leafHashes.length === 0) {
    return "0".repeat(64);
  }

  // Convert hex strings to bigints
  let currentLevel = leafHashes.map((h) => BigInt("0x" + h));

  // Build Merkle tree bottom-up
  while (currentLevel.length > 1) {
    const nextLevel: bigint[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i]!;
      const right = i + 1 < currentLevel.length ? currentLevel[i + 1]! : left;
      const parent = await hasher.hash([left, right]);
      nextLevel.push(parent);
    }
    currentLevel = nextLevel;
  }

  // Convert back to hex, padded to 64 characters
  return currentLevel[0]!.toString(16).padStart(64, "0");
}

// =============================================================================
// POSEIDON PARAMS HASH
// =============================================================================

/**
 * Compute a deterministic hash commitment for Poseidon parameters.
 *
 * This creates a unique identifier for a specific Poseidon configuration,
 * allowing verifiers to confirm which parameters were used without
 * needing the full parameter set.
 *
 * Note: The current implementation returns a concatenated string representation.
 * A production implementation would use sha256StringHex(canonicalize(params))
 * for a proper cryptographic commitment.
 *
 * @param params - Poseidon hash function parameters
 * @returns Deterministic string representation of the parameters
 */
export function computePoseidonParamsHash(params: PoseidonParams): string {
  // Deterministic representation of the parameters.
  // In production, this would use sha256StringHex(canonicalize(params))
  // for a proper cryptographic commitment.
  const paramsStr = `${params.field}:${params.arity}:${params.roundConstants}`;
  return paramsStr;
}
