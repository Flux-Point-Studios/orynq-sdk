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
  bytesToHex,
  normalizeJson,
} from "@fluxpointstudios/orynq-sdk-core/utils";
import { sha256 } from "@noble/hashes/sha256";

import type {
  TraceMerkleTree,
  MerkleProof,
  TraceSpan,
  TraceEvent,
} from "./types.js";
import { HASH_DOMAIN_PREFIXES } from "./types.js";
import { committedEvent, verifyEventHashes } from "./rolling-hash.js";
import { isRecord } from "./guards.js";

// =============================================================================
// SPAN HASH COMPUTATION
// =============================================================================

/** The span header fields {@link computeSpanHash} commits to. */
const SPAN_HEADER_KEYS = [
  "id", "spanSeq", "parentSpanId", "name", "status", "visibility",
  "startedAt", "endedAt", "durationMs", "eventIds", "childSpanIds", "metadata",
] as const satisfies ReadonlyArray<keyof TraceSpan>;

const SPAN_KEYS: ReadonlySet<string> = new Set([...SPAN_HEADER_KEYS, "hash"]);

function spanHeader(span: TraceSpan): Record<string, unknown> {
  const header: Record<string, unknown> = {};
  for (const key of SPAN_HEADER_KEYS) {
    if (span[key] !== undefined) {
      header[key] = span[key];
    }
  }
  return header;
}

/** Keys of `span` that are neither header fields nor `hash`; no span hash commits to them. */
export function uncommittedSpanKeys(span: object): string[] {
  return Object.keys(span).filter((key) => !SPAN_KEYS.has(key));
}

/**
 * The span as {@link computeSpanHash} commits to it, carrying `hash`: header
 * fields only, without the null-valued keys canonicalization drops.
 */
export function committedSpan(span: TraceSpan, hash: string): TraceSpan {
  return { ...normalizeJson(spanHeader(span)), hash } as unknown as TraceSpan;
}

/**
 * Compute the hash for a span including its event hashes.
 *
 * The span hash is computed as:
 * H("poi-trace:span:v1|" + canon(spanHeader) + "|" + eventHash1 + "|" + eventHash2 + ...)
 *
 * The span header is `id`, `spanSeq`, `parentSpanId`, `name`, `status`,
 * `visibility`, `startedAt`, `endedAt`, `durationMs`, `eventIds`,
 * `childSpanIds` and `metadata`; any other key, including `hash`, is not
 * committed. Event hashes are concatenated in sequence order, joined by "|".
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
  // Canonicalize the span header
  const canonicalHeader = canonicalize(spanHeader(span), { removeNulls: true });

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

const utf8 = new TextEncoder();

/**
 * Every level of each tree, leaves first, computed once so that later proofs
 * from the same tree cost O(log n). An entry is reused only while the tree
 * still holds the same leaf array, at the same length, under the same root.
 */
const treeLevels = new WeakMap<TraceMerkleTree, { leaves: string[]; levels: string[][] }>();

function levelsOf(tree: TraceMerkleTree): string[][] {
  const cached = treeLevels.get(tree);
  if (
    cached?.leaves === tree.leafHashes &&
    cached.levels[0]!.length === tree.leafHashes.length &&
    cached.levels[cached.levels.length - 1]![0] === tree.rootHash
  ) {
    return cached.levels;
  }
  const levels = [[...tree.leafHashes]];
  for (let level = levels[0]!; level.length > 1; level = levels[levels.length - 1]!) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left;
      next.push(bytesToHex(sha256(utf8.encode(HASH_DOMAIN_PREFIXES.node + left + "|" + right))));
    }
    levels.push(next);
  }
  treeLevels.set(tree, { leaves: tree.leafHashes, levels });
  return levels;
}

/**
 * Generate a Merkle proof for a specific span by index.
 *
 * The proof contains the sibling hashes along the path from the leaf to the root,
 * with position hints ("left" or "right") indicating which side each sibling is on.
 * The first proof from a tree computes its levels; later proofs reuse them.
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
  if (!Number.isSafeInteger(spanIndex) || spanIndex < 0 || spanIndex >= tree.leafCount) {
    throw new Error(
      `Span index ${spanIndex} is out of bounds (0-${tree.leafCount - 1})`
    );
  }

  const leafHash = tree.leafHashes[spanIndex];
  if (leafHash === undefined) {
    throw new Error(`Unexpected undefined leaf hash at index ${spanIndex}`);
  }

  const levels = levelsOf(tree);
  const siblings: MerkleProof["siblings"] = [];
  let index = spanIndex;
  for (const level of levels.slice(0, -1)) {
    const isLeftChild = index % 2 === 0;
    // The odd last node of a level is paired with itself.
    const siblingHash = level[isLeftChild ? index + 1 : index - 1] ?? level[index]!;
    siblings.push({ hash: siblingHash, position: isLeftChild ? "right" : "left" });
    index = Math.floor(index / 2);
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

function isMerkleProof(value: unknown): value is MerkleProof {
  return (
    isRecord(value) &&
    typeof value.leafHash === "string" &&
    typeof value.rootHash === "string" &&
    typeof value.leafIndex === "number" &&
    Array.isArray(value.siblings) &&
    value.siblings.every((sibling) =>
      isRecord(sibling) &&
      typeof sibling.hash === "string" &&
      (sibling.position === "left" || sibling.position === "right"))
  );
}

/** Levels above the leaves in a v1 tree of `leafCount` leaves. */
function treeDepth(leafCount: number): number {
  let depth = 0;
  for (let width = leafCount; width > 1; width = Math.ceil(width / 2)) {
    depth++;
  }
  return depth;
}

