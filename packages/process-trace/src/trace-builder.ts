/**
 * @fileoverview Main API for building traces - creating runs, adding spans, events, and finalizing.
 *
 * Location: packages/process-trace/src/trace-builder.ts
 *
 * This module provides the primary entry points for constructing trace runs. It handles:
 * - Creating new trace runs with proper initialization
 * - Adding spans (logical groupings of related events)
 * - Adding events with automatic sequencing, timestamping, and hashing
 * - Closing spans and computing span hashes
 * - Finalizing traces with Merkle tree construction and root hash computation
 * - Generating public views for external sharing
 *
 * The trace builder maintains internal state (rolling hash, sequence counters) and
 * ensures cryptographic integrity at each step. Events are ordered by monotonic
 * sequence numbers (seq), not timestamps, to guarantee deterministic ordering.
 *
 * Used by:
 * - Agent implementations to record execution traces
 * - Integration tests for trace verification
 * - Audit workflows for compliance reporting
 *
 * @example
 * ```typescript
 * // Create a new trace
 * const run = await createTrace({ agentId: "agent-1" });
 *
 * // Add a span for a logical unit of work
 * const span = addSpan(run, { name: "build-project" });
 *
 * // Add events to the span
 * await addEvent(run, span.id, { kind: "command", command: "npm install" });
 * await addEvent(run, span.id, { kind: "output", stream: "stdout", content: "done" });
 *
 * // Close the span and finalize
 * await closeSpan(run, span.id);
 * const bundle = await finalizeTrace(run);
 * ```
 */

import type {
  TraceRun,
  TraceSpan,
  TraceEvent,
  TraceBundle,
  TraceBundlePublicView,
  CreateTraceOptions,
  CreateSpanOptions,
  Visibility,
  TraceStatus,
  TraceEventKind,
  AnnotatedSpan,
} from "./types.js";
import { DEFAULT_EVENT_VISIBILITY } from "./types.js";
import {
  computeEventHash,
  initRollingHash,
  updateRollingHash,
  computeRootHash,
} from "./rolling-hash.js";
import { buildSpanMerkleTree, computeSpanHash } from "./merkle.js";

// =============================================================================
// TRACE CREATION
// =============================================================================

/**
 * Create a new trace run.
 *
 * Initializes a fresh trace with:
 * - Unique UUID for the run ID
 * - Schema version "1.0"
 * - Status "running"
 * - Genesis rolling hash state
 * - Empty events and spans arrays
 * - Sequence counters at 0
 *
 * @param opts - Options for creating the trace
 * @param opts.agentId - Identifier of the agent producing this trace
 * @param opts.description - Optional human-readable description
 * @param opts.metadata - Optional key-value metadata
 * @returns Promise resolving to the initialized TraceRun
 *
 * @example
 * ```typescript
 * const run = await createTrace({
 *   agentId: "claude-agent-v1",
 *   description: "Build and test the project",
 *   metadata: { environment: "production" },
 * });
 * ```
 */
export async function createTrace(opts: CreateTraceOptions): Promise<TraceRun> {
  // Validate required fields
  if (!opts.agentId || typeof opts.agentId !== "string") {
    throw new Error("agentId is required and must be a non-empty string");
  }

  // Generate unique run ID using crypto.randomUUID (Node 18+)
  const runId = crypto.randomUUID();

  // Initialize rolling hash state
  const hashState = await initRollingHash();

  // Build the trace run object
  const run: TraceRun = {
    id: runId,
    schemaVersion: "1.0",
    agentId: opts.agentId,
    status: "running",
    startedAt: new Date().toISOString(),
    events: [],
    spans: [],
    rollingHash: hashState.currentHash,
    nextSeq: 0,
    nextSpanSeq: 0,
  };

  // Add optional metadata
  if (opts.metadata !== undefined) {
    run.metadata = { ...opts.metadata };
  }

  // Add description to metadata if provided
  if (opts.description !== undefined) {
    run.metadata = {
      ...run.metadata,
      description: opts.description,
    };
  }

  return run;
}

// =============================================================================
// SPAN MANAGEMENT
// =============================================================================

