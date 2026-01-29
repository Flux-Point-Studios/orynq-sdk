/**
 * @fileoverview Type definitions for the process-trace package.
 * All types are consolidated in this single file to avoid confusion.
 *
 * Key concepts:
 * - TraceEvent: Individual events within a trace (commands, outputs, decisions, etc.)
 * - TraceSpan: Logical groupings of events with parent-child relationships
 * - TraceRun: Complete execution trace containing all events and spans
 * - TraceBundle: Finalized trace with cryptographic commitments
 * - Visibility: Controls what data is exposed in public views
 */

// =============================================================================
// VISIBILITY & COMMON TYPES
// =============================================================================

/**
 * Visibility level for trace events and spans.
 * - "public": Safe to disclose without revealing sensitive information
 * - "private": Contains potentially sensitive data, disclosed only with consent
 * - "secret": Never disclosed, hashes only for verification
 */
export type Visibility = "public" | "private" | "secret";

/**
 * Status of a trace run or span.
 */
export type TraceStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * Schema version for trace format.
 */
export type SchemaVersion = "1.0";

// =============================================================================
// TRACE EVENTS
// =============================================================================

/**
 * Base interface shared by all trace events.
 * @property kind - Discriminator for event type
 * @property id - UUID v4 unique identifier
 * @property seq - Monotonic sequence number (THE ordering authority)
 * @property timestamp - ISO 8601 timestamp (informational, not for ordering)
 * @property visibility - Controls disclosure level
 * @property hash - SHA-256 of canonical(event without hash field)
 */
export interface BaseTraceEvent {
  kind: string;
  id: string;
  seq: number;
  timestamp: string;
  visibility: Visibility;
  hash?: string;
}

/**
 * Command execution event.
 * Default visibility: "public" (args may be redacted by policy)
 */
export interface CommandEvent extends BaseTraceEvent {
  kind: "command";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  exitCode?: number;
}

/**
 * Output/result event from command or operation.
 * Default visibility: "private" (may contain secrets, PII, API responses)
 */
export interface OutputEvent extends BaseTraceEvent {
  kind: "output";
  stream: "stdout" | "stderr" | "combined";
  content: string;
  truncated?: boolean;
  originalSize?: number;
}

/**
 * Decision point event where agent made a choice.
 * Default visibility: "private" (leaks reasoning/strategy)
 */
export interface DecisionEvent extends BaseTraceEvent {
  kind: "decision";
  decision: string;
  reasoning?: string;
  alternatives?: string[];
  confidence?: number;
}

/**
 * Observation/state assertion event.
 * Default visibility: "public" (generally safe state assertions)
 */
export interface ObservationEvent extends BaseTraceEvent {
  kind: "observation";
  observation: string;
  category?: string;
  data?: Record<string, unknown>;
}

/**
 * Error event capturing failures.
 * Default visibility: "private" (stack traces, internal details)
 */
export interface ErrorTraceEvent extends BaseTraceEvent {
  kind: "error";
  error: string;
  code?: string;
  stack?: string;
  recoverable?: boolean;
}

/**
 * Custom event for extension.
 * Default visibility: "private" (unknown content)
 */
export interface CustomEvent extends BaseTraceEvent {
  kind: "custom";
  eventType: string;
  data: Record<string, unknown>;
}

/**
 * Discriminated union of all trace event types.
 */
export type TraceEvent =
  | CommandEvent
  | OutputEvent
  | DecisionEvent
  | ObservationEvent
  | ErrorTraceEvent
  | CustomEvent;

/**
 * Event kind string literals for type guards.
 */
export type TraceEventKind = TraceEvent["kind"];

/**
 * Default visibility for each event kind.
 */
export const DEFAULT_EVENT_VISIBILITY: Record<TraceEventKind, Visibility> = {
  command: "public",
  output: "private",
  decision: "private",
  observation: "public",
  error: "private",
  custom: "private",
};

// =============================================================================
// TRACE SPANS
// =============================================================================

/**
 * A span represents a logical unit of work containing related events.
 * Spans can be nested via parentSpanId to form a tree structure.
 *
 * @property id - UUID v4 unique identifier
 * @property spanSeq - Monotonic sequence (THE ordering authority for spans)
 * @property parentSpanId - Optional parent span for nesting
 * @property name - Human-readable span name
 * @property status - Current span status
 * @property visibility - Span-level visibility (can override events)
 * @property eventIds - References to events (NOT embedded events)
 * @property childSpanIds - References to child spans
 * @property hash - H("poi-trace:span:v1|" + canon(spanHeader) + "|" + eventHashes)
 */
