/**
 * @fileoverview Manifest creation and verification for off-chain trace storage.
 *
 * Location: packages/process-trace/src/manifest.ts
 *
 * This module provides functionality for creating manifests and chunks from trace bundles,
 * enabling efficient off-chain storage of trace data. The manifest serves as a public-safe
 * entry point for trace retrieval, while chunks contain the actual span and event data.
 *
 * Key features:
 * - Creates manifests with cryptographic commitments for integrity verification
 * - Chunks trace data by size for efficient storage and retrieval
 * - Provides verification functions to ensure manifest and chunk integrity
 * - Supports reconstruction of trace bundles from manifests and chunks
 *
 * Storage Layout (for consumers):
 * ```
 * <storageUri>/
 *   manifest.json              # TraceManifest (public-safe)
 *   chunks/
 *     <hash1>.json             # Or .json.gz if compressed by consumer
 *     <hash2>.json
 * ```
 *
 * Used by:
 * - Storage adapters for persisting trace data
 * - Retrieval workflows for reconstructing traces
 * - Verification workflows for validating stored traces
 *
 * @example
 * ```typescript
 * // Create manifest for storage
 * const { manifest, chunks } = await createManifest(bundle, { chunkSize: 500_000 });
 *
 * // Store chunks (consumer handles actual storage)
 * for (const chunk of chunks) {
 *   const path = getChunkPath(chunk.info);
 *   await storage.write(path, chunk.content);
 * }
 *
 * // Store manifest
 * await storage.write("manifest.json", JSON.stringify(manifest));
 *
 * // Later: verify
 * const result = await verifyManifest(manifest, loadedChunks);
 * if (!result.valid) {
 *   console.error("Manifest verification failed:", result.errors);
 * }
 * ```
 */

import { sha256StringHex, canonicalize } from "@fluxpointstudios/orynq-sdk-core/utils";
import type {
  TraceManifest,
  TraceBundle,
  ChunkInfo,
  Chunk,
  CreateManifestOptions,
  ManifestVerificationResult,
  TraceSpan,
  TraceEvent,
  TraceRun,
} from "./types.js";
import { HASH_DOMAIN_PREFIXES } from "./types.js";

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Default chunk size in bytes (1MB of uncompressed JSON).
 * This is the target size for chunking; actual chunks may be slightly larger
 * to avoid splitting spans across chunks.
 */
const DEFAULT_CHUNK_SIZE = 1_000_000;

// =============================================================================
// CHUNK CONTENT TYPE
// =============================================================================

/**
 * Content format for a chunk.
 * Contains spans and their associated events.
 */
interface ChunkContent {
  spans: TraceSpan[];
  events: TraceEvent[];
}

// =============================================================================
// MANIFEST CREATION
// =============================================================================

/**
 * Create a manifest and chunks from a trace bundle.
 *
 * Chunks contain private span/event data for off-chain storage. Each chunk
 * includes a subset of spans and their associated events, grouped to fit
 * within the target chunk size.
 *
 * The manifest contains:
 * - Metadata from the bundle (runId, agentId, timestamps, etc.)
 * - Cryptographic commitments (rootHash, merkleRoot)
 * - Chunk information (index, hash, size, spanIds)
 * - The complete publicView for quick access
 *
 * @param bundle - Finalized trace bundle to create manifest from
 * @param options - Optional chunking options
 * @param options.chunkSize - Target chunk size in bytes (default: 1MB)
 * @param options.compression - Compression hint for consumers (default: "none")
 * @returns Promise resolving to manifest and array of chunks
 *
 * @example
 * ```typescript
 * const { manifest, chunks } = await createManifest(bundle, {
 *   chunkSize: 500_000, // 500KB chunks
 * });
 *
 * console.log(`Created ${chunks.length} chunks`);
 * console.log(`Manifest hash: ${manifest.manifestHash}`);
 * ```
 */
