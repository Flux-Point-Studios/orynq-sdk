/**
 * @fileoverview Merkle tree implementation for span-level selective disclosure.
 *
 * Location: packages/process-trace/src/merkle.ts
 *
 * This module implements a span-level Merkle tree that enables selective disclosure
 * of trace spans. Verifiers can prove inclusion of specific spans without revealing
 * the entire trace, supporting privacy-preserving audit and compliance workflows.
 *
 * Domain Separation Rules:
 * - spanHash = H("poi-trace:span:v1|" + canon(spanHeader) + "|" + eventHash1 + "|" + eventHash2 + ...)
 * - merkleLeaf = H("poi-trace:leaf:v1|" + spanHash)
 * - merkleNode = H("poi-trace:node:v1|" + left + "|" + right)
 *
 * Used by:
 * - TraceBuilder: builds Merkle tree when finalizing traces
 * - Verification: verifies span inclusion proofs
 * - Selective disclosure: generates proofs for specific spans
 */

import {
  sha256StringHex,
  canonicalize,
} from "@fluxpointstudios/poi-sdk-core/utils";

import type {
  TraceMerkleTree,
  MerkleProof,
  TraceSpan,
  TraceEvent,
} from "./types.js";
import { HASH_DOMAIN_PREFIXES } from "./types.js";

// =============================================================================
// SPAN HASH COMPUTATION
// =============================================================================

/**
 * Compute the hash for a span including its event hashes.
 *
 * The span hash is computed as:
 * H("poi-trace:span:v1|" + canon(spanHeaderWithoutHash) + "|" + eventHash1 + "|" + eventHash2 + ...)
 *
 * The span header includes all fields except the `hash` field itself.
 * Event hashes are concatenated in sequence order, joined by "|".
 *
 * @param span - The span to compute hash for
 * @param eventHashes - Array of event hashes in sequence order
 * @returns Promise resolving to the span hash as a hex string
 *
 * @example
 * const spanHash = await computeSpanHash(span, ["abc123...", "def456..."]);
 */
export async function computeSpanHash(
  span: TraceSpan,
  eventHashes: string[]
): Promise<string> {
  // Extract span header (all fields except hash)
  const spanHeader: Omit<TraceSpan, "hash"> = {
    id: span.id,
    spanSeq: span.spanSeq,
    name: span.name,
    status: span.status,
    visibility: span.visibility,
    startedAt: span.startedAt,
    eventIds: span.eventIds,
    childSpanIds: span.childSpanIds,
  };

  // Include optional fields only if they exist
  if (span.parentSpanId !== undefined) {
    (spanHeader as Record<string, unknown>).parentSpanId = span.parentSpanId;
  }
  if (span.endedAt !== undefined) {
    (spanHeader as Record<string, unknown>).endedAt = span.endedAt;
  }
  if (span.durationMs !== undefined) {
    (spanHeader as Record<string, unknown>).durationMs = span.durationMs;
  }
  if (span.metadata !== undefined) {
    (spanHeader as Record<string, unknown>).metadata = span.metadata;
  }

  // Canonicalize the span header
  const canonicalHeader = canonicalize(spanHeader, { removeNulls: true });

  // Build the hash input: prefix + canon(header) + "|" + eventHashes joined by "|"
  let hashInput = HASH_DOMAIN_PREFIXES.span + canonicalHeader;

  // Append event hashes if any exist
  if (eventHashes.length > 0) {
    hashInput += "|" + eventHashes.join("|");
  }

  return sha256StringHex(hashInput);
}

// =============================================================================
// MERKLE TREE BUILDING
// =============================================================================

/**
 * Build a Merkle tree from spans.
 *
 * Leaves are computed as H("poi-trace:leaf:v1|" + spanHash) in spanSeq order.
 * Internal nodes are computed as H("poi-trace:node:v1|" + left + "|" + right).
 *
 * ODD-LEAF RULE: If there is an odd number of nodes at any level, the last
 * hash is duplicated to create a balanced tree.
 *
 * @param spans - Array of spans (will be sorted by spanSeq)
 * @param events - Array of all events (used to get hashes for spans)
 * @returns Promise resolving to the complete Merkle tree
 *
 * @example
 * const tree = await buildSpanMerkleTree(spans, events);
 * console.log(tree.rootHash); // Merkle root for disclosure commitment
 */