/**
 * Add a new span to a trace run.
 *
 * Creates a span with:
 * - Unique UUID for span ID
 * - Assigned spanSeq from run.nextSpanSeq
 * - Status "running"
 * - Empty eventIds and childSpanIds arrays
 *
 * If a parentSpanId is provided, the span is added to the parent's childSpanIds.
 *
 * @param run - The trace run to add the span to (mutated in place)
 * @param opts - Options for creating the span
 * @param opts.name - Human-readable name for the span
 * @param opts.parentSpanId - Optional parent span ID for nesting
 * @param opts.visibility - Span visibility level (defaults to "private")
 * @param opts.metadata - Optional key-value metadata
 * @returns The created TraceSpan
 * @throws Error if the run is finalized or parent span is not found
 *
 * @example
 * ```typescript
 * // Create a top-level span
 * const buildSpan = addSpan(run, { name: "build" });
 *
 * // Create a nested span
 * const installSpan = addSpan(run, {
 *   name: "npm-install",
 *   parentSpanId: buildSpan.id,
 *   visibility: "public",
 * });
 * ```
 */
export function addSpan(run: TraceRun, opts: CreateSpanOptions): TraceSpan {
  // Validate run is not finalized
  if (isFinalized(run)) {
    throw new Error("Cannot add span to a finalized trace run");
  }

  // Validate required fields
  if (!opts.name || typeof opts.name !== "string") {
    throw new Error("name is required and must be a non-empty string");
  }

  // Validate parent span exists if specified
  if (opts.parentSpanId !== undefined) {
    const parentSpan = getSpan(run, opts.parentSpanId);
    if (!parentSpan) {
      throw new Error(`Parent span not found: ${opts.parentSpanId}`);
    }
    if (parentSpan.status !== "running") {
      throw new Error(`Parent span is not running: ${opts.parentSpanId}`);
    }
  }

  // Generate unique span ID
  const spanId = crypto.randomUUID();

  // Assign spanSeq and increment counter
  const spanSeq = run.nextSpanSeq++;

  // Determine visibility (default to "private" if not specified)
  const visibility: Visibility = opts.visibility ?? "private";

  // Create the span
  const span: TraceSpan = {
    id: spanId,
    spanSeq,
    name: opts.name,
    status: "running",
    visibility,
    startedAt: new Date().toISOString(),
    eventIds: [],
    childSpanIds: [],
  };

  // Add optional fields
  if (opts.parentSpanId !== undefined) {
    span.parentSpanId = opts.parentSpanId;
  }

  if (opts.metadata !== undefined) {
    span.metadata = { ...opts.metadata };
  }

  // Add to run's spans array
  run.spans.push(span);

  // If there's a parent span, add this span to its childSpanIds
  if (opts.parentSpanId !== undefined) {
    const parentSpan = getSpan(run, opts.parentSpanId);
    if (parentSpan) {
      parentSpan.childSpanIds.push(spanId);
    }
  }

  return span;
}

/**
 * Get a span by ID from a run.
 *
 * @param run - The trace run to search
 * @param spanId - The span ID to find
 * @returns The span if found, undefined otherwise
 *
 * @example
 * ```typescript
 * const span = getSpan(run, "some-span-id");
 * if (span) {
 *   console.log(`Found span: ${span.name}`);
 * }
 * ```
 */
export function getSpan(run: TraceRun, spanId: string): TraceSpan | undefined {
  return run.spans.find((s) => s.id === spanId);
}

/**
 * Get events for a span.
 *
 * Returns all events belonging to the specified span, sorted by sequence number.
 *
 * @param run - The trace run containing the events
 * @param spanId - The span ID to get events for
 * @returns Array of TraceEvents for the span, sorted by seq
 *
 * @example
 * ```typescript
 * const events = getSpanEvents(run, span.id);
 * for (const event of events) {
 *   console.log(`Event ${event.seq}: ${event.kind}`);
 * }
 * ```
 */
export function getSpanEvents(run: TraceRun, spanId: string): TraceEvent[] {
  const span = getSpan(run, spanId);
  if (!span) {
    return [];
  }

  // Get events by their IDs and sort by seq
  const eventMap = new Map(run.events.map((e) => [e.id, e]));
  const spanEvents = span.eventIds
    .map((id) => eventMap.get(id))
    .filter((e): e is TraceEvent => e !== undefined);

  return spanEvents.sort((a, b) => a.seq - b.seq);
}

