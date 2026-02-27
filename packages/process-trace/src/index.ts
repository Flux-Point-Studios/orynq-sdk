/**
 * @summary Main entry point for @fluxpointstudios/orynq-sdk-process-trace package.
 *
 * This package provides cryptographic process tracing for Proof-of-Intent SDK.
 * It enables agents to create tamper-evident execution traces with:
 * - Rolling hash chains for event ordering verification
 * - Span-level Merkle trees for selective disclosure
 * - Public/private visibility controls for privacy-preserving audits
 *
 * Key features:
 * - TraceBuilder API for creating and managing trace runs
 * - Event and span hash computation with domain separation
 * - Bundle creation with cryptographic commitments
 * - Merkle proof generation for selective disclosure
 * - Signature support via pluggable providers
 *
 * Usage:
 * ```typescript
 * import {
 *   createTrace,
 *   addSpan,
 *   addEvent,
 *   closeSpan,
 *   finalizeTrace,
 * } from "@fluxpointstudios/orynq-sdk-process-trace";
 *
 * const run = await createTrace({ agentId: "agent-1" });
 * const span = addSpan(run, { name: "build-project" });
 * await addEvent(run, span.id, { kind: "command", command: "npm install" });
 * await closeSpan(run, span.id);
 * const bundle = await finalizeTrace(run);
 * ```
 */

// ---------------------------------------------------------------------------
// Type Exports
// ---------------------------------------------------------------------------

// Visibility and common types
export type {
  Visibility,
  TraceStatus,
  SchemaVersion,
} from "./types.js";

// Event types
export type {
  BaseTraceEvent,
  CommandEvent,
  OutputEvent,
  DecisionEvent,
  ObservationEvent,
  ErrorTraceEvent,
  CustomEvent,
  TraceEvent,
  TraceEventKind,
} from "./types.js";

export { DEFAULT_EVENT_VISIBILITY } from "./types.js";

// Span types
export type { TraceSpan } from "./types.js";

// Run types
export type {
  TraceRun,
  RollingHashState,
} from "./types.js";

// Merkle tree types
export type {
  TraceMerkleTree,
  MerkleProof,
} from "./types.js";

// Bundle types
export type {
  AnnotatedSpan,
  TraceBundlePublicView,
  TraceBundle,
} from "./types.js";

// Signature types
export type { SignatureProvider } from "./types.js";

// Manifest and chunk types
export type {
  ChunkInfo,
  Chunk,
  TraceManifest,
} from "./types.js";

// Disclosure types
export type {
  DisclosureMode,
  DisclosureResult,
} from "./types.js";

// Disclosure request type (from disclosure module)
export type { DisclosureRequest } from "./disclosure.js";

// Verification types
export type {
  TraceVerificationResult,
  ManifestVerificationResult,
} from "./types.js";

// Builder option types
export type {
  CreateTraceOptions,
  CreateSpanOptions,
  CreateManifestOptions,
} from "./types.js";

// Domain separation constants
export { HASH_DOMAIN_PREFIXES } from "./types.js";
export type { HashDomain } from "./types.js";

// ---------------------------------------------------------------------------
// Trace Builder Exports
// ---------------------------------------------------------------------------

export {
  // Core builder functions
  createTrace,
  addSpan,
  addEvent,
  closeSpan,
  finalizeTrace,

  // Query functions
  getSpan,
  getSpanEvents,
  isFinalized,

  // Utility functions
  getEventCount,
  getSpanCount,
  getRootSpans,
  getChildSpans,
  getEvent,
  getEventsByKind,
} from "./trace-builder.js";

// ---------------------------------------------------------------------------
// Rolling Hash Exports
// ---------------------------------------------------------------------------

export {
  // Event hash computation
  computeEventHash,
  computeEventHashes,

  // Rolling hash state management
  initRollingHash,
  updateRollingHash,

  // Batch computation
  computeRollingHash,

  // Verification
  verifyRollingHash,

  // Root hash
  computeRootHash,

  // Testing utilities
  getGenesisHash,
} from "./rolling-hash.js";

// ---------------------------------------------------------------------------
// Merkle Tree Exports
// ---------------------------------------------------------------------------

export {
  // Span hash computation
  computeSpanHash,

  // Tree building
  buildSpanMerkleTree,

  // Proof generation and verification
  generateMerkleProof,
  verifyMerkleProof,
  verifySpanInclusion,
} from "./merkle.js";

// ---------------------------------------------------------------------------
// Bundle Exports
// ---------------------------------------------------------------------------

export {
  // Visibility helpers
  isPublicSpan,
  isPublicEvent,
  filterPublicEvents,

  // Bundle creation
  createBundle,

  // Public view extraction
  extractPublicView,

  // Bundle verification
  verifyBundle,

  // Bundle signing
  signBundle,
  verifyBundleSignature,

  // Utility functions
  getSpanEvents as getBundleSpanEvents,
  countEventsByVisibility,
  countSpansByVisibility,
} from "./bundle.js";

// ---------------------------------------------------------------------------
// Disclosure Exports
// ---------------------------------------------------------------------------

export {
  // Selective disclosure
  selectiveDisclose,

  // Verification
  verifyDisclosure,
  verifySpanDisclosure,

  // Utility functions
  canDisclose,
  getSpanIndex,
  createDisclosureRequest,
} from "./disclosure.js";

// ---------------------------------------------------------------------------
// Manifest Exports
// ---------------------------------------------------------------------------

export {
  // Manifest creation
  createManifest,

  // Manifest verification
  verifyManifest,

  // Manifest hash computation
  computeManifestHash,

  // Bundle reconstruction
  reconstructBundleFromManifest,

  // Chunk utilities
  getChunkPath,
  parseChunkContent,
} from "./manifest.js";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Package version.
 * Updated automatically during build.
 */
export const VERSION = "0.1.0";
