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
 * - "membership": Merkle proof only - proves that a leaf is in the tree
 *   without exposing the actual span data. The entry carries no span data, so
 *   it binds a span id only when the verifier already holds that span's leaf
 *   hash and the tree's leaf count from an authenticated source.
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
 * // Verify disclosure against anchor; read span data from the result
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
  checkSpanData,
} from "./merkle.js";
import { isRecord, readOnce } from "./guards.js";

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

/**
 * Facts the caller supplies to {@link verifyDisclosure} from a source it
 * already trusts, never from the disclosure itself.
 */
export interface VerifyDisclosureOptions {
  /**
   * Merkle leaf hash for each span id. A membership entry verifies only for a
   * span id listed here, and a full entry for a listed span id must hash to
   * that leaf.
   */
  leafHashes?: Readonly<Record<string, string>>;
  /**
   * Number of leaves in the anchored tree. Required for membership entries;
   * when given, every proof must use an index below it and a path as deep as
   * that tree.
   */
  leafCount?: number;
}

/** A verified disclosure entry. Span data is present for full entries, holding only committed fields. */
export interface VerifiedDisclosedSpan {
  spanId: string;
  span?: TraceSpan;
  events?: TraceEvent[];
}

/** Result of {@link verifyDisclosure}. */
export interface DisclosureVerificationResult {
  valid: boolean;
  errors: string[];
  /** Verified entries in disclosure order; empty unless `valid`. */
  spans: VerifiedDisclosedSpan[];
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
 * Get events belonging to a specific span.
 *
 * @param eventMap - The bundle's events by ID
 * @param span - The span to get events for
 * @returns Array of events sorted by seq
 */
function getSpanEventsFromMap(
  eventMap: ReadonlyMap<string, TraceEvent>,
  span: TraceSpan
): TraceEvent[] {
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
 * @param spanIds - IDs of spans to disclose, at least one, each once
 * @param mode - Disclosure mode:
 *   - "membership": Merkle proof only (proves span exists with hash)
 *   - "full": Merkle proof + span data + event data
 * @returns Promise resolving to DisclosureResult with proofs and optionally data
 * @throws Error if spanIds is empty, repeats an ID, or names a span that does
 *   not exist in the bundle
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
  if (spanIds.length === 0) {
    throw new Error("A disclosure requires at least one span ID");
  }
  if (new Set(spanIds).size !== spanIds.length) {
    throw new Error("A disclosure cannot name the same span ID more than once");
  }

  // Sort spans by spanSeq for consistent indexing; an ID resolves to its first span
  const sortedSpans = [...bundle.privateRun.spans].sort(
    (a, b) => a.spanSeq - b.spanSeq
  );
  const indexById = new Map<string, number>();
  for (const [index, span] of sortedSpans.entries()) {
    if (!indexById.has(span.id)) {
      indexById.set(span.id, index);
    }
  }

  const missingSpanIds = spanIds.filter((spanId) => !indexById.has(spanId));
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
  const eventMap = new Map(bundle.privateRun.events.map((event) => [event.id, event]));

  // Generate disclosures for each requested span
  const disclosedSpans: DisclosureResult["disclosedSpans"] = [];

  for (const spanId of spanIds) {
    const spanIndex = indexById.get(spanId)!;
    const span = sortedSpans[spanIndex]!;

    // Generate Merkle proof
    const proof = generateMerkleProof(merkleTree, spanIndex);

    // Build the disclosed span entry
    if (mode === "full") {
      // Full mode: include span data and events
      const events = getSpanEventsFromMap(eventMap, span);

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
 * 3. Requires at least one entry, at most one entry per span ID and no event
 *    ID disclosed twice
 * 4. For full entries, recomputes every event hash, the span hash and the
 *    leaf, verifies the Merkle proof, and, when `options.leafHashes` lists the
 *    span ID, requires that leaf
 * 5. For membership entries, which carry no span data, requires the caller's
 *    authenticated leaf hash for the span ID and the tree's leaf count, then
 *    verifies the Merkle proof against both
 *
 * The disclosure is read once, as JSON data, before any check, so changes to
 * it after the call cannot reach the result. Read span data from the result's
 * `spans`, which holds only committed fields, rather than from the disclosure
 * itself.
 *
 * @param disclosure - The disclosure result to verify
 * @param expectedRootHash - Expected root hash from anchor/on-chain commitment
 * @param expectedMerkleRoot - Expected Merkle root from anchor/on-chain commitment
 * @param options - Authenticated leaf hashes and leaf count; membership entries
 *   are reported as unbound without them
 * @returns Promise resolving to the verification result and the verified spans
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
 *   console.log("Disclosed span:", verification.spans[0]?.span?.name);
 * } else {
 *   console.error("Verification failed:", verification.errors);
 * }
 * ```
 */
export async function verifyDisclosure(
  disclosure: DisclosureResult,
  expectedRootHash: string,
  expectedMerkleRoot: string,
  options: VerifyDisclosureOptions = {}
): Promise<DisclosureVerificationResult> {
  const read = readOnce(disclosure);
  if ("error" in read) {
    return { valid: false, errors: [`Disclosure is ${read.error}`], spans: [] };
  }
  const result = await verifyDisclosureData(read.data, expectedRootHash, expectedMerkleRoot, options);
  const valid = result.errors.length === 0;
  return { valid, errors: result.errors, spans: valid ? result.spans : [] };
}

/** {@link verifyDisclosure} on plain data that nothing else can change while it runs. */
async function verifyDisclosureData(
  disclosure: unknown,
  expectedRootHash: string,
  expectedMerkleRoot: string,
  options: VerifyDisclosureOptions
): Promise<{ errors: string[]; spans: VerifiedDisclosedSpan[] }> {
  if (!isRecord(disclosure) || !Array.isArray(disclosure.disclosedSpans)) {
    return { errors: ["Disclosure must be an object with a disclosedSpans array"], spans: [] };
  }
  const errors: string[] = [];
  const spans: VerifiedDisclosedSpan[] = [];

  if (disclosure.mode !== "full" && disclosure.mode !== "membership") {
    errors.push(`Unknown disclosure mode "${String(disclosure.mode)}"`);
  }

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

  if (disclosure.disclosedSpans.length === 0) {
    errors.push("Disclosure contains no spans");
  }

  const seen = new Set<string>();
  const disclosedEventIds = new Set<unknown>();
  for (const disclosed of disclosure.disclosedSpans as unknown[]) {
    if (!isRecord(disclosed) || typeof disclosed.spanId !== "string") {
      errors.push("Disclosure entry must be an object with a string spanId");
      continue;
    }
    const { spanId } = disclosed;
    if (seen.has(spanId)) {
      errors.push(`Duplicate disclosure for span "${spanId}"`);
      continue;
    }
    seen.add(spanId);

    if (disclosure.mode === "full" || disclosed.span !== undefined || disclosed.events !== undefined) {
      const entry = await verifyFullEntry(disclosed, expectedMerkleRoot, options);
      errors.push(...entry.errors);
      if (entry.committed !== undefined) {
        for (const { id } of entry.committed.events) {
          if (disclosedEventIds.has(id)) {
            errors.push(`Event ID "${id}" is disclosed in more than one span`);
          }
          disclosedEventIds.add(id);
        }
        spans.push({ spanId, ...entry.committed });
      }
    } else {
      const entryErrors = await membershipErrors(spanId, disclosed.proof, expectedMerkleRoot, options);
      errors.push(...entryErrors);
      if (entryErrors.length === 0) {
        spans.push({ spanId });
      }
    }
  }

  return { errors, spans };
}

/** The leaf hash the caller authenticated for `spanId`, if any. */
function authenticatedLeaf(leafHashes: VerifyDisclosureOptions["leafHashes"], spanId: string): string | undefined {
  return leafHashes !== undefined && Object.hasOwn(leafHashes, spanId) ? leafHashes[spanId] : undefined;
}

/**
 * Bind a span-data entry to its spanId, to the leaf hash the caller
 * authenticated for that spanId if any, and to the expected root, then check
 * its data.
 */
async function verifyFullEntry(
  disclosed: Record<string, unknown>,
  expectedMerkleRoot: string,
  { leafHashes, leafCount }: VerifyDisclosureOptions
): Promise<{ errors: string[]; committed?: { span: TraceSpan; events: TraceEvent[] } }> {
  const { spanId, proof, span, events } = disclosed;
  if (!isRecord(span) || !Array.isArray(events)) {
    return { errors: [`Disclosure for span "${String(spanId)}" requires span and events`] };
  }
  const errors: string[] = [];
  if (span.id !== spanId) {
    errors.push(`Span ID mismatch for "${String(spanId)}": body has "${String(span.id)}"`);
  }
  const check = await checkSpanData(proof as MerkleProof, span, events, leafCount);
  errors.push(...check.errors);
  if (isRecord(proof) && proof.rootHash !== expectedMerkleRoot) {
    errors.push(
      `Proof root hash mismatch for span "${String(spanId)}": ` +
        `proof has "${String(proof.rootHash)}", expected "${expectedMerkleRoot}"`
    );
  }
  const pinned = authenticatedLeaf(leafHashes, String(spanId));
  if (pinned !== undefined && (!isRecord(proof) || proof.leafHash !== pinned)) {
    errors.push(`Disclosed span "${String(spanId)}" does not hash to its authenticated leaf hash`);
  }
  return errors.length === 0 && check.committed !== undefined
    ? { errors, committed: check.committed }
    : { errors };
}

/**
 * A membership entry has no span data to hash, so only the caller's
 * authenticated leaf hash binds its span ID, and only the authenticated leaf
 * count rules out padded indices and internal nodes presented as leaves.
 */
async function membershipErrors(
  spanId: string,
  proof: unknown,
  expectedMerkleRoot: string,
  { leafHashes, leafCount }: VerifyDisclosureOptions
): Promise<string[]> {
  const leafHash = authenticatedLeaf(leafHashes, spanId);
  if (leafHash === undefined) {
    return [
      `Membership entry for span "${spanId}" is unbound: span id not authenticated. ` +
        "Pass its leaf hash from an authenticated source in options.leafHashes.",
    ];
  }
  if (leafCount === undefined) {
    return [
      `Membership entry for span "${spanId}" is unbound: the tree's leaf count is not authenticated. ` +
        "Pass it in options.leafCount.",
    ];
  }
  if (!isRecord(proof) || proof.leafHash !== leafHash) {
    return [`Membership proof for span "${spanId}" does not prove its authenticated leaf hash`];
  }
  const errors: string[] = [];
  if (!(await verifyMerkleProof(proof as unknown as MerkleProof, leafCount))) {
    errors.push(`Merkle proof verification failed for span "${spanId}"`);
  }
  if (proof.rootHash !== expectedMerkleRoot) {
    errors.push(
      `Proof root hash mismatch for span "${spanId}": ` +
        `proof has "${String(proof.rootHash)}", expected "${expectedMerkleRoot}"`
    );
  }
  return errors;
}

