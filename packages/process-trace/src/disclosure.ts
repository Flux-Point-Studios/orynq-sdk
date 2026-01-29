/**
 * @fileoverview Selective disclosure of trace spans with Merkle proofs.
 *
 * Location: packages/process-trace/src/disclosure.ts
 *
 * This module implements selective disclosure functionality for trace bundles,
 * enabling privacy-preserving audits and compliance workflows. It allows verifiers
 * to prove the existence of specific spans without revealing the entire trace.
 *
 * Key Concepts:
 * - Selective Disclosure: Reveal only specific spans from a trace bundle
 * - Membership Proofs: Prove a span exists without revealing its contents
 * - Full Disclosure: Prove existence AND reveal span data with events
 *
 * Disclosure Modes:
 * - "membership": Merkle proof only - proves span exists with specific hash
 *   without exposing the actual span data. Useful for compliance checks.
 * - "full": Merkle proof + span data + event data - allows verifier to
 *   recompute hashes and fully verify the span contents.
 *
 * Use Cases:
 * - Audit: "Show me span 3" (full mode) - auditor sees exactly what happened
 * - Compliance: "Prove span exists" (membership) - no data exposure
 * - Selective sharing: Disclose only public spans to external parties
 *
 * Used by:
 * - Audit workflows: Selective disclosure of trace spans
 * - Compliance verification: Prove span existence without data exposure
 * - API endpoints: Create and verify disclosure requests
 *
 * @example
 * ```typescript
 * // Full disclosure of specific spans
 * const result = await selectiveDisclose(bundle, ["span-1", "span-3"], "full");
 * for (const disclosed of result.disclosedSpans) {
 *   console.log("Span:", disclosed.span?.name);
 *   console.log("Events:", disclosed.events?.length);
 * }
 *
 * // Membership proof only (no data exposure)
 * const membershipResult = await selectiveDisclose(bundle, ["span-2"], "membership");
 *
 * // Verify disclosure against anchor
 * const verification = await verifyDisclosure(result, anchor.rootHash, anchor.merkleRoot);
 * if (!verification.valid) {
 *   console.error("Verification failed:", verification.errors);
 * }
 * ```
 */

import type {
  TraceBundle,
  TraceSpan,
  TraceEvent,
  DisclosureMode,
  DisclosureResult,
  MerkleProof,
} from "./types.js";
import {
  generateMerkleProof,
  verifyMerkleProof,
  buildSpanMerkleTree,
  computeSpanHash,
} from "./merkle.js";
import { HASH_DOMAIN_PREFIXES } from "./types.js";
import { sha256StringHex } from "@fluxpointstudios/poi-sdk-core/utils";

// =============================================================================
// DISCLOSURE REQUEST
// =============================================================================

/**
 * Disclosure request structure for API use.
 *
 * This interface defines the shape of a disclosure request that can be
 * transmitted over network APIs. It contains all the information needed
 * to identify the bundle and specify which spans to disclose.
 *
 * @property bundleRootHash - The root hash of the bundle for identification
 * @property bundleMerkleRoot - The Merkle root for verification
 * @property spanIds - Array of span IDs to disclose
 * @property mode - Disclosure mode (membership or full)
 */