export interface TraceSpan {
  id: string;
  spanSeq: number;
  parentSpanId?: string;
  name: string;
  status: TraceStatus;
  visibility: Visibility;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  eventIds: string[];
  childSpanIds: string[];
  metadata?: Record<string, unknown>;
  hash?: string;
}

// =============================================================================
// TRACE RUN
// =============================================================================

/**
 * Complete trace run containing all events and spans.
 *
 * @property id - UUID v4 unique identifier for this run
 * @property schemaVersion - Always "1.0" for this version
 * @property agentId - Identifier of the agent that produced this trace
 * @property status - Current run status
 * @property events - All events (flat array, ordered by seq)
 * @property spans - All spans (flat array, parent-child via IDs)
 * @property rollingHash - Updated after each event
 * @property rootHash - Final: H(rollingHash + spanHashes)
 * @property nextSeq - Internal: next seq to assign
 */
export interface TraceRun {
  id: string;
  schemaVersion: SchemaVersion;
  agentId: string;
  status: TraceStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  events: TraceEvent[];
  spans: TraceSpan[];
  metadata?: Record<string, unknown>;
  rollingHash: string;
  rootHash?: string;
  nextSeq: number;
  nextSpanSeq: number;
}

// =============================================================================
// ROLLING HASH
// =============================================================================

/**
 * State for incremental rolling hash computation.
 */
export interface RollingHashState {
  currentHash: string;
  itemCount: number;
}

// =============================================================================
// MERKLE TREE
// =============================================================================

/**
 * Span-level Merkle tree for selective disclosure.
 * Leaves are span hashes, ordered by spanSeq.
 *
 * @property rootHash - Merkle root (THE disclosure commitment)
 * @property leafCount - Number of leaf nodes (spans)
 * @property depth - Tree depth
 * @property leafHashes - For local proof generation (optional storage)
 */
export interface TraceMerkleTree {
  rootHash: string;
  leafCount: number;
  depth: number;
  leafHashes: string[];
}

/**
 * Merkle proof for a single leaf (span).
 *
 * @property leafHash - Hash of the leaf being proven
 * @property leafIndex - 0-indexed position in leaf array
 * @property siblings - Path from leaf to root with position hints
 * @property rootHash - Expected Merkle root
 */
export interface MerkleProof {
  leafHash: string;
  leafIndex: number;
  siblings: Array<{ hash: string; position: "left" | "right" }>;
  rootHash: string;
}

// =============================================================================
// BUNDLE & PUBLIC VIEW
// =============================================================================

/**
 * Annotated span with full data for public disclosure.
 */
export interface AnnotatedSpan extends TraceSpan {
  events: TraceEvent[];
}

/**
 * Public view of a trace bundle - safe to share externally.
 * Contains only public spans with their events, plus hashes of redacted spans.
 *
 * @property redactionPolicyId - Identifies which redaction rules were applied
 * @property redactionRulesHash - H(canonical(redactionRules)) for reproducibility
 */
export interface TraceBundlePublicView {
  runId: string;
  agentId: string;
  schemaVersion: SchemaVersion;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: string;
  totalEvents: number;
  totalSpans: number;
  rootHash: string;
  merkleRoot: string;
  publicSpans: AnnotatedSpan[];
  redactedSpanHashes: Array<{ spanId: string; hash: string }>;
  redactionPolicyId?: string;
  redactionRulesHash?: string;
}

/**
 * Complete trace bundle with cryptographic commitments.
 * Contains both public view and private data.
 *
 * @property formatVersion - Bundle format version
 * @property publicView - Safe to share externally
 * @property privateRun - Full trace data
 * @property merkleRoot - Span-level Merkle root
 * @property rootHash - Rolling hash final (execution sequence)
 * @property manifestHash - Set after manifest creation
 * @property signerId - Optional signer identifier
 * @property signature - Optional signature over bundle
 */
export interface TraceBundle {
  formatVersion: SchemaVersion;
  publicView: TraceBundlePublicView;
  privateRun: TraceRun;
  merkleRoot: string;
  rootHash: string;
  manifestHash?: string;
  signerId?: string;
  signature?: string;
}

// =============================================================================
// SIGNATURE PROVIDER (OPTIONAL)
// =============================================================================

