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
  canonicalEquals,
  bytesToHex,
  hexToBytes,
} from "@fluxpointstudios/orynq-sdk-core/utils";

import type {
  TraceBundle,
  TraceBundlePublicView,
  TraceRun,
  TraceSpan,
  TraceEvent,
  TraceVerificationResult,
  SignatureProvider,
  Visibility,
} from "./types.js";

import {
  verifyEventHashes,
  computeRollingHash,
  computeRootHash,
} from "./rolling-hash.js";

import { computeModelManifestHash } from "./model-manifest.js";

import { buildSpanMerkleTree, computeSpanHash, uncommittedSpanKeys } from "./merkle.js";

import { createPublicView } from "./public-view.js";

import { isRecord, repeated } from "./guards.js";

import { compareCodeUnits } from "./order.js";

import {
  verifyGovernanceAttestations,
  type VerifyGovernanceOptions,
} from "./governance.js";

// =============================================================================
// VERIFY OPTIONS
// =============================================================================

/**
 * Outcome shape returned by an injected tool-receipt verifier (provided by
 * `@fluxpointstudios/orynq-sdk-tool-receipts` — passed in to avoid a circular
 * dependency on that package from process-trace).
 */
export interface ToolReceiptVerifyOutcome {
  valid: boolean;
  errors: string[];
}