export interface DisclosureRequest {
  bundleRootHash: string;
  bundleMerkleRoot: string;
  spanIds: string[];
  mode: DisclosureMode;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if a span can be disclosed (exists in bundle).
 *
 * This function performs a simple existence check to determine if a span
 * with the given ID exists in the bundle. It searches the privateRun.spans
 * array for a matching span ID.
 *
 * @param bundle - The trace bundle to check
 * @param spanId - The ID of the span to look for
 * @returns true if the span exists in the bundle, false otherwise
 *
 * @example
 * ```typescript
 * if (canDisclose(bundle, "span-123")) {
 *   const result = await selectiveDisclose(bundle, ["span-123"], "full");
 * } else {
 *   console.error("Span not found in bundle");
 * }
 * ```
 */
export function canDisclose(bundle: TraceBundle, spanId: string): boolean {
  return bundle.privateRun.spans.some((span) => span.id === spanId);
}

/**
 * Get span index by ID (needed for proof generation).
 *
 * Returns the index of a span in the sorted spans array (sorted by spanSeq).
 * This index is used for Merkle proof generation, as the proof depends on
 * the position of the span's leaf in the Merkle tree.
 *
 * @param bundle - The trace bundle containing the span
 * @param spanId - The ID of the span to find
 * @returns The 0-indexed position of the span in the sorted array
 * @throws Error if the span is not found in the bundle
 *
 * @example
 * ```typescript
 * const index = getSpanIndex(bundle, "span-456");
 * console.log(`Span is at index ${index} in the Merkle tree`);
 * ```
 */
export function getSpanIndex(bundle: TraceBundle, spanId: string): number {
  // Sort spans by spanSeq for consistent ordering (matches Merkle tree order)
  const sortedSpans = [...bundle.privateRun.spans].sort(
    (a, b) => a.spanSeq - b.spanSeq
  );

  const index = sortedSpans.findIndex((span) => span.id === spanId);

  if (index === -1) {
    throw new Error(
      `Span with ID "${spanId}" not found in bundle. ` +
        `Available span IDs: ${sortedSpans.map((s) => s.id).join(", ")}`
    );
  }

  return index;
}

/**
 * Get events belonging to a specific span from the bundle.
 *
 * @param bundle - The trace bundle
 * @param span - The span to get events for
 * @returns Array of events sorted by seq
 */
function getSpanEventsFromBundle(
  bundle: TraceBundle,
  span: TraceSpan
): TraceEvent[] {
  // Create event lookup map
  const eventMap = new Map<string, TraceEvent>();
  for (const event of bundle.privateRun.events) {
    eventMap.set(event.id, event);
  }

  // Get events for this span and sort by seq
  return span.eventIds
    .map((id) => eventMap.get(id))
    .filter((e): e is TraceEvent => e !== undefined)
    .sort((a, b) => a.seq - b.seq);
}

// =============================================================================
// DISCLOSURE REQUEST CREATION
// =============================================================================

/**
 * Create a disclosure request (for API use).
 *
 * This function creates a structured disclosure request object that can be
 * serialized and transmitted over network APIs. The request contains all
 * information needed to identify the bundle and specify which spans to disclose.
 *
 * @param bundle - The trace bundle to create a request for
 * @param spanIds - Array of span IDs to request disclosure for
 * @param mode - The disclosure mode (membership or full)
 * @returns A DisclosureRequest object ready for transmission
 *
 * @example
 * ```typescript
 * const request = createDisclosureRequest(
 *   bundle,
 *   ["span-1", "span-3"],
 *   "full"
 * );
 *
 * // Send request to disclosure service
 * const response = await fetch("/api/disclose", {
 *   method: "POST",
 *   body: JSON.stringify(request),
 * });
 * ```
 */
export function createDisclosureRequest(
  bundle: TraceBundle,
  spanIds: string[],
  mode: DisclosureMode
): DisclosureRequest {
  return {
    bundleRootHash: bundle.rootHash,
    bundleMerkleRoot: bundle.merkleRoot,
    spanIds: [...spanIds], // Create a copy to prevent external mutation
    mode,
  };
}

// =============================================================================
// SELECTIVE DISCLOSURE
// =============================================================================

/**
 * Selectively disclose specific spans from a bundle.
 *
 * This function generates disclosure results for the specified spans. Depending
 * on the disclosure mode, it includes either just Merkle proofs (membership mode)
 * or Merkle proofs plus full span and event data (full mode).
 *
 * The function validates that all requested spans exist in the bundle before
 * proceeding with disclosure generation.
 *
 * @param bundle - The trace bundle containing all data
 * @param spanIds - IDs of spans to disclose
 * @param mode - Disclosure mode:
 *   - "membership": Merkle proof only (proves span exists with hash)
 *   - "full": Merkle proof + span data + event data
 * @returns Promise resolving to DisclosureResult with proofs and optionally data
 * @throws Error if any requested spanId does not exist in the bundle
 *
 * @example
 * ```typescript
 * // Full disclosure - includes span data and events
 * const fullResult = await selectiveDisclose(bundle, ["span-1"], "full");
 * console.log(fullResult.disclosedSpans[0].span?.name);
 * console.log(fullResult.disclosedSpans[0].events?.length);
 *
 * // Membership disclosure - proof only, no data
 * const membershipResult = await selectiveDisclose(bundle, ["span-1"], "membership");
 * // membershipResult.disclosedSpans[0].span is undefined
 * // membershipResult.disclosedSpans[0].events is undefined
 * ```
 */
export async function selectiveDisclose(
  bundle: TraceBundle,
  spanIds: string[],
  mode: DisclosureMode
): Promise<DisclosureResult> {
  // Validate all spanIds exist in bundle
  const missingSpanIds: string[] = [];
  for (const spanId of spanIds) {
    if (!canDisclose(bundle, spanId)) {
      missingSpanIds.push(spanId);
    }
  }

  if (missingSpanIds.length > 0) {
    throw new Error(
      `Cannot disclose spans that do not exist in bundle: ${missingSpanIds.join(", ")}`
    );
  }

  // Build the Merkle tree for proof generation
  const merkleTree = await buildSpanMerkleTree(
    bundle.privateRun.spans,
    bundle.privateRun.events
  );

  // Sort spans by spanSeq for consistent indexing
  const sortedSpans = [...bundle.privateRun.spans].sort(
    (a, b) => a.spanSeq - b.spanSeq
  );

  // Create a map for quick span lookup
  const spanMap = new Map<string, TraceSpan>();
  for (const span of sortedSpans) {
    spanMap.set(span.id, span);
  }

  // Generate disclosures for each requested span
  const disclosedSpans: DisclosureResult["disclosedSpans"] = [];

  for (const spanId of spanIds) {
    // Get the span and its index
    const span = spanMap.get(spanId);
    if (!span) {
      // This should not happen since we validated above, but handle defensively
      throw new Error(`Span "${spanId}" not found after validation`);
    }

    const spanIndex = getSpanIndex(bundle, spanId);

    // Generate Merkle proof
    const proof = generateMerkleProof(merkleTree, spanIndex);

    // Build the disclosed span entry
    if (mode === "full") {
      // Full mode: include span data and events
      const events = getSpanEventsFromBundle(bundle, span);

      disclosedSpans.push({
        spanId,
        proof,
        span: { ...span }, // Clone to prevent external mutation
        events: events.map((e) => ({ ...e })), // Clone events
      });
    } else {
      // Membership mode: proof only, no data
      disclosedSpans.push({
        spanId,
        proof,
        // span and events are undefined in membership mode
      });
    }
  }

  return {
    mode,
    rootHash: bundle.rootHash,
    merkleRoot: bundle.merkleRoot,
    disclosedSpans,
  };
}

// =============================================================================
// VERIFICATION FUNCTIONS
// =============================================================================

/**
 * Verify a disclosure result against expected hashes.
 *
 * This function performs comprehensive verification of a disclosure result:
 * 1. Checks that rootHash matches the expected value from the anchor
 * 2. Checks that merkleRoot matches the expected value from the anchor
 * 3. For each disclosed span, verifies the Merkle proof
 * 4. For full mode disclosures, verifies span hash recomputation
 *
 * @param disclosure - The disclosure result to verify
 * @param expectedRootHash - Expected root hash from anchor/on-chain commitment
 * @param expectedMerkleRoot - Expected Merkle root from anchor/on-chain commitment
 * @returns Promise resolving to verification result with validity status and errors
 *
 * @example
 * ```typescript
 * const disclosure = await selectiveDisclose(bundle, ["span-1"], "full");
 * const verification = await verifyDisclosure(
 *   disclosure,
 *   anchor.rootHash,
 *   anchor.merkleRoot
 * );
 *
 * if (verification.valid) {
 *   console.log("Disclosure verified successfully");
 * } else {
 *   console.error("Verification failed:", verification.errors);
 * }
 * ```
 */
export async function verifyDisclosure(
  disclosure: DisclosureResult,
  expectedRootHash: string,
  expectedMerkleRoot: string
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  // Check rootHash matches expected
  if (disclosure.rootHash !== expectedRootHash) {
    errors.push(
      `Root hash mismatch: disclosure has "${disclosure.rootHash}", ` +
        `expected "${expectedRootHash}"`
    );
  }

  // Check merkleRoot matches expected
  if (disclosure.merkleRoot !== expectedMerkleRoot) {
    errors.push(
      `Merkle root mismatch: disclosure has "${disclosure.merkleRoot}", ` +
        `expected "${expectedMerkleRoot}"`
    );
  }

  // Verify each disclosed span
  for (const disclosed of disclosure.disclosedSpans) {
    // Verify the Merkle proof for this span
    const proofValid = await verifyMerkleProof(disclosed.proof);

    if (!proofValid) {
      errors.push(
        `Merkle proof verification failed for span "${disclosed.spanId}"`
      );
      continue; // Skip further checks for this span
    }

    // Verify proof rootHash matches expected
    if (disclosed.proof.rootHash !== expectedMerkleRoot) {
      errors.push(
        `Proof root hash mismatch for span "${disclosed.spanId}": ` +
          `proof has "${disclosed.proof.rootHash}", expected "${expectedMerkleRoot}"`
      );
    }

    // For full mode with data, verify span hash recomputation
    if (disclosure.mode === "full" && disclosed.span && disclosed.events) {
      const spanVerification = await verifySpanDisclosure(
        {
          spanId: disclosed.spanId,
          proof: disclosed.proof,
          span: disclosed.span,
          events: disclosed.events,
        },
        expectedMerkleRoot
      );

      if (!spanVerification.valid) {
        errors.push(...spanVerification.errors);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Verify a single span's disclosure (with data).
 *
 * This function performs detailed verification of a disclosed span:
 * 1. Recomputes the span hash from the provided span and events
 * 2. Computes the expected leaf hash from the span hash
 * 3. Verifies the leaf hash matches the proof's leafHash
 * 4. Verifies the Merkle proof is valid
 *
 * This is used for "full" mode disclosures where span data is provided.
 *
 * @param disclosed - Object containing spanId, proof, span data, and events
 * @param expectedMerkleRoot - Expected Merkle root from anchor/on-chain commitment
 * @returns Promise resolving to verification result with validity status and errors
 *
 * @example
 * ```typescript
 * const result = await verifySpanDisclosure(
 *   {
 *     spanId: "span-123",
 *     proof: merkleProof,
 *     span: spanData,
 *     events: spanEvents,
 *   },
 *   expectedMerkleRoot
 * );
 *
 * if (result.valid) {
 *   console.log("Span data is authentic and included in the trace");
 * }
 * ```
 */
export async function verifySpanDisclosure(
  disclosed: {
    spanId: string;
    proof: MerkleProof;
    span: TraceSpan;
    events: TraceEvent[];
  },
  expectedMerkleRoot: string
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  // Sort events by seq for deterministic hash computation
  const sortedEvents = [...disclosed.events].sort((a, b) => a.seq - b.seq);

  // Get event hashes in seq order
  const eventHashes = sortedEvents.map((e) => e.hash ?? "");

  // Recompute span hash from span + events
  const computedSpanHash = await computeSpanHash(disclosed.span, eventHashes);

  // Compute expected leaf hash: H("poi-trace:leaf:v1|" + spanHash)
  const computedLeafHash = await sha256StringHex(
    HASH_DOMAIN_PREFIXES.leaf + computedSpanHash
  );

  // Verify leaf hash matches proof.leafHash
  if (computedLeafHash !== disclosed.proof.leafHash) {
    errors.push(
      `Span hash verification failed for "${disclosed.spanId}": ` +
        `computed leaf hash "${computedLeafHash}" does not match ` +
        `proof leaf hash "${disclosed.proof.leafHash}". ` +
        `The span data may have been modified.`
    );
  }

  // Verify Merkle proof
  const proofValid = await verifyMerkleProof(disclosed.proof);
  if (!proofValid) {
    errors.push(
      `Merkle proof verification failed for span "${disclosed.spanId}"`
    );
  }

  // Verify proof rootHash matches expected
  if (disclosed.proof.rootHash !== expectedMerkleRoot) {
    errors.push(
      `Proof root hash mismatch for span "${disclosed.spanId}": ` +
        `proof has "${disclosed.proof.rootHash}", expected "${expectedMerkleRoot}"`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