// =============================================================================
// EVENT MANAGEMENT
// =============================================================================

/**
 * Type helper to extract the event type by kind.
 * Used for type-safe event creation without runtime fields.
 */
type EventWithoutRuntimeFields<K extends TraceEventKind> = Omit<
  Extract<TraceEvent, { kind: K }>,
  "id" | "seq" | "timestamp" | "hash"
>;

/**
 * Add an event to a span within a trace run.
 *
 * Automatically assigns:
 * - Unique UUID for event ID
 * - Monotonic sequence number from run.nextSeq
 * - ISO 8601 timestamp
 * - Default visibility based on event kind (if not specified)
 * - Computed event hash
 *
 * Also updates the run's rolling hash to maintain cryptographic chain.
 *
 * @param run - The trace run (mutated in place)
 * @param spanId - ID of the span to add event to
 * @param event - Event data without runtime fields (id, seq, timestamp, hash)
 * @returns Promise resolving to the complete TraceEvent
 * @throws Error if run is finalized, span not found, or span is closed
 *
 * @example
 * ```typescript
 * // Add a command event
 * const cmdEvent = await addEvent(run, span.id, {
 *   kind: "command",
 *   command: "npm install",
 *   args: ["--save-dev", "typescript"],
 *   visibility: "public",
 * });
 *
 * // Add an output event (will use default "private" visibility)
 * const outEvent = await addEvent(run, span.id, {
 *   kind: "output",
 *   stream: "stdout",
 *   content: "added 120 packages",
 * });
 * ```
 */
export async function addEvent<K extends TraceEventKind>(
  run: TraceRun,
  spanId: string,
  event: EventWithoutRuntimeFields<K>
): Promise<TraceEvent> {
  // Validate run is not finalized
  if (isFinalized(run)) {
    throw new Error("Cannot add event to a finalized trace run");
  }

  // Find the span
  const span = getSpan(run, spanId);
  if (!span) {
    throw new Error(`Span not found: ${spanId}`);
  }

  // Validate span is still running
  if (span.status !== "running") {
    throw new Error(`Cannot add event to closed span: ${spanId} (status: ${span.status})`);
  }

  // Validate event has a kind
  if (!event.kind || typeof event.kind !== "string") {
    throw new Error("Event kind is required and must be a non-empty string");
  }

  // Generate event ID
  const eventId = crypto.randomUUID();

  // Assign sequence number and increment counter
  const seq = run.nextSeq++;

  // Get current timestamp
  const timestamp = new Date().toISOString();

  // Determine visibility: use provided value or default for the event kind
  const visibility: Visibility =
    event.visibility ?? DEFAULT_EVENT_VISIBILITY[event.kind as TraceEventKind] ?? "private";

  // Build the complete event (without hash initially)
  // We use 'as unknown as TraceEvent' because TypeScript cannot infer
  // that adding runtime fields to EventWithoutRuntimeFields<K> produces a valid TraceEvent.
  // The caller ensures the correct event shape via the generic constraint.
  const completeEvent = {
    ...event,
    id: eventId,
    seq,
    timestamp,
    visibility,
  } as unknown as TraceEvent;

  // Compute event hash
  const eventHash = await computeEventHash(completeEvent);
  completeEvent.hash = eventHash;

  // Update rolling hash
  const currentState = {
    currentHash: run.rollingHash,
    itemCount: run.events.length,
  };
  const newState = await updateRollingHash(currentState, eventHash);
  run.rollingHash = newState.currentHash;

  // Add event ID to span's eventIds
  span.eventIds.push(eventId);

  // Add event to run's events array
  run.events.push(completeEvent);

  return completeEvent;
}

// =============================================================================
// SPAN CLOSING
// =============================================================================

