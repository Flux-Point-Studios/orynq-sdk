/**
 * @fileoverview Bundle creation, extraction, verification, and signing for trace bundles.
 *
 * Location: packages/process-trace/src/bundle.ts
 *
 * This module provides the core functionality for working with trace bundles:
 * - Creating bundles from finalized trace runs
 * - Extracting public views for safe external sharing
 * - Verifying bundle integrity (hashes, sequences, merkle proofs)
 * - Signing and verifying bundle signatures
 *
 * A TraceBundle is the finalized, immutable form of a trace run that includes:
 * - The complete private trace run data
 * - A public view with redacted sensitive information
 * - Cryptographic commitments (rootHash, merkleRoot)
 * - Optional signature for authenticity verification
 *
 * Visibility Rules:
 * - "public": Events/spans are included in the publicView
 * - "private": Hash included in redactedSpanHashes, data not disclosed
 * - "secret": Hash included in redactedSpanHashes, data never disclosed
 *
 * Used by:
 * - TraceBuilder: Creates bundles when finalizing traces
 * - TraceVerifier: Validates bundle integrity
 * - TraceStorage: Prepares bundles for storage/transmission
 * - Disclosure workflows: Extracts public views for sharing
 *
 * @example
 * ```typescript
 * // Create a bundle from a finalized run
 * const bundle = await createBundle(finalizedRun);
 *
 * // Extract public view for sharing
 * const publicView = extractPublicView(bundle);
 *
 * // Verify bundle integrity
 * const result = await verifyBundle(bundle);
 * if (!result.valid) {
 *   console.error("Bundle verification failed:", result.errors);
 * }
 *
 * // Sign a bundle
 * const signedBundle = await signBundle(bundle, signatureProvider);
 * ```
 */

import {
  canonicalize,
  bytesToHex,
  hexToBytes,
} from "@fluxpointstudios/orynq-sdk-core/utils";

import type {
  TraceBundle,
  TraceBundlePublicView,
  TraceRun,
  TraceSpan,
  TraceEvent,
  AnnotatedSpan,
  TraceVerificationResult,
  SignatureProvider,
  Visibility,
} from "./types.js";

import {
  computeEventHash,
  computeRollingHash,
  computeRootHash,
} from "./rolling-hash.js";

import { buildSpanMerkleTree, computeSpanHash } from "./merkle.js";

// =============================================================================
// VISIBILITY HELPERS
// =============================================================================

/**
 * Check if a span should be included in public view.
 *
 * Only spans with visibility "public" are included in the public view.
 * Private and secret spans are redacted (only their hashes are included).
 *
 * @param span - The span to check
 * @returns true if the span is public and should be included in publicView
 *
 * @example
 * ```typescript
 * if (isPublicSpan(span)) {
 *   publicSpans.push(span);
 * } else {
 *   redactedSpanHashes.push({ spanId: span.id, hash: span.hash });
 * }
 * ```
 */
export function isPublicSpan(span: TraceSpan): boolean {
  return span.visibility === "public";
}

/**
 * Check if an event should be included in public view.
 *
 * Only events with visibility "public" are included in the public view.
 * Private and secret events are not disclosed.
 *
 * @param event - The event to check
 * @returns true if the event is public and should be included in publicView
 *
 * @example
 * ```typescript
 * const publicEvents = events.filter(isPublicEvent);
 * ```
 */
export function isPublicEvent(event: TraceEvent): boolean {
  return event.visibility === "public";
}

/**
 * Filter events by visibility, returning only public events.
 *
 * This function creates a new array containing only events with
 * visibility === "public". The original array is not modified.
 *
 * @param events - Array of trace events to filter
 * @returns Array containing only public events
 *
 * @example
 * ```typescript
 * const allEvents = getSpanEvents(span, run.events);
 * const publicEvents = filterPublicEvents(allEvents);
 * ```
 */
export function filterPublicEvents(events: TraceEvent[]): TraceEvent[] {
  return events.filter(isPublicEvent);
}

// =============================================================================
// BUNDLE CREATION
// =============================================================================

/**
 * Create a bundle from a finalized trace run.
 *
 * The run should already have rootHash computed (i.e., be finalized).
 * This function:
 * 1. Validates the run is finalized
 * 2. Builds the Merkle tree if not already computed
 * 3. Creates the public view with redacted sensitive data
 * 4. Returns the complete bundle
 *
 * @param run - The finalized trace run (must have rootHash)
 * @returns Promise resolving to the complete TraceBundle
 * @throws Error if the run is not finalized (missing rootHash)
 *
 * @example
 * ```typescript
 * // Finalize the run first
 * const finalizedRun = await finalizeTraceRun(run);
 *
 * // Create the bundle
 * const bundle = await createBundle(finalizedRun);
 * console.log(bundle.rootHash); // Cryptographic commitment
 * console.log(bundle.merkleRoot); // Merkle root for selective disclosure
 * ```
 */