/**
 * Verify a Merkle proof against the expected root.
 *
 * Starting from the leaf hash, the proof is recomputed by combining with
 * sibling hashes according to their positions. The final computed root
 * must match the expected rootHash in the proof, and `leafIndex` must be the
 * index the sibling directions encode.
 *
 * A v1 proof does not carry the tree's leaf count, so on its own it cannot
 * rule out a padded index past the last leaf or an internal node presented as
 * a leaf. Pass `leafCount` from an authenticated source to require an index
 * below it and a path exactly as deep as that tree.
 *
 * @param proof - The Merkle proof to verify
 * @param leafCount - Authenticated number of leaves in the tree
 * @returns Promise resolving to true if the proof is valid
 *
 * @example
 * const valid = await verifyMerkleProof(proof);
 * if (!valid) {
 *   throw new Error("Merkle proof verification failed");
 * }
 */
export async function verifyMerkleProof(proof: MerkleProof, leafCount?: number): Promise<boolean> {
  if (!isMerkleProof(proof) || !Number.isSafeInteger(proof.leafIndex) || proof.leafIndex < 0) {
    return false;
  }
  if (
    leafCount !== undefined &&
    !(Number.isSafeInteger(leafCount) && proof.leafIndex < leafCount &&
      proof.siblings.length === treeDepth(leafCount))
  ) {
    return false;
  }
  let index = proof.leafIndex;
  // Start with the leaf hash
  let currentHash = proof.leafHash;

  // Traverse up the tree using the sibling hashes
  for (const sibling of proof.siblings) {
    if (sibling.position !== (index % 2 === 0 ? "right" : "left")) {
      return false;
    }
    index = Math.floor(index / 2);
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
  return index === 0 && currentHash === proof.rootHash;
}

/**
 * Check that span data hashes to the proof's leaf and that the proof is valid:
 * every event hash is recomputed from its body, and the span may carry only
 * header fields and a `hash` equal to the recomputed one. Without errors, the
 * result holds the span and its events, in `seq` order, as committed.
 */
export async function checkSpanData(
  proof: MerkleProof,
  span: unknown,
  events: unknown,
  leafCount?: number
): Promise<{ errors: string[]; committed?: { span: TraceSpan; events: TraceEvent[] } }> {
  if (!isRecord(span) || !Array.isArray(events)) {
    return { errors: ["Span data requires a span object and an events array"] };
  }
  const spanId = String(span.id);
  const errors = await verifyEventHashes(events as TraceEvent[]);
  const extra = uncommittedSpanKeys(span);
  if (extra.length > 0) {
    errors.push(`Span "${spanId}" carries fields its hash does not commit to: ${extra.join(", ")}`);
  }
  if (errors.length > 0) {
    return { errors };
  }

  const sortedEvents = [...(events as TraceEvent[])].sort((a, b) => a.seq - b.seq);
  let spanHash: string;
  try {
    spanHash = await computeSpanHash(span as unknown as TraceSpan, sortedEvents.map((e) => e.hash ?? ""));
  } catch (error) {
    return {
      errors: [`Failed to compute hash for span "${spanId}": ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  if (span.hash !== undefined && span.hash !== spanHash) {
    errors.push(`Span hash mismatch for "${spanId}": span has ${String(span.hash)}, computed ${spanHash}`);
  }
  const leafHash = await sha256StringHex(HASH_DOMAIN_PREFIXES.leaf + spanHash);
  if (!isMerkleProof(proof)) {
    errors.push(`Merkle proof for span "${spanId}" is malformed`);
  } else if (leafHash !== proof.leafHash) {
    errors.push(
      `Span hash verification failed for "${spanId}": computed leaf hash "${leafHash}" ` +
        `does not match proof leaf hash "${proof.leafHash}". The span data may have been modified.`
    );
  } else if (!(await verifyMerkleProof(proof, leafCount))) {
    errors.push(`Merkle proof verification failed for span "${spanId}"`);
  }
  if (errors.length > 0) {
    return { errors };
  }
  return {
    errors,
    committed: {
      span: committedSpan(span as unknown as TraceSpan, spanHash),
      events: sortedEvents.map((event) => committedEvent(event, event.hash!)),
    },
  };
}

/**
 * Verify a span's inclusion using its proof and data.
 *
 * This function recomputes every event hash and the span hash from the
 * provided data, then verifies that the resulting leaf hash matches the proof
 * and that the proof is valid against its root. The span may carry only the
 * header fields its hash commits to, plus a `hash` equal to the recomputed one.
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
  return (await checkSpanData(proof, span, events)).errors.length === 0;
}