/**
 * Close a span, marking it as completed/failed/cancelled.
 *
 * Sets the span's:
 * - status (default "completed")
 * - endedAt timestamp
 * - durationMs (calculated from startedAt to endedAt)
 * - hash (computed from span header + event hashes)
 *
 * @param run - The trace run containing the span (mutated in place)
 * @param spanId - ID of the span to close
 * @param status - Final status (default "completed")
 * @throws Error if span not found or already closed
 *
 * @example
 * ```typescript
 * // Close with default "completed" status
 * await closeSpan(run, span.id);
 *
 * // Close with explicit status
 * await closeSpan(run, span.id, "failed");
 * ```
 */
export async function closeSpan(
  run: TraceRun,
  spanId: string,
  status: TraceStatus = "completed"
): Promise<void> {
  // Find the span
  const span = getSpan(run, spanId);
  if (!span) {
    throw new Error(`Span not found: ${spanId}`);
  }

  // Validate span is still running
  if (span.status !== "running") {
    throw new Error(`Span already closed: ${spanId} (status: ${span.status})`);
  }

  // Set final status
  span.status = status;

  // Set end timestamp
  const endedAt = new Date().toISOString();
  span.endedAt = endedAt;

  // Calculate duration
  const startTime = new Date(span.startedAt).getTime();
  const endTime = new Date(endedAt).getTime();
  span.durationMs = endTime - startTime;

  // Get event hashes for this span in seq order
  const spanEvents = getSpanEvents(run, spanId);
  const eventHashes = spanEvents.map((e) => e.hash ?? "");

  // Compute span hash
  span.hash = await computeSpanHash(span, eventHashes);
}

// =============================================================================
// TRACE FINALIZATION
// =============================================================================

/**
 * Check if a run is finalized.
 *
 * A run is considered finalized when it has a rootHash set.
 *
 * @param run - The trace run to check
 * @returns true if the run is finalized
 *
 * @example
 * ```typescript
 * if (!isFinalized(run)) {
 *   // Can still add spans and events
 *   await addEvent(run, span.id, { kind: "command", command: "ls" });
 * }
 * ```
 */
export function isFinalized(run: TraceRun): boolean {
  return run.rootHash !== undefined;
}

/**
 * Finalize a trace run, computing all final hashes and creating a bundle.
 *
 * Finalization performs:
 * 1. Closes any open spans (with status "completed")
 * 2. Sets run status to "completed"
 * 3. Sets run endedAt and durationMs
 * 4. Builds Merkle tree from spans
 * 5. Computes root hash from rolling hash + span hashes
 * 6. Creates public view (only public spans with their events)
 * 7. Returns complete TraceBundle
 *
 * After finalization, no more spans or events can be added.
 *
 * @param run - The trace run to finalize (mutated in place)
 * @returns Promise resolving to the complete TraceBundle
 * @throws Error if the run is already finalized
 *
 * @example
 * ```typescript
 * // Finalize and get the bundle
 * const bundle = await finalizeTrace(run);
 *
 * // Access the cryptographic commitments
 * console.log(`Root hash: ${bundle.rootHash}`);
 * console.log(`Merkle root: ${bundle.merkleRoot}`);
 *
 * // Access the public view for sharing
 * console.log(`Public spans: ${bundle.publicView.publicSpans.length}`);
 * ```
 */
export async function finalizeTrace(run: TraceRun): Promise<TraceBundle> {
  // Validate run is not already finalized
  if (isFinalized(run)) {
    throw new Error("Trace run is already finalized");
  }

  // Close any open spans
  for (const span of run.spans) {
    if (span.status === "running") {
      await closeSpan(run, span.id, "completed");
    }
  }

  // Set run status to completed
  run.status = "completed";

  // Set end timestamp and duration
  const endedAt = new Date().toISOString();
  run.endedAt = endedAt;
  const startTime = new Date(run.startedAt).getTime();
  const endTime = new Date(endedAt).getTime();
  run.durationMs = endTime - startTime;

  // Build Merkle tree from spans
  const merkleTree = await buildSpanMerkleTree(run.spans, run.events);

  // Compute root hash from rolling hash + span hashes
  const rootHash = await computeRootHash(run.rollingHash, run.spans);
  run.rootHash = rootHash;

  // Create public view
  const publicView = createPublicView(run, merkleTree.rootHash);

  // Build and return the complete bundle
  const bundle: TraceBundle = {
    formatVersion: "1.0",
    publicView,
    privateRun: run,
    merkleRoot: merkleTree.rootHash,
    rootHash,
  };

  return bundle;
}