export async function createBundle(run: TraceRun): Promise<TraceBundle> {
  // Validate run is finalized
  if (!run.rootHash) {
    throw new Error(
      "Cannot create bundle from non-finalized run: rootHash is missing. " +
        "Call finalizeTraceRun() before creating a bundle."
    );
  }

  if (run.status === "running") {
    throw new Error(
      "Cannot create bundle from running trace. " +
        "The trace must be completed, failed, or cancelled."
    );
  }

  // Ensure all events have hashes computed
  for (const event of run.events) {
    if (!event.hash) {
      throw new Error(
        `Event ${event.id} (seq ${event.seq}) is missing hash. ` +
          "All events must have hashes computed before creating a bundle."
      );
    }
  }

  // Ensure all spans have hashes computed
  for (const span of run.spans) {
    if (!span.hash) {
      throw new Error(
        `Span ${span.id} (spanSeq ${span.spanSeq}) is missing hash. ` +
          "All spans must have hashes computed before creating a bundle."
      );
    }
  }

  // Build Merkle tree from spans
  const merkleTree = await buildSpanMerkleTree(run.spans, run.events);

  // Create the public view
  const publicView = createPublicView(run, merkleTree.rootHash);

  // Construct the bundle
  const bundle: TraceBundle = {
    formatVersion: run.schemaVersion,
    publicView,
    privateRun: run,
    merkleRoot: merkleTree.rootHash,
    rootHash: run.rootHash,
  };

  return bundle;
}

/**
 * Internal helper to create the public view from a run.
 *
 * @param run - The finalized trace run
 * @param merkleRoot - The computed Merkle root
 * @returns The TraceBundlePublicView
 */
function createPublicView(
  run: TraceRun,
  merkleRoot: string
): TraceBundlePublicView {
  // Create event lookup map
  const eventMap = new Map<string, TraceEvent>();
  for (const event of run.events) {
    eventMap.set(event.id, event);
  }

  // Separate public and non-public spans
  const publicSpans: AnnotatedSpan[] = [];
  const redactedSpanHashes: Array<{ spanId: string; hash: string }> = [];

  for (const span of run.spans) {
    if (isPublicSpan(span)) {
      // Get events for this span and filter to public only
      const spanEvents = span.eventIds
        .map((id) => eventMap.get(id))
        .filter((e): e is TraceEvent => e !== undefined)
        .filter(isPublicEvent)
        .sort((a, b) => a.seq - b.seq);

      // Create annotated span with embedded events
      const annotatedSpan: AnnotatedSpan = {
        ...span,
        events: spanEvents,
      };

      publicSpans.push(annotatedSpan);
    } else {
      // Non-public span: include only hash reference
      redactedSpanHashes.push({
        spanId: span.id,
        hash: span.hash ?? "",
      });
    }
  }

  // Sort public spans by spanSeq for deterministic ordering
  publicSpans.sort((a, b) => a.spanSeq - b.spanSeq);

  // Sort redacted hashes by spanId for deterministic ordering
  redactedSpanHashes.sort((a, b) => a.spanId.localeCompare(b.spanId));

  return {
    runId: run.id,
    agentId: run.agentId,
    schemaVersion: run.schemaVersion,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? new Date().toISOString(),
    durationMs: run.durationMs ?? 0,
    status: run.status,
    totalEvents: run.events.length,
    totalSpans: run.spans.length,
    rootHash: run.rootHash ?? "",
    merkleRoot,
    publicSpans,
    redactedSpanHashes,
  };
}

// =============================================================================
// PUBLIC VIEW EXTRACTION
// =============================================================================

/**
 * Extract the public view from a bundle.
 *
 * Returns only public spans with their public events.
 * This is a convenience function that returns the pre-computed public view
 * from the bundle. Use this for sharing trace information externally.
 *
 * Note: The public view is computed when the bundle is created, so this
 * function simply returns the existing public view. If you need to
 * re-compute the public view (e.g., with different redaction rules),
 * you should create a new bundle.
 *
 * @param bundle - The trace bundle
 * @returns The TraceBundlePublicView (safe to share externally)
 *
 * @example
 * ```typescript
 * const bundle = await createBundle(run);
 * const publicView = extractPublicView(bundle);
 *
 * // Safe to share externally
 * await sendToAuditSystem(publicView);
 * ```
 */