/**
 * Verify a single span's disclosure (with data).
 *
 * This function performs detailed verification of a disclosed span:
 * 1. Requires the span body's ID to equal `spanId`
 * 2. Recomputes every event hash, then the span hash from the provided span
 *    and events; the span may carry only header fields and a `hash` equal to
 *    the recomputed one
 * 3. Verifies the resulting leaf hash matches the proof's leafHash
 * 4. Verifies the Merkle proof is valid and ends at `expectedMerkleRoot`
 *
 * This is used for "full" mode disclosures where span data is provided. The
 * entry is read once, before any check. When valid, `span` and `events` hold
 * the committed data in `seq` order.
 *
 * @param disclosed - Object containing spanId, proof, span data, and events
 * @param expectedMerkleRoot - Expected Merkle root from anchor/on-chain commitment
 * @returns Promise resolving to verification result with validity status, errors
 *   and, when valid, the committed span and events
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
): Promise<{ valid: boolean; errors: string[]; span?: TraceSpan; events?: TraceEvent[] }> {
  const read = readOnce(disclosed);
  if ("error" in read) {
    return { valid: false, errors: [`Disclosure entry is ${read.error}`] };
  }
  if (!isRecord(read.data)) {
    return { valid: false, errors: ["Disclosure entry must be an object"] };
  }
  const { errors, committed } = await verifyFullEntry(read.data, expectedMerkleRoot, {});
  return committed !== undefined ? { valid: true, errors, ...committed } : { valid: false, errors };
}