/**
 * Interface for signing providers.
 * Consumers provide implementation (e.g., HSM, KMS, local key).
 */
export interface SignatureProvider {
  signerId: string;
  sign(data: Uint8Array): Promise<Uint8Array>;
  verify(
    data: Uint8Array,
    signature: Uint8Array,
    signerId: string
  ): Promise<boolean>;
}

// =============================================================================
// MANIFEST & CHUNKS (OFF-CHAIN STORAGE)
// =============================================================================

/**
 * Information about a stored chunk.
 *
 * @property index - Chunk sequence number
 * @property hash - SHA-256 of chunk content (BEFORE compression)
 * @property size - Bytes (uncompressed)
 * @property compressedSize - Bytes (if compressed)
 * @property compression - Hint for consumers (process-trace doesn't compress)
 * @property spanIds - Which spans are in this chunk
 */
export interface ChunkInfo {
  index: number;
  hash: string;
  size: number;
  compressedSize?: number;
  compression?: "gzip" | "none";
  spanIds: string[];
}

/**
 * Chunk data ready for storage.
 */
export interface Chunk {
  info: ChunkInfo;
  content: string;
}

/**
 * Manifest describing stored trace data.
 * This file is public-safe and serves as the entry point for retrieval.
 *
 * Storage layout:
 * ```
 * <storageUri>/
 *   manifest.json              # TraceManifest (public-safe)
 *   chunks/
 *     <hash1>.json.gz          # Compressed chunk
 *     <hash2>.json.gz
 * ```
 */
export interface TraceManifest {
  formatVersion: SchemaVersion;
  runId: string;
  agentId: string;
  rootHash: string;
  merkleRoot: string;
  manifestHash?: string;
  totalEvents: number;
  totalSpans: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  chunks: ChunkInfo[];
  publicView: TraceBundlePublicView;
}

// =============================================================================
// SELECTIVE DISCLOSURE
// =============================================================================

/**
 * Disclosure mode determines what data is revealed.
 * - "membership": Merkle proof only (proves span exists, hash matches)
 * - "full": Merkle proof + span data + event data
 */
export type DisclosureMode = "membership" | "full";

/**
 * Result of selective disclosure operation.
 */
export interface DisclosureResult {
  mode: DisclosureMode;
  rootHash: string;
  merkleRoot: string;
  disclosedSpans: Array<{
    spanId: string;
    proof: MerkleProof;
    span?: TraceSpan;
    events?: TraceEvent[];
  }>;
}

// =============================================================================
// VERIFICATION RESULTS
// =============================================================================

/**
 * Result of bundle verification.
 */
export interface TraceVerificationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  checks: {
    rollingHashValid: boolean;
    rootHashValid: boolean;
    merkleRootValid: boolean;
    spanHashesValid: boolean;
    eventHashesValid: boolean;
    sequenceValid: boolean;
  };
}

/**
 * Result of manifest verification.
 */
export interface ManifestVerificationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  checks: {
    manifestHashValid: boolean;
    chunkHashesValid: boolean;
    rootHashMatches: boolean;
    merkleRootMatches: boolean;
  };
}

// =============================================================================
// BUILDER OPTIONS
// =============================================================================

/**
 * Options for creating a new trace.
 */
export interface CreateTraceOptions {
  agentId: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Options for creating a new span.
 */
export interface CreateSpanOptions {
  name: string;
  parentSpanId?: string;
  visibility?: Visibility;
  metadata?: Record<string, unknown>;
}

/**
 * Options for creating a manifest with chunks.
 */
export interface CreateManifestOptions {
  chunkSize?: number;
  compression?: "gzip" | "none";
}

// =============================================================================
// DOMAIN SEPARATION PREFIXES
// =============================================================================

/**
 * Domain separation prefixes for hashing.
 * These prevent cross-context hash collisions.
 */
export const HASH_DOMAIN_PREFIXES = {
  event: "poi-trace:event:v1|",
  roll: "poi-trace:roll:v1|",
  span: "poi-trace:span:v1|",
  leaf: "poi-trace:leaf:v1|",
  node: "poi-trace:node:v1|",
  manifest: "poi-trace:manifest:v1|",
  root: "poi-trace:root:v1|",
} as const;

/**
 * Type for domain prefix keys.
 */
export type HashDomain = keyof typeof HASH_DOMAIN_PREFIXES;