// =============================================================================
// PUBLIC VIEW GENERATION
// =============================================================================

/**
 * Create a public view of the trace suitable for external sharing.
 *
 * The public view includes:
 * - Run metadata (id, agentId, timestamps, etc.)
 * - Cryptographic commitments (rootHash, merkleRoot)
 * - Public spans with their events
 * - Hashes of redacted (non-public) spans
 *
 * Private and secret data is excluded, but their hashes are included
 * for verification purposes.
 *
 * @param run - The finalized trace run
 * @param merkleRoot - The Merkle root from the span tree
 * @returns The public view of the trace bundle
 */
function createPublicView(
  run: TraceRun,
  merkleRoot: string
): TraceBundlePublicView {
  // Build event lookup map
  const eventMap = new Map(run.events.map((e) => [e.id, e]));

  // Separate public spans from non-public
  const publicSpans: AnnotatedSpan[] = [];
  const redactedSpanHashes: Array<{ spanId: string; hash: string }> = [];

  for (const span of run.spans) {
    if (span.visibility === "public") {
      // Include public spans with their events
      const spanEvents = span.eventIds
        .map((id) => eventMap.get(id))
        .filter((e): e is TraceEvent => e !== undefined)
        // Only include public events within public spans
        .filter((e) => e.visibility === "public")
        .sort((a, b) => a.seq - b.seq);

      const annotatedSpan: AnnotatedSpan = {
        ...span,
        events: spanEvents,
      };
      publicSpans.push(annotatedSpan);
    } else {
      // Include only the hash for non-public spans
      if (span.hash) {
        redactedSpanHashes.push({
          spanId: span.id,
          hash: span.hash,
        });
      }
    }
  }

  // Sort public spans by spanSeq
  publicSpans.sort((a, b) => a.spanSeq - b.spanSeq);

  // Sort redacted span hashes by spanId for consistency
  redactedSpanHashes.sort((a, b) => a.spanId.localeCompare(b.spanId));

  const publicView: TraceBundlePublicView = {
    runId: run.id,
    agentId: run.agentId,
    schemaVersion: run.schemaVersion,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? run.startedAt, // Fallback for safety
    durationMs: run.durationMs ?? 0,
    status: run.status,
    totalEvents: run.events.length,
    totalSpans: run.spans.length,
    rootHash: run.rootHash ?? "",
    merkleRoot,
    publicSpans,
    redactedSpanHashes,
  };

  return publicView;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Get total event count for a trace run.
 *
 * @param run - The trace run
 * @returns Number of events in the run
 */
export function getEventCount(run: TraceRun): number {
  return run.events.length;
}

/**
 * Get total span count for a trace run.
 *
 * @param run - The trace run
 * @returns Number of spans in the run
 */
export function getSpanCount(run: TraceRun): number {
  return run.spans.length;
}

/**
 * Get all root spans (spans without a parent).
 *
 * @param run - The trace run
 * @returns Array of root-level spans
 */
export function getRootSpans(run: TraceRun): TraceSpan[] {
  return run.spans.filter((s) => s.parentSpanId === undefined);
}

/**
 * Get child spans for a given parent span.
 *
 * @param run - The trace run
 * @param parentSpanId - The parent span ID
 * @returns Array of child spans
 */
export function getChildSpans(run: TraceRun, parentSpanId: string): TraceSpan[] {
  return run.spans.filter((s) => s.parentSpanId === parentSpanId);
}

/**
 * Get an event by ID from a run.
 *
 * @param run - The trace run
 * @param eventId - The event ID to find
 * @returns The event if found, undefined otherwise
 */
export function getEvent(run: TraceRun, eventId: string): TraceEvent | undefined {
  return run.events.find((e) => e.id === eventId);
}

/**
 * Get all events of a specific kind from a run.
 *
 * @param run - The trace run
 * @param kind - The event kind to filter by
 * @returns Array of events matching the kind
 */
export function getEventsByKind<K extends TraceEventKind>(
  run: TraceRun,
  kind: K
): Extract<TraceEvent, { kind: K }>[] {
  return run.events.filter(
    (e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind
  );
}