export function extractPublicView(bundle: TraceBundle): TraceBundlePublicView {
  return bundle.publicView;
}

// =============================================================================
// BUNDLE VERIFICATION
// =============================================================================

/**
 * Verify a bundle's integrity.
 *
 * Performs comprehensive validation including:
 * - Event hashes are correct (recomputed and compared)
 * - Span hashes are correct (recomputed and compared)
 * - Rolling hash matches (recomputed from events)
 * - Root hash matches (recomputed from rolling hash + span hashes)
 * - Merkle root matches (recomputed from span tree)
 * - Event sequence is monotonic (0, 1, 2, ...)
 * - Span sequence is monotonic (0, 1, 2, ...)
 *
 * @param bundle - The trace bundle to verify
 * @returns Promise resolving to comprehensive verification result
 *
 * @example
 * ```typescript
 * const result = await verifyBundle(bundle);
 *
 * if (!result.valid) {
 *   console.error("Bundle verification failed!");
 *   console.error("Errors:", result.errors);
 *   console.error("Warnings:", result.warnings);
 *   console.error("Checks:", result.checks);
 * }
 * ```
 */
export async function verifyBundle(
  bundle: TraceBundle
): Promise<TraceVerificationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const checks = {
    rollingHashValid: false,
    rootHashValid: false,
    merkleRootValid: false,
    spanHashesValid: false,
    eventHashesValid: false,
    sequenceValid: false,
  };

  const run = bundle.privateRun;

  // ---------------------------------------------------------------------------
  // Verify Event Sequence
  // ---------------------------------------------------------------------------

  const sequenceErrors = verifySequences(run);
  if (sequenceErrors.length === 0) {
    checks.sequenceValid = true;
  } else {
    errors.push(...sequenceErrors);
  }

  // ---------------------------------------------------------------------------
  // Verify Event Hashes
  // ---------------------------------------------------------------------------

  const eventHashErrors = await verifyEventHashes(run.events);
  if (eventHashErrors.length === 0) {
    checks.eventHashesValid = true;
  } else {
    errors.push(...eventHashErrors);
  }

  // ---------------------------------------------------------------------------
  // Verify Span Hashes
  // ---------------------------------------------------------------------------

  const spanHashErrors = await verifySpanHashes(run.spans, run.events);
  if (spanHashErrors.length === 0) {
    checks.spanHashesValid = true;
  } else {
    errors.push(...spanHashErrors);
  }

  // ---------------------------------------------------------------------------
  // Verify Rolling Hash
  // ---------------------------------------------------------------------------

  try {
    const computedRollingHash = await computeRollingHash(run.events);
    if (computedRollingHash === run.rollingHash) {
      checks.rollingHashValid = true;
    } else {
      errors.push(
        `Rolling hash mismatch: expected ${run.rollingHash}, computed ${computedRollingHash}`
      );
    }
  } catch (error) {
    errors.push(
      `Failed to compute rolling hash: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // ---------------------------------------------------------------------------
  // Verify Root Hash
  // ---------------------------------------------------------------------------

  try {
    const computedRootHash = await computeRootHash(run.rollingHash, run.spans);
    if (computedRootHash === bundle.rootHash) {
      checks.rootHashValid = true;
    } else {
      errors.push(
        `Root hash mismatch: expected ${bundle.rootHash}, computed ${computedRootHash}`
      );
    }
  } catch (error) {
    errors.push(
      `Failed to compute root hash: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // ---------------------------------------------------------------------------
  // Verify Merkle Root
  // ---------------------------------------------------------------------------

  try {
    const merkleTree = await buildSpanMerkleTree(run.spans, run.events);
    if (merkleTree.rootHash === bundle.merkleRoot) {
      checks.merkleRootValid = true;
    } else {
      errors.push(
        `Merkle root mismatch: expected ${bundle.merkleRoot}, computed ${merkleTree.rootHash}`
      );
    }
  } catch (error) {
    errors.push(
      `Failed to compute Merkle root: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // ---------------------------------------------------------------------------
  // Additional Warnings
  // ---------------------------------------------------------------------------

  // Warn if there are no public spans
  if (bundle.publicView.publicSpans.length === 0 && run.spans.length > 0) {
    warnings.push(
      "No public spans in bundle. The public view will be empty. " +
        "Consider marking some spans as public for transparency."
    );
  }

  // Warn if run status doesn't match public view status
  if (bundle.publicView.status !== run.status) {
    warnings.push(
      `Status mismatch between publicView (${bundle.publicView.status}) and privateRun (${run.status})`
    );
  }

  // Determine overall validity
  const valid =
    checks.rollingHashValid &&
    checks.rootHashValid &&
    checks.merkleRootValid &&
    checks.spanHashesValid &&
    checks.eventHashesValid &&
    checks.sequenceValid;

  return {
    valid,
    errors,
    warnings,
    checks,
  };
}

/**
 * Verify event and span sequences are monotonic.
 *
 * @param run - The trace run to verify
 * @returns Array of error messages (empty if valid)
 */
function verifySequences(run: TraceRun): string[] {
  const errors: string[] = [];

  // Sort events by seq to check monotonicity
  const sortedEvents = [...run.events].sort((a, b) => a.seq - b.seq);

  // Check event sequence is monotonic starting from 0
  for (let i = 0; i < sortedEvents.length; i++) {
    const event = sortedEvents[i];
    // Handle noUncheckedIndexedAccess - event is guaranteed to exist after loop bounds check
    if (event !== undefined && event.seq !== i) {
      errors.push(
        `Event sequence gap: expected seq ${i}, found ${event.seq} for event ${event.id}`
      );
    }
  }

  // Sort spans by spanSeq to check monotonicity
  const sortedSpans = [...run.spans].sort((a, b) => a.spanSeq - b.spanSeq);

  // Check span sequence is monotonic starting from 0
  for (let i = 0; i < sortedSpans.length; i++) {
    const span = sortedSpans[i];
    // Handle noUncheckedIndexedAccess - span is guaranteed to exist after loop bounds check
    if (span !== undefined && span.spanSeq !== i) {
      errors.push(
        `Span sequence gap: expected spanSeq ${i}, found ${span.spanSeq} for span ${span.id}`
      );
    }
  }

  return errors;
}

/**
 * Verify all event hashes are correct.
 *
 * @param events - Array of events to verify
 * @returns Promise resolving to array of error messages (empty if valid)
 */
async function verifyEventHashes(events: TraceEvent[]): Promise<string[]> {
  const errors: string[] = [];

  for (const event of events) {
    if (!event.hash) {
      errors.push(`Event ${event.id} (seq ${event.seq}) is missing hash`);
      continue;
    }

    try {
      const computedHash = await computeEventHash(event);
      if (computedHash !== event.hash) {
        errors.push(
          `Event hash mismatch for ${event.id} (seq ${event.seq}): ` +
            `expected ${event.hash}, computed ${computedHash}`
        );
      }
    } catch (error) {
      errors.push(
        `Failed to compute hash for event ${event.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return errors;
}

/**
 * Verify all span hashes are correct.
 *
 * @param spans - Array of spans to verify
 * @param events - Array of all events (for looking up event hashes)
 * @returns Promise resolving to array of error messages (empty if valid)
 */
async function verifySpanHashes(
  spans: TraceSpan[],
  events: TraceEvent[]
): Promise<string[]> {
  const errors: string[] = [];

  // Create event lookup map
  const eventMap = new Map<string, TraceEvent>();
  for (const event of events) {
    eventMap.set(event.id, event);
  }

  for (const span of spans) {
    if (!span.hash) {
      errors.push(
        `Span ${span.id} (spanSeq ${span.spanSeq}) is missing hash`
      );
      continue;
    }

    try {
      // Get event hashes for this span in seq order
      const spanEvents = span.eventIds
        .map((id) => eventMap.get(id))
        .filter((e): e is TraceEvent => e !== undefined)
        .sort((a, b) => a.seq - b.seq);

      const eventHashes = spanEvents.map((e) => e.hash ?? "");

      const computedHash = await computeSpanHash(span, eventHashes);
      if (computedHash !== span.hash) {
        errors.push(
          `Span hash mismatch for ${span.id} (spanSeq ${span.spanSeq}): ` +
            `expected ${span.hash}, computed ${computedHash}`
        );
      }
    } catch (error) {
      errors.push(
        `Failed to compute hash for span ${span.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return errors;
}

// =============================================================================
// BUNDLE SIGNING
// =============================================================================

/**
 * Sign a bundle using the provided signature provider.
 *
 * Signs the canonical JSON of { rootHash, merkleRoot, manifestHash? }.
 * The signature and signer ID are added to the bundle.
 *
 * @param bundle - The bundle to sign
 * @param provider - The signature provider implementation
 * @returns Promise resolving to the signed bundle (new object, original unchanged)
 *
 * @example
 * ```typescript
 * const provider: SignatureProvider = {
 *   signerId: "agent-123",
 *   sign: async (data) => await myHSM.sign(data),
 *   verify: async (data, sig, signerId) => await myHSM.verify(data, sig),
 * };
 *
 * const signedBundle = await signBundle(bundle, provider);
 * console.log(signedBundle.signature); // Hex-encoded signature
 * console.log(signedBundle.signerId);  // "agent-123"
 * ```
 */
export async function signBundle(
  bundle: TraceBundle,
  provider: SignatureProvider
): Promise<TraceBundle> {
  // Create the signing payload
  const signingPayload: {
    rootHash: string;
    merkleRoot: string;
    manifestHash?: string;
  } = {
    rootHash: bundle.rootHash,
    merkleRoot: bundle.merkleRoot,
  };

  // Include manifestHash if present
  if (bundle.manifestHash) {
    signingPayload.manifestHash = bundle.manifestHash;
  }

  // Canonicalize to get deterministic bytes
  const canonicalPayload = canonicalize(signingPayload);
  const payloadBytes = new TextEncoder().encode(canonicalPayload);

  // Sign using the provider
  const signatureBytes = await provider.sign(payloadBytes);
  const signatureHex = bytesToHex(signatureBytes);

  // Return new bundle with signature
  return {
    ...bundle,
    signerId: provider.signerId,
    signature: signatureHex,
  };
}

/**
 * Verify a bundle's signature.
 *
 * Recomputes the signing payload and verifies the signature using
 * the provider. The bundle must have both signature and signerId set.
 *
 * @param bundle - The signed bundle to verify
 * @param provider - The signature provider implementation
 * @returns Promise resolving to true if signature is valid, false otherwise
 *
 * @example
 * ```typescript
 * const isValid = await verifyBundleSignature(signedBundle, provider);
 * if (!isValid) {
 *   throw new Error("Bundle signature verification failed!");
 * }
 * ```
 */
export async function verifyBundleSignature(
  bundle: TraceBundle,
  provider: SignatureProvider
): Promise<boolean> {
  // Check required fields
  if (!bundle.signature) {
    return false;
  }

  if (!bundle.signerId) {
    return false;
  }

  try {
    // Recreate the signing payload
    const signingPayload: {
      rootHash: string;
      merkleRoot: string;
      manifestHash?: string;
    } = {
      rootHash: bundle.rootHash,
      merkleRoot: bundle.merkleRoot,
    };

    // Include manifestHash if it was present when signed
    if (bundle.manifestHash) {
      signingPayload.manifestHash = bundle.manifestHash;
    }

    // Canonicalize to get deterministic bytes
    const canonicalPayload = canonicalize(signingPayload);
    const payloadBytes = new TextEncoder().encode(canonicalPayload);

    // Convert signature from hex
    const signatureBytes = hexToBytes(bundle.signature);

    // Verify using the provider
    return await provider.verify(payloadBytes, signatureBytes, bundle.signerId);
  } catch (error) {
    // Verification failed due to error (invalid format, etc.)
    return false;
  }
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Get all events belonging to a specific span.
 *
 * @param span - The span to get events for
 * @param events - Array of all events
 * @returns Array of events belonging to the span, sorted by seq
 */
export function getSpanEvents(
  span: TraceSpan,
  events: TraceEvent[]
): TraceEvent[] {
  const eventMap = new Map<string, TraceEvent>();
  for (const event of events) {
    eventMap.set(event.id, event);
  }

  return span.eventIds
    .map((id) => eventMap.get(id))
    .filter((e): e is TraceEvent => e !== undefined)
    .sort((a, b) => a.seq - b.seq);
}

/**
 * Count events by visibility level in a run.
 *
 * @param run - The trace run to analyze
 * @returns Object with counts for each visibility level
 */
export function countEventsByVisibility(run: TraceRun): Record<Visibility, number> {
  const counts: Record<Visibility, number> = {
    public: 0,
    private: 0,
    secret: 0,
  };

  for (const event of run.events) {
    counts[event.visibility]++;
  }

  return counts;
}

/**
 * Count spans by visibility level in a run.
 *
 * @param run - The trace run to analyze
 * @returns Object with counts for each visibility level
 */
export function countSpansByVisibility(run: TraceRun): Record<Visibility, number> {
  const counts: Record<Visibility, number> = {
    public: 0,
    private: 0,
    secret: 0,
  };

  for (const span of run.spans) {
    counts[span.visibility]++;
  }

  return counts;
}