export async function createManifest(
  bundle: TraceBundle,
  options?: CreateManifestOptions
): Promise<{ manifest: TraceManifest; chunks: Chunk[] }> {
  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const compression = options?.compression ?? "none";

  const run = bundle.privateRun;

  // Build event lookup map for efficient access
  const eventMap = new Map<string, TraceEvent>();
  for (const event of run.events) {
    eventMap.set(event.id, event);
  }

  // Group spans into chunks based on size
  const chunks: Chunk[] = [];
  let currentChunkSpans: TraceSpan[] = [];
  let currentChunkEvents: TraceEvent[] = [];
  let currentChunkSize = 0;
  let chunkIndex = 0;

  // Sort spans by spanSeq for deterministic ordering
  const sortedSpans = [...run.spans].sort((a, b) => a.spanSeq - b.spanSeq);

  for (const span of sortedSpans) {
    // Get events for this span
    const spanEvents = span.eventIds
      .map((id) => eventMap.get(id))
      .filter((e): e is TraceEvent => e !== undefined)
      .sort((a, b) => a.seq - b.seq);

    // Estimate size of this span and its events
    const spanJson = JSON.stringify(span);
    const eventsJson = spanEvents.map((e) => JSON.stringify(e)).join("");
    const spanSize = spanJson.length + eventsJson.length;

    // If adding this span would exceed chunk size and we have content, finalize current chunk
    if (currentChunkSize + spanSize > chunkSize && currentChunkSpans.length > 0) {
      const chunk = await createChunk(
        chunkIndex,
        currentChunkSpans,
        currentChunkEvents,
        compression
      );
      chunks.push(chunk);
      chunkIndex++;

      // Reset for next chunk
      currentChunkSpans = [];
      currentChunkEvents = [];
      currentChunkSize = 0;
    }

    // Add span and its events to current chunk
    currentChunkSpans.push(span);
    currentChunkEvents.push(...spanEvents);
    currentChunkSize += spanSize;
  }

  // Create final chunk if there's remaining content
  if (currentChunkSpans.length > 0) {
    const chunk = await createChunk(
      chunkIndex,
      currentChunkSpans,
      currentChunkEvents,
      compression
    );
    chunks.push(chunk);
  }

  // Build manifest without hash first
  const manifestWithoutHash: Omit<TraceManifest, "manifestHash"> = {
    formatVersion: bundle.formatVersion,
    runId: run.id,
    agentId: run.agentId,
    rootHash: bundle.rootHash,
    merkleRoot: bundle.merkleRoot,
    totalEvents: run.events.length,
    totalSpans: run.spans.length,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? run.startedAt,
    durationMs: run.durationMs ?? 0,
    chunks: chunks.map((c) => c.info),
    publicView: bundle.publicView,
  };

  // Compute manifest hash
  const manifestHash = await computeManifestHash(manifestWithoutHash);

  // Build complete manifest
  const manifest: TraceManifest = {
    ...manifestWithoutHash,
    manifestHash,
  };

  return { manifest, chunks };
}

/**
 * Internal helper to create a chunk from spans and events.
 *
 * @param index - Chunk sequence number
 * @param spans - Spans to include in this chunk
 * @param events - Events to include in this chunk
 * @param compression - Compression hint
 * @returns Promise resolving to the complete Chunk
 */
async function createChunk(
  index: number,
  spans: TraceSpan[],
  events: TraceEvent[],
  compression: "gzip" | "none"
): Promise<Chunk> {
  // Build chunk content
  const content: ChunkContent = {
    spans,
    events,
  };

  // Serialize to JSON (deterministic ordering via canonicalize)
  const contentJson = canonicalize(content);

  // Compute hash of content BEFORE any compression
  const hash = await sha256StringHex(contentJson);

  // Get span IDs for this chunk
  const spanIds = spans.map((s) => s.id);

  // Build chunk info
  const info: ChunkInfo = {
    index,
    hash,
    size: contentJson.length,
    compression,
    spanIds,
  };

  return {
    info,
    content: contentJson,
  };
}

// =============================================================================
// MANIFEST HASH COMPUTATION
// =============================================================================