export async function buildSpanMerkleTree(
  spans: TraceSpan[],
  events: TraceEvent[]
): Promise<TraceMerkleTree> {
  // Handle empty spans case
  if (spans.length === 0) {
    return {
      rootHash: "",
      leafCount: 0,
      depth: 0,
      leafHashes: [],
    };
  }

  // Sort spans by spanSeq for deterministic ordering
  const sortedSpans = [...spans].sort((a, b) => a.spanSeq - b.spanSeq);

  // Create a map of event ID to event for quick lookup
  const eventMap = new Map<string, TraceEvent>();
  for (const event of events) {
    eventMap.set(event.id, event);
  }

  // Compute leaf hashes for each span
  const leafHashes: string[] = [];
  for (const span of sortedSpans) {
    // Get event hashes for this span in seq order
    const spanEvents = span.eventIds
      .map((id) => eventMap.get(id))
      .filter((e): e is TraceEvent => e !== undefined)
      .sort((a, b) => a.seq - b.seq);

    const eventHashes = spanEvents.map((e) => e.hash ?? "");

    // Compute span hash
    const spanHash = await computeSpanHash(span, eventHashes);

    // Compute leaf hash: H("poi-trace:leaf:v1|" + spanHash)
    const leafHash = await sha256StringHex(HASH_DOMAIN_PREFIXES.leaf + spanHash);
    leafHashes.push(leafHash);
  }

  // Build tree bottom-up
  const tree = await buildTreeFromLeaves(leafHashes);

  return {
    rootHash: tree.rootHash,
    leafCount: leafHashes.length,
    depth: tree.depth,
    leafHashes,
  };
}

/**
 * Internal helper to build the Merkle tree from leaf hashes.
 * Returns the root hash and tree depth.
 */
async function buildTreeFromLeaves(
  leafHashes: string[]
): Promise<{ rootHash: string; depth: number }> {
  // Handle single leaf case
  if (leafHashes.length === 1) {
    const rootHash = leafHashes[0];
    if (rootHash === undefined) {
      throw new Error("Unexpected empty leaf hash array");
    }
    return {
      rootHash,
      depth: 0,
    };
  }

  let currentLevel = [...leafHashes];
  let depth = 0;

  // Build tree bottom-up until we reach the root
  while (currentLevel.length > 1) {
    const nextLevel: string[] = [];

    // Process pairs of nodes
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      if (left === undefined) {
        throw new Error("Unexpected undefined hash in tree level");
      }
      // If odd number of nodes, duplicate the last one
      const right = i + 1 < currentLevel.length ? (currentLevel[i + 1] ?? left) : left;

      // Compute parent: H("poi-trace:node:v1|" + left + "|" + right)
      const parentHash = await sha256StringHex(
        HASH_DOMAIN_PREFIXES.node + left + "|" + right
      );
      nextLevel.push(parentHash);
    }

    currentLevel = nextLevel;
    depth++;
  }

  const finalRoot = currentLevel[0];
  if (finalRoot === undefined) {
    throw new Error("Unexpected empty tree level");
  }
  return {
    rootHash: finalRoot,
    depth,
  };
}

// =============================================================================
// MERKLE PROOF GENERATION
// =============================================================================

/**
 * Generate a Merkle proof for a specific span by index.
 *
 * The proof contains the sibling hashes along the path from the leaf to the root,
 * with position hints ("left" or "right") indicating which side each sibling is on.
 *
 * @param tree - The complete Merkle tree
 * @param spanIndex - 0-indexed position of the span in the tree
 * @returns MerkleProof for the specified span
 * @throws Error if spanIndex is out of bounds
 *
 * @example
 * const proof = generateMerkleProof(tree, 2);
 * console.log(proof.siblings); // [{hash: "...", position: "right"}, ...]
 */