/** Options for {@link verifyBundle}. */
export interface VerifyBundleOptions {
  /**
   * Verify `governance-attestation` events. `true` uses the built-in
   * sr25519/ed25519 verifiers; pass {@link VerifyGovernanceOptions} to register
   * a pluggable verifier (e.g. eip712). Any unverified attestation fails the
   * bundle.
   */
  governance?: boolean | VerifyGovernanceOptions;
  /**
   * Verify `tool-receipt` events with an injected verifier from
   * `@fluxpointstudios/orynq-sdk-tool-receipts`. Any failed receipt fails the
   * bundle.
   */
  toolReceipts?: (
    bundle: TraceBundle
  ) => Promise<ToolReceiptVerifyOutcome> | ToolReceiptVerifyOutcome;
}

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
 * - Span hashes are correct (recomputed and compared); spans carry only the
 *   fields their hashes commit to
 * - Rolling hash matches (recomputed from events)
 * - Root hash matches (recomputed from rolling hash + span hashes), and so
 *   does the private run's own `rootHash`
 * - Merkle root matches (recomputed from span tree)
 * - Event sequence is monotonic (0, 1, 2, ...)
 * - Span sequence is monotonic (0, 1, 2, ...)
 * - No two events or spans share an ID, and no event ID is listed twice in
 *   the spans' `eventIds`
 * - The public view equals the private run's public projection, apart from
 *   the model-manifest fields, which are bound separately: redacted span
 *   hashes may come in any order, and a run without an end time may show no
 *   end time or one no earlier than its start
 * - Top-level `modelManifestHash` and `modelManifest`, when present, equal the
 *   committed run's
 *
 * The root does not commit to run-level fields such as the run ID, agent ID,
 * status or timestamps (see `computeRootHash`), so a valid result shows only
 * that the public view repeats them.
 *
 * Malformed input yields `valid: false` with errors; it does not throw.
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
  bundle: TraceBundle,
  options: VerifyBundleOptions = {}
): Promise<TraceVerificationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const checks: TraceVerificationResult["checks"] = {
    rollingHashValid: false,
    rootHashValid: false,
    merkleRootValid: false,
    spanHashesValid: false,
    eventHashesValid: false,
    sequenceValid: false,
    publicViewValid: false,
  };

  const shapeErrors = bundleShapeErrors(bundle);
  if (shapeErrors.length > 0) {
    return { valid: false, errors: shapeErrors, warnings, checks };
  }

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
  // Verify the public view is the projection of the committed private run
  // ---------------------------------------------------------------------------

  const expectedView = createPublicView(run, bundle.merkleRoot);
  const publicViewErrors = publicViewMismatches(bundle.publicView, expectedView, run);
  checks.publicViewValid = publicViewErrors.length === 0;
  errors.push(...publicViewErrors);

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
    // Recompute the root binding the recorded model-manifest commitment (#59),
    // so a manifest swapped after commitment fails here.
    const computedRootHash = await computeRootHash(
      run.rollingHash,
      run.spans,
      run.modelManifestHash
    );
    if (computedRootHash !== bundle.rootHash) {
      errors.push(
        `Root hash mismatch: expected ${bundle.rootHash}, computed ${computedRootHash}`
      );
    } else if (run.rootHash !== bundle.rootHash) {
      errors.push(
        `privateRun rootHash ${String(run.rootHash)} does not match the bundle rootHash ${bundle.rootHash}`
      );
    } else {
      checks.rootHashValid = true;
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
  // Verify Model-Manifest Pin Binding (issue #59)
  // ---------------------------------------------------------------------------
  // When a manifest is pinned it MUST (a) hash to the recorded commitment and
  // (b) be bound into the committed root. (b) is enforced by folding
  // modelManifestHash into computeRootHash above — a swapped hash breaks
  // rootHashValid. Here we additionally recompute the commitment from the
  // manifest itself so that swapping the manifest (while leaving the recorded
  // hash) is caught, and reject a manifest present but not bound into the root.

  const hasManifest = run.modelManifest !== undefined;
  const hasManifestHash =
    run.modelManifestHash !== undefined && run.modelManifestHash.length > 0;

  if (!hasManifest && !hasManifestHash) {
    // No manifest pinned — nothing to bind (warn-only path lives in finalizeTrace).
    checks.modelManifestValid = true;
  } else {
    let manifestBindingValid = true;

    if (hasManifest && !hasManifestHash) {
      manifestBindingValid = false;
      errors.push(
        "Model manifest present but modelManifestHash (its commitment) is missing"
      );
    } else if (!hasManifest && hasManifestHash) {
      manifestBindingValid = false;
      errors.push(
        "modelManifestHash present but the model manifest itself is missing"
      );
    } else if (run.modelManifest !== undefined) {
      try {
        const recomputed = await computeModelManifestHash(run.modelManifest);
        if (recomputed !== run.modelManifestHash) {
          manifestBindingValid = false;
          errors.push(
            `Model manifest hash mismatch: recorded ${run.modelManifestHash}, computed ${recomputed}`
          );
        }
      } catch (error) {
        manifestBindingValid = false;
        errors.push(
          `Failed to recompute model manifest hash: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // The manifest must actually be bound into the committed root. If the root
    // recompute (with the manifest folded in) matched, rootHashValid is true;
    // a manifest that is NOT bound produces a root mismatch above.
    if (manifestBindingValid && !checks.rootHashValid) {
      manifestBindingValid = false;
      errors.push(
        "Model manifest is not bound into the committed root hash"
      );
    }

    checks.modelManifestValid = manifestBindingValid;
  }

  // ---------------------------------------------------------------------------
  // Verify PublicView Model-Manifest (issue #59)
  // ---------------------------------------------------------------------------
  // publicView.{modelManifest,modelManifestHash} is the shared artifact an
  // EXTERNAL verifier reads. It must (a) equal the bound privateRun commitment
  // and (b) recompute consistently from the publicView manifest itself — else an
  // attacker can leave privateRun honest but fabricate the public fields.

  const pvManifest = bundle.publicView.modelManifest;
  const pvManifestHash = bundle.publicView.modelManifestHash;

  if (pvManifestHash !== undefined && pvManifestHash !== run.modelManifestHash) {
    checks.modelManifestValid = false;
    errors.push(
      `PublicView modelManifestHash (${pvManifestHash}) does not match the bound commitment (${run.modelManifestHash})`
    );
  }
  if (pvManifest !== undefined && run.modelManifest === undefined) {
    checks.modelManifestValid = false;
    errors.push("PublicView carries a model manifest but the bound run has none");
  }
  if (pvManifest !== undefined) {
    try {
      const recomputed = await computeModelManifestHash(pvManifest);
      const expected = pvManifestHash ?? run.modelManifestHash;
      if (expected !== undefined && recomputed !== expected) {
        checks.modelManifestValid = false;
        errors.push(
          `PublicView model manifest hash mismatch: recorded ${expected}, computed ${recomputed}`
        );
      }
    } catch (error) {
      checks.modelManifestValid = false;
      errors.push(
        `Failed to recompute publicView model manifest hash: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // finalizeTrace() also repeats the pin at the top level, where anchoring
  // tools read it. Nothing hashes those copies, so they must equal the
  // committed run's.
  if (bundle.modelManifestHash !== undefined && bundle.modelManifestHash !== run.modelManifestHash) {
    checks.modelManifestValid = false;
    errors.push(
      `Top-level modelManifestHash (${String(bundle.modelManifestHash)}) does not match the committed run's (${String(run.modelManifestHash)})`
    );
  }
  if (bundle.modelManifest !== undefined && !canonicalEquals(bundle.modelManifest, run.modelManifest, KEEP_NULLS)) {
    checks.modelManifestValid = false;
    errors.push("Top-level modelManifest does not match the committed run's");
  }

  // ---------------------------------------------------------------------------
  // Additional Warnings
  // ---------------------------------------------------------------------------

  // Warn if there are no public spans
  if (expectedView.publicSpans.length === 0 && run.spans.length > 0) {
    warnings.push(
      "No public spans in bundle. The public view will be empty. " +
        "Consider marking some spans as public for transparency."
    );
  }

  // ---------------------------------------------------------------------------
  // Verify Governance Attestations (issue #58, opt-in)
  // ---------------------------------------------------------------------------

  if (options.governance) {
    try {
      const govOpts: VerifyGovernanceOptions =
        options.governance === true ? {} : options.governance;
      const summaries = await verifyGovernanceAttestations(bundle, govOpts);
      const failed = summaries.filter((s) => !s.verified);
      checks.governanceValid = failed.length === 0;
      for (const f of failed) {
        errors.push(
          `Governance attestation failed (${f.scheme}, role ${f.role}, attestor ${f.attestor})` +
            (f.error ? `: ${f.error}` : "")
        );
      }
    } catch (error) {
      checks.governanceValid = false;
      errors.push(
        `Failed to verify governance attestations: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Verify Tool-Call Receipts (issue #60, opt-in, injected verifier)
  // ---------------------------------------------------------------------------

  if (options.toolReceipts) {
    try {
      const outcome = await options.toolReceipts(bundle);
      checks.toolReceiptsValid = outcome.valid;
      if (!outcome.valid) {
        errors.push(...outcome.errors);
      }
    } catch (error) {
      checks.toolReceiptsValid = false;
      errors.push(
        `Failed to verify tool receipts: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Determine overall validity. Optional checks only fail the bundle when
  // explicitly run and false (undefined === "not checked").
  const valid =
    checks.rollingHashValid &&
    checks.rootHashValid &&
    checks.merkleRootValid &&
    checks.spanHashesValid &&
    checks.eventHashesValid &&
    checks.sequenceValid &&
    checks.publicViewValid === true &&
    checks.modelManifestValid !== false &&
    checks.governanceValid !== false &&
    checks.toolReceiptsValid !== false;

  return {
    valid,
    errors,
    warnings,
    checks,
  };
}

/** The structure verifyBundle relies on, so malformed input fails as errors rather than exceptions. */
function bundleShapeErrors(bundle: unknown): string[] {
  if (!isRecord(bundle)) {
    return ["Bundle must be an object"];
  }
  const errors: string[] = [];
  const run = bundle.privateRun;
  if (!isRecord(run)) {
    errors.push("Bundle privateRun must be an object");
  } else {
    if (!Array.isArray(run.events) || !run.events.every(isRecord)) {
      errors.push("privateRun.events must be an array of objects");
    }
    if (
      !Array.isArray(run.spans) ||
      !run.spans.every((span) => isRecord(span) && typeof span.id === "string" && Array.isArray(span.eventIds))
    ) {
      errors.push("privateRun.spans must be an array of objects with a string id and an eventIds array");
    }
    if (run.modelManifestHash !== undefined && typeof run.modelManifestHash !== "string") {
      errors.push("privateRun.modelManifestHash must be a string");
    }
  }
  if (!isRecord(bundle.publicView)) {
    errors.push("Bundle publicView must be an object");
  }
  return errors;
}

/** Fields whose binding the model-manifest checks verify instead of the projection. */
const PUBLIC_VIEW_MANIFEST_FIELDS: ReadonlySet<string> = new Set(["modelManifest", "modelManifestHash"]);

/** Comparison keeps null-valued keys: hashing ignores them, so only comparison stops a copy adding or dropping one. */
const KEEP_NULLS = { removeNulls: false } as const;

/**
 * Compare the bundle's public view with `expected`, the projection of its
 * private run `run`, field by field.
 */
function publicViewMismatches(
  actual: TraceBundlePublicView,
  expected: TraceBundlePublicView,
  run: TraceRun
): string[] {
  const shown = actual as unknown as Record<string, unknown>;
  const derived = expected as unknown as Record<string, unknown>;
  return [...new Set([...Object.keys(shown), ...Object.keys(derived)])]
    .filter((field) => !PUBLIC_VIEW_MANIFEST_FIELDS.has(field))
    .filter((field) => shown[field] !== undefined || derived[field] !== undefined)
    .filter((field) => !publicFieldMatches(field, shown[field], derived[field], run))
    .map((field) => `PublicView ${field} does not match the committed run`);
}

/**
 * Whether a public-view field holds what the projection derived. Published
 * producers ordered redacted span hashes by the host's collation, so they
 * compare as a multiset. For a run without an end time, published
 * `createBundle()` reported the time it made the bundle, so the public end
 * time may be absent or any time from the run's start.
 */
function publicFieldMatches(field: string, shown: unknown, derived: unknown, run: TraceRun): boolean {
  if (field === "redactedSpanHashes") {
    return sameMultiset(shown, derived);
  }
  if (field === "endedAt" && (run.endedAt === undefined || run.endedAt === null)) {
    return shown === undefined || notBefore(shown, run.startedAt);
  }
  return canonicalEquals(shown, derived, KEEP_NULLS);
}

function sameMultiset(shown: unknown, derived: unknown): boolean {
  if (!Array.isArray(shown) || !Array.isArray(derived) || shown.length !== derived.length) {
    return false;
  }
  try {
    const canonicalSorted = (entries: unknown[]) =>
      entries.map((entry) => canonicalize(entry, KEEP_NULLS)).sort(compareCodeUnits);
    const left = canonicalSorted(shown);
    const right = canonicalSorted(derived);
    return left.every((entry, i) => entry === right[i]);
  } catch {
    // An entry without a canonical form (too deep, or not JSON) matches nothing.
    return false;
  }
}

/** A timestamp no earlier than `start`. */
function notBefore(timestamp: unknown, start: unknown): boolean {
  if (typeof timestamp !== "string" || typeof start !== "string") {
    return false;
  }
  const at = Date.parse(timestamp);
  return Number.isFinite(at) && at >= Date.parse(start);
}

/**
 * Verify event and span sequences are monotonic and that each event and span
 * is identified once: a repeated ID would let one ID name different committed
 * data in a disclosure or a projection.
 *
 * @param run - The trace run to verify
 * @returns Array of error messages (empty if valid)
 */
function verifySequences(run: TraceRun): string[] {
  const errors: string[] = [
    ...repeated(run.spans.map((span) => span.id)).map((id) => `Span ID "${id}" is used by more than one span`),
    ...repeated(run.events.map((event) => event.id)).map((id) => `Event ID "${id}" is used by more than one event`),
    ...repeated(run.spans.flatMap((span) => span.eventIds)).map(
      (id) => `Event ID "${String(id)}" is listed more than once in the spans' eventIds`
    ),
  ];

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
    const uncommitted = uncommittedSpanKeys(span);
    if (uncommitted.length > 0) {
      errors.push(
        `Span ${span.id} carries fields its hash does not commit to: ${uncommitted.join(", ")}`
      );
    }

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