/**
 * Compute the manifest hash.
 *
 * The manifest hash is computed as:
 * `H("poi-trace:manifest:v1|" + canonical(manifestWithoutHash))`
 *
 * This hash serves as a cryptographic commitment to the manifest contents,
 * enabling integrity verification of stored manifests.
 *
 * @param manifest - Manifest object without the manifestHash field
 * @returns Promise resolving to the manifest hash as a hex string
 *
 * @example
 * ```typescript
 * const manifestHash = await computeManifestHash(manifestWithoutHash);
 * const completeManifest = { ...manifestWithoutHash, manifestHash };
 * ```
 */
export async function computeManifestHash(
  manifest: Omit<TraceManifest, "manifestHash">
): Promise<string> {
  // Canonicalize the manifest for deterministic serialization
  const canonical = canonicalize(manifest);

  // Apply domain separation and hash
  const prefixedData = HASH_DOMAIN_PREFIXES.manifest + canonical;

  return sha256StringHex(prefixedData);
}

// =============================================================================
// MANIFEST VERIFICATION
// =============================================================================

/**
 * Verify a manifest against its chunks.
 *
 * Performs comprehensive validation including:
 * - Manifest hash matches recomputed hash
 * - Each chunk hash matches its content
 * - All chunk indices are present
 * - Root hash in manifest is present
 * - Merkle root in manifest is present
 *
 * @param manifest - The manifest to verify
 * @param chunks - The chunks referenced by the manifest
 * @returns Promise resolving to verification result with errors and check statuses
 *
 * @example
 * ```typescript
 * const result = await verifyManifest(manifest, chunks);
 * if (!result.valid) {
 *   console.error("Verification failed:", result.errors);
 * } else {
 *   console.log("Manifest and chunks are valid");
 * }
 * ```
 */