export function generateMerkleProof(
  tree: TraceMerkleTree,
  spanIndex: number
): MerkleProof {
  // Validate index bounds
  if (spanIndex < 0 || spanIndex >= tree.leafCount) {
    throw new Error(
      `Span index ${spanIndex} is out of bounds (0-${tree.leafCount - 1})`
    );
  }

  // Handle single leaf case - no siblings needed
  if (tree.leafCount === 1) {
    const leafHash = tree.leafHashes[0];
    if (leafHash === undefined) {
      throw new Error("Unexpected empty leaf hash array in tree");
    }
    return {
      leafHash,
      leafIndex: 0,
      siblings: [],
      rootHash: tree.rootHash,
    };
  }

  const siblings: Array<{ hash: string; position: "left" | "right" }> = [];

  // We need to rebuild the tree structure to get sibling hashes
  // Start with leaf level and work up
  let currentLevel = [...tree.leafHashes];
  let currentIndex = spanIndex;

  while (currentLevel.length > 1) {
    // Get sibling index and position
    const isLeftChild = currentIndex % 2 === 0;
    const siblingIndex = isLeftChild ? currentIndex + 1 : currentIndex - 1;

    // Handle odd-leaf case: if no sibling exists, it's a duplicate of current
    let siblingHash: string;
    if (siblingIndex >= currentLevel.length) {
      // This is the duplicate case - sibling is the same as current
      const currentHash = currentLevel[currentIndex];
      if (currentHash === undefined) {
        throw new Error("Unexpected undefined hash at current index");
      }
      siblingHash = currentHash;
    } else {
      const hash = currentLevel[siblingIndex];
      if (hash === undefined) {
        throw new Error("Unexpected undefined hash at sibling index");
      }
      siblingHash = hash;
    }

    // Position is where the sibling sits relative to current node
    siblings.push({
      hash: siblingHash,
      position: isLeftChild ? "right" : "left",
    });

    // Build next level (synchronously since we already have hashes)
    // We need to compute the next level to continue traversal
    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i] ?? "";
      const right = i + 1 < currentLevel.length ? (currentLevel[i + 1] ?? left) : left;
      // We don't actually need to compute the hash here, just track structure
      nextLevel.push(`${left}|${right}`); // Placeholder for structure tracking
    }

    // Move up the tree
    currentLevel = nextLevel;
    currentIndex = Math.floor(currentIndex / 2);
  }

  const leafHash = tree.leafHashes[spanIndex];
  if (leafHash === undefined) {
    throw new Error(`Unexpected undefined leaf hash at index ${spanIndex}`);
  }
  return {
    leafHash,
    leafIndex: spanIndex,
    siblings,
    rootHash: tree.rootHash,
  };
}

// =============================================================================
// MERKLE PROOF VERIFICATION
// =============================================================================

/**
 * Verify a Merkle proof against the expected root.
 *
 * Starting from the leaf hash, the proof is recomputed by combining with
 * sibling hashes according to their positions. The final computed root
 * must match the expected rootHash in the proof.
 *
 * @param proof - The Merkle proof to verify
 * @returns Promise resolving to true if the proof is valid
 *
 * @example
 * const valid = await verifyMerkleProof(proof);
 * if (!valid) {
 *   throw new Error("Merkle proof verification failed");
 * }
 */
export async function verifyMerkleProof(proof: MerkleProof): Promise<boolean> {
  // Start with the leaf hash
  let currentHash = proof.leafHash;

  // Traverse up the tree using the sibling hashes
  for (const sibling of proof.siblings) {
    // Combine hashes based on sibling position
    let left: string;
    let right: string;

    if (sibling.position === "left") {
      // Sibling is on the left, current is on the right
      left = sibling.hash;
      right = currentHash;
    } else {
      // Sibling is on the right, current is on the left
      left = currentHash;
      right = sibling.hash;
    }

    // Compute parent hash: H("poi-trace:node:v1|" + left + "|" + right)
    currentHash = await sha256StringHex(
      HASH_DOMAIN_PREFIXES.node + left + "|" + right
    );
  }

  // Verify computed root matches expected root
  return currentHash === proof.rootHash;
}

/**
 * Verify a span's inclusion using its proof and data.
 *
 * This function recomputes the span hash from the provided span and events,
 * then verifies that the resulting leaf hash matches the proof and that
 * the proof is valid against the expected root.
 *
 * @param proof - The Merkle proof for the span
 * @param span - The span data to verify
 * @param events - The events belonging to this span
 * @returns Promise resolving to true if span is validly included
 *
 * @example
 * const valid = await verifySpanInclusion(proof, span, spanEvents);
 * if (valid) {
 *   console.log("Span is cryptographically included in the trace");
 * }
 */
export async function verifySpanInclusion(
  proof: MerkleProof,
  span: TraceSpan,
  events: TraceEvent[]
): Promise<boolean> {
  // Sort events by seq to get deterministic order
  const sortedEvents = [...events].sort((a, b) => a.seq - b.seq);

  // Get event hashes in seq order
  const eventHashes = sortedEvents.map((e) => e.hash ?? "");

  // Recompute the span hash
  const spanHash = await computeSpanHash(span, eventHashes);

  // Compute the expected leaf hash
  const computedLeafHash = await sha256StringHex(
    HASH_DOMAIN_PREFIXES.leaf + spanHash
  );

  // Verify the leaf hash matches what's in the proof
  if (computedLeafHash !== proof.leafHash) {
    return false;
  }

  // Verify the Merkle proof itself
  return verifyMerkleProof(proof);
}