export async function verifyManifest(
  manifest: TraceManifest,
  chunks: Chunk[]
): Promise<ManifestVerificationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const checks = {
    manifestHashValid: false,
    chunkHashesValid: false,
    rootHashMatches: false,
    merkleRootMatches: false,
  };

  // ---------------------------------------------------------------------------
  // Verify Manifest Hash
  // ---------------------------------------------------------------------------

  try {
    // Create manifest without hash for recomputation
    const manifestWithoutHash: Omit<TraceManifest, "manifestHash"> = {
      formatVersion: manifest.formatVersion,
      runId: manifest.runId,
      agentId: manifest.agentId,
      rootHash: manifest.rootHash,
      merkleRoot: manifest.merkleRoot,
      totalEvents: manifest.totalEvents,
      totalSpans: manifest.totalSpans,
      startedAt: manifest.startedAt,
      endedAt: manifest.endedAt,
      durationMs: manifest.durationMs,
      chunks: manifest.chunks,
      publicView: manifest.publicView,
    };

    const computedHash = await computeManifestHash(manifestWithoutHash);

    if (manifest.manifestHash === computedHash) {
      checks.manifestHashValid = true;
    } else {
      errors.push(
        `Manifest hash mismatch: expected ${manifest.manifestHash}, computed ${computedHash}`
      );
    }
  } catch (error) {
    errors.push(
      `Failed to compute manifest hash: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // ---------------------------------------------------------------------------
  // Verify Chunk Hashes
  // ---------------------------------------------------------------------------

  // Build chunk lookup by index
  const chunkByIndex = new Map<number, Chunk>();
  for (const chunk of chunks) {
    chunkByIndex.set(chunk.info.index, chunk);
  }

  let allChunkHashesValid = true;

  for (const chunkInfo of manifest.chunks) {
    const chunk = chunkByIndex.get(chunkInfo.index);

    if (!chunk) {
      errors.push(`Missing chunk at index ${chunkInfo.index}`);
      allChunkHashesValid = false;
      continue;
    }

    try {
      // Compute hash of chunk content
      const computedHash = await sha256StringHex(chunk.content);

      if (computedHash !== chunkInfo.hash) {
        errors.push(
          `Chunk ${chunkInfo.index} hash mismatch: expected ${chunkInfo.hash}, computed ${computedHash}`
        );
        allChunkHashesValid = false;
      }

      // Verify size matches
      if (chunk.content.length !== chunkInfo.size) {
        errors.push(
          `Chunk ${chunkInfo.index} size mismatch: expected ${chunkInfo.size}, got ${chunk.content.length}`
        );
        allChunkHashesValid = false;
      }
    } catch (error) {
      errors.push(
        `Failed to verify chunk ${chunkInfo.index}: ${error instanceof Error ? error.message : String(error)}`
      );
      allChunkHashesValid = false;
    }
  }

  // Check for extra chunks not in manifest
  for (const chunk of chunks) {
    const inManifest = manifest.chunks.some((c) => c.index === chunk.info.index);
    if (!inManifest) {
      warnings.push(`Extra chunk at index ${chunk.info.index} not referenced in manifest`);
    }
  }

  checks.chunkHashesValid = allChunkHashesValid;

  // ---------------------------------------------------------------------------
  // Verify Root Hash Presence
  // ---------------------------------------------------------------------------

  if (manifest.rootHash && manifest.rootHash.length > 0) {
    checks.rootHashMatches = true;
  } else {
    errors.push("Manifest is missing rootHash");
  }

  // ---------------------------------------------------------------------------
  // Verify Merkle Root Presence
  // ---------------------------------------------------------------------------

  if (manifest.merkleRoot && manifest.merkleRoot.length > 0) {
    checks.merkleRootMatches = true;
  } else {
    errors.push("Manifest is missing merkleRoot");
  }

  // ---------------------------------------------------------------------------
  // Additional Warnings
  // ---------------------------------------------------------------------------

  if (manifest.chunks.length === 0) {
    warnings.push("Manifest has no chunks - trace data may be empty");
  }

  if (manifest.totalSpans === 0 && manifest.chunks.length > 0) {
    warnings.push("Manifest reports 0 spans but has chunks");
  }

  // Determine overall validity
  const valid =
    checks.manifestHashValid &&
    checks.chunkHashesValid &&
    checks.rootHashMatches &&
    checks.merkleRootMatches;

  return {
    valid,
    errors,
    warnings,
    checks,
  };
}

// =============================================================================
// BUNDLE RECONSTRUCTION
// =============================================================================

/**
 * Reconstruct a trace bundle from manifest and chunks.
 *
 * This is the inverse operation of createManifest. It parses all chunk
 * contents, merges spans and events, and reconstructs the complete
 * TraceBundle.
 *
 * Note: The reconstructed bundle will use the publicView from the manifest
 * and construct a privateRun from the chunk data.
 *
 * @param manifest - The manifest describing the trace
 * @param chunks - All chunks referenced by the manifest
 * @returns Promise resolving to the reconstructed TraceBundle
 * @throws Error if required chunks are missing or corrupted
 *
 * @example
 * ```typescript
 * // Load manifest and chunks from storage
 * const manifest = JSON.parse(await storage.read("manifest.json"));
 * const chunks = await loadChunks(manifest.chunks);
 *
 * // Reconstruct the bundle
 * const bundle = await reconstructBundleFromManifest(manifest, chunks);
 *
 * // Now you can access the full trace data
 * console.log(`Reconstructed ${bundle.privateRun.events.length} events`);
 * ```
 */
export async function reconstructBundleFromManifest(
  manifest: TraceManifest,
  chunks: Chunk[]
): Promise<TraceBundle> {
  // Build chunk lookup by index
  const chunkByIndex = new Map<number, Chunk>();
  for (const chunk of chunks) {
    chunkByIndex.set(chunk.info.index, chunk);
  }

  // Parse all chunks and merge spans/events
  const allSpans: TraceSpan[] = [];
  const allEvents: TraceEvent[] = [];

  // Process chunks in order
  const sortedChunkInfos = [...manifest.chunks].sort((a, b) => a.index - b.index);

  for (const chunkInfo of sortedChunkInfos) {
    const chunk = chunkByIndex.get(chunkInfo.index);

    if (!chunk) {
      throw new Error(`Missing chunk at index ${chunkInfo.index}`);
    }

    // Parse chunk content
    const { spans, events } = parseChunkContent(chunk.content);

    allSpans.push(...spans);
    allEvents.push(...events);
  }

  // Sort spans by spanSeq and events by seq for proper ordering
  allSpans.sort((a, b) => a.spanSeq - b.spanSeq);
  allEvents.sort((a, b) => a.seq - b.seq);

  // Compute the next sequence numbers
  const nextSeq = allEvents.length > 0
    ? Math.max(...allEvents.map(e => e.seq)) + 1
    : 0;
  const nextSpanSeq = allSpans.length > 0
    ? Math.max(...allSpans.map(s => s.spanSeq)) + 1
    : 0;

  // Reconstruct the trace run
  // Note: We need to derive rollingHash from events if possible, but that would
  // require recomputing. For now, we store a placeholder and note that full
  // verification would need the original rollingHash.
  const privateRun: TraceRun = {
    id: manifest.runId,
    schemaVersion: manifest.formatVersion,
    agentId: manifest.agentId,
    status: manifest.publicView.status as "running" | "completed" | "failed" | "cancelled",
    startedAt: manifest.startedAt,
    endedAt: manifest.endedAt,
    durationMs: manifest.durationMs,
    events: allEvents,
    spans: allSpans,
    rollingHash: "", // Would need to be recomputed for full verification
    rootHash: manifest.rootHash,
    nextSeq,
    nextSpanSeq,
  };

  // Build the complete bundle
  const bundle: TraceBundle = {
    formatVersion: manifest.formatVersion,
    publicView: manifest.publicView,
    privateRun,
    merkleRoot: manifest.merkleRoot,
    rootHash: manifest.rootHash,
  };

  // Add manifestHash if present
  if (manifest.manifestHash !== undefined) {
    bundle.manifestHash = manifest.manifestHash;
  }

  return bundle;
}

// =============================================================================
// CHUNK PATH UTILITIES
// =============================================================================

/**
 * Get the storage path for a chunk.
 *
 * Returns the relative path where the chunk should be stored.
 * The consumer is responsible for adding any compression suffix
 * (e.g., ".gz" if compressed) and handling the actual storage.
 *
 * @param chunkInfo - Information about the chunk
 * @returns The relative storage path for the chunk
 *
 * @example
 * ```typescript
 * const path = getChunkPath(chunk.info);
 * // Returns: "chunks/abc123...def.json"
 *
 * // Consumer adds compression suffix if needed
 * const storagePath = chunk.info.compression === "gzip"
 *   ? path + ".gz"
 *   : path;
 * ```
 */
export function getChunkPath(chunkInfo: ChunkInfo): string {
  return `chunks/${chunkInfo.hash}.json`;
}

// =============================================================================
// CHUNK CONTENT PARSING
// =============================================================================

/**
 * Parse chunk content from JSON string.
 *
 * Parses the serialized chunk content and returns the spans and events
 * contained within. This function handles the internal chunk format.
 *
 * @param content - JSON string of chunk content
 * @returns Object containing spans and events arrays
 * @throws Error if content cannot be parsed or is malformed
 *
 * @example
 * ```typescript
 * const { spans, events } = parseChunkContent(chunk.content);
 * console.log(`Chunk contains ${spans.length} spans and ${events.length} events`);
 * ```
 */
export function parseChunkContent(content: string): { spans: TraceSpan[]; events: TraceEvent[] } {
  try {
    const parsed = JSON.parse(content) as unknown;

    // Validate parsed content has expected structure
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Chunk content must be an object");
    }

    const obj = parsed as Record<string, unknown>;

    if (!Array.isArray(obj.spans)) {
      throw new Error("Chunk content must have a 'spans' array");
    }

    if (!Array.isArray(obj.events)) {
      throw new Error("Chunk content must have an 'events' array");
    }

    // Type cast with validation
    const spans = obj.spans as TraceSpan[];
    const events = obj.events as TraceEvent[];

    // Basic validation of spans
    for (const span of spans) {
      if (typeof span.id !== "string" || typeof span.spanSeq !== "number") {
        throw new Error("Invalid span structure in chunk content");
      }
    }

    // Basic validation of events
    for (const event of events) {
      if (typeof event.id !== "string" || typeof event.seq !== "number") {
        throw new Error("Invalid event structure in chunk content");
      }
    }

    return { spans, events };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in chunk content: ${error.message}`);
    }
    throw error;
  }
}
