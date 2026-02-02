/**
 * @fileoverview Rolling hash computation for trace events using domain-separated SHA-256.
 *
 * Location: packages/process-trace/src/rolling-hash.ts
 *
 * This module implements cryptographic rolling hash computation for the process-trace
 * package. Rolling hashes provide tamper-evident sequencing of trace events, ensuring
 * that any modification to the event sequence is detectable.
 *
 * Domain Separation:
 * - Event hashes use prefix "poi-trace:event:v1|" to prevent cross-context collisions
 * - Rolling hashes use prefix "poi-trace:roll:v1|" for chain linking
 * - Root hashes use prefix "poi-trace:root:v1|" for final commitment
 *
 * The rolling hash forms a hash chain: each hash incorporates the previous hash,
 * creating an ordered, tamper-evident sequence. This is similar to blockchain
 * block linking but at the event level.
 *
 * Used by:
 * - TraceBuilder: Incrementally updates rolling hash as events are added
 * - TraceBundle: Computes final root hash for the complete trace
 * - TraceVerifier: Validates that event sequences have not been tampered with
 *
 * @example
 * ```typescript
 * // Initialize rolling hash state
 * const state = await initRollingHash();
 *
 * // Add events incrementally
 * for (const event of events) {
 *   const eventHash = await computeEventHash(event);
 *   state = await updateRollingHash(state, eventHash);
 * }
 *
 * // Or compute in batch
 * const finalHash = await computeRollingHash(events);
 *
 * // Compute root hash including span hashes
 * const rootHash = await computeRootHash(finalHash, spans);
 * ```
 */

import {
  sha256StringHex,
  canonicalize,
} from "@fluxpointstudios/orynq-sdk-core/utils";

import type { RollingHashState, TraceEvent, TraceSpan } from "./types.js";
import { HASH_DOMAIN_PREFIXES } from "./types.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/**
 * Genesis seed for the initial rolling hash state.
 * The first rolling hash is H("poi-trace:roll:v1|genesis").
 */
const GENESIS_SEED = "genesis";

// -----------------------------------------------------------------------------
// Event Hash Functions
// -----------------------------------------------------------------------------

/**
 * Compute hash for a single event using domain separation.
 *
 * The event hash is computed as:
 * `H("poi-trace:event:v1|" + canonicalize(eventWithoutHash))`
 *
 * The 'hash' field is removed before hashing to avoid circularity - otherwise
 * computing the hash would require knowing the hash.
 *
 * @param event - The trace event to hash
 * @returns Promise resolving to the event hash as a lowercase hex string
 *
 * @example
 * ```typescript
 * const event: TraceEvent = {
 *   kind: "command",
 *   id: "550e8400-e29b-41d4-a716-446655440000",
 *   seq: 1,
 *   timestamp: "2024-01-15T10:30:00.000Z",
 *   visibility: "public",
 *   command: "npm install",
 * };
 * const hash = await computeEventHash(event);
 * // Returns 64-character hex string
 * ```
 */
export async function computeEventHash(event: TraceEvent): Promise<string> {
  // Create a copy without the hash field to avoid circularity
  const eventWithoutHash = removeHashField(event);

  // Canonicalize for deterministic serialization
  const canonical = canonicalize(eventWithoutHash);

  // Apply domain separation and hash
  const prefixedData = HASH_DOMAIN_PREFIXES.event + canonical;

  return sha256StringHex(prefixedData);
}

/**
 * Remove the 'hash' field from an event object.
 * Returns a shallow copy with all fields except 'hash'.
 *
 * @param event - Event to process
 * @returns Event copy without the hash field
 */
function removeHashField<T extends { hash?: string }>(event: T): Omit<T, "hash"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { hash: _, ...rest } = event;
  return rest;
}

// -----------------------------------------------------------------------------
// Rolling Hash State Management
// -----------------------------------------------------------------------------

/**
 * Initialize rolling hash state with the genesis hash.
 *
 * The genesis hash is computed as:
 * `H("poi-trace:roll:v1|genesis")`
 *
 * This provides a well-known starting point for all rolling hash chains,
 * ensuring that empty traces have a deterministic hash value.
 *
 * @returns Promise resolving to the initial rolling hash state
 *
 * @example
 * ```typescript
 * const state = await initRollingHash();
 * console.log(state.currentHash); // Genesis hash
 * console.log(state.itemCount);   // 0
 * ```
 */
export async function initRollingHash(): Promise<RollingHashState> {
  const genesisInput = HASH_DOMAIN_PREFIXES.roll + GENESIS_SEED;
  const genesisHash = await sha256StringHex(genesisInput);

  return {
    currentHash: genesisHash,
    itemCount: 0,
  };
}

/**
 * Update rolling hash state with a new event hash.
 *
 * The new rolling hash is computed as:
 * `H("poi-trace:roll:v1|" + prevHash + "|" + eventHash)`
 *
 * This creates a hash chain where each hash depends on all previous hashes,
 * making it impossible to modify earlier events without invalidating all
 * subsequent hashes.
 *
 * @param state - Current rolling hash state
 * @param eventHash - Hash of the event to add (from computeEventHash)
 * @returns Promise resolving to the updated rolling hash state
 *
 * @example
 * ```typescript
 * let state = await initRollingHash();
 *
 * const eventHash = await computeEventHash(event);
 * state = await updateRollingHash(state, eventHash);
 *
 * console.log(state.currentHash); // New rolling hash
 * console.log(state.itemCount);   // 1
 * ```
 */
export async function updateRollingHash(
  state: RollingHashState,
  eventHash: string
): Promise<RollingHashState> {
  // Construct the input: prefix + prevHash + "|" + eventHash
  const input = HASH_DOMAIN_PREFIXES.roll + state.currentHash + "|" + eventHash;
  const newHash = await sha256StringHex(input);

  return {
    currentHash: newHash,
    itemCount: state.itemCount + 1,
  };
}

// -----------------------------------------------------------------------------
// Batch Rolling Hash Computation
// -----------------------------------------------------------------------------

/**
 * Compute rolling hash for a sequence of events (batch mode).
 *
 * This function processes all events and returns the final rolling hash.
 * Events are sorted by their `seq` field before processing to ensure
 * deterministic ordering.
 *
 * The result is identical to calling `updateRollingHash` sequentially
 * for each event, making it suitable for verification.
 *
 * @param events - Array of trace events to hash
 * @returns Promise resolving to the final rolling hash as a hex string
 *
 * @example
 * ```typescript
 * const events: TraceEvent[] = [
 *   { kind: "command", seq: 1, ... },
 *   { kind: "output", seq: 2, ... },
 *   { kind: "decision", seq: 3, ... },
 * ];
 *
 * const finalHash = await computeRollingHash(events);
 * ```
 */
export async function computeRollingHash(events: TraceEvent[]): Promise<string> {
  // Sort events by seq to ensure deterministic ordering
  const sortedEvents = [...events].sort((a, b) => a.seq - b.seq);

  // Initialize with genesis hash
  let state = await initRollingHash();

  // Process each event in sequence
  for (const event of sortedEvents) {
    const eventHash = await computeEventHash(event);
    state = await updateRollingHash(state, eventHash);
  }

  return state.currentHash;
}

// -----------------------------------------------------------------------------
// Verification Functions
// -----------------------------------------------------------------------------

/**
 * Verify that a rolling hash matches the expected value for given events.
 *
 * This function recomputes the rolling hash from the events and compares
 * it to the expected value. Used to verify trace integrity.
 *
 * @param events - Array of trace events to verify
 * @param expectedHash - The expected rolling hash value
 * @returns Promise resolving to true if the hash matches, false otherwise
 *
 * @example
 * ```typescript
 * const isValid = await verifyRollingHash(events, storedRollingHash);
 * if (!isValid) {
 *   console.error("Trace has been tampered with!");
 * }
 * ```
 */
export async function verifyRollingHash(
  events: TraceEvent[],
  expectedHash: string
): Promise<boolean> {
  const computedHash = await computeRollingHash(events);
  return constantTimeCompare(computedHash, expectedHash.toLowerCase());
}

/**
 * Constant-time string comparison to prevent timing attacks.
 *
 * @param a - First string
 * @param b - Second string
 * @returns true if strings are equal
 */
function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

// -----------------------------------------------------------------------------
// Root Hash Computation
// -----------------------------------------------------------------------------

/**
 * Compute the final root hash from rolling hash and span hashes.
 *
 * The root hash is computed as:
 * `H("poi-trace:root:v1|" + rollingHash + "|" + spanHash1 + "|" + spanHash2 + ...)`
 *
 * Spans are sorted by their `spanSeq` field before joining to ensure
 * deterministic ordering. This creates a single commitment that covers
 * both the event sequence (via rolling hash) and the span structure.
 *
 * @param rollingHash - The final rolling hash from all events
 * @param spans - Array of trace spans (must have hash field populated)
 * @returns Promise resolving to the root hash as a hex string
 *
 * @example
 * ```typescript
 * const rollingHash = await computeRollingHash(events);
 * const rootHash = await computeRootHash(rollingHash, spans);
 *
 * // rootHash can now be published as the trace commitment
 * ```
 */
export async function computeRootHash(
  rollingHash: string,
  spans: TraceSpan[]
): Promise<string> {
  // Sort spans by spanSeq for deterministic ordering
  const sortedSpans = [...spans].sort((a, b) => a.spanSeq - b.spanSeq);

  // Extract span hashes in order
  const spanHashes = sortedSpans.map((span) => {
    if (!span.hash) {
      throw new Error(`Span ${span.id} is missing hash field`);
    }
    return span.hash;
  });

  // Build the input string
  // Format: prefix + rollingHash + "|" + spanHash1 + "|" + spanHash2 + ...
  let input = HASH_DOMAIN_PREFIXES.root + rollingHash;

  if (spanHashes.length > 0) {
    input += "|" + spanHashes.join("|");
  }

  return sha256StringHex(input);
}

// -----------------------------------------------------------------------------
// Utility Exports for Testing
// -----------------------------------------------------------------------------

/**
 * Compute event hashes for multiple events in batch.
 * Useful for pre-computing hashes before building a Merkle tree.
 *
 * @param events - Array of trace events
 * @returns Promise resolving to array of event hashes in seq order
 */
export async function computeEventHashes(
  events: TraceEvent[]
): Promise<string[]> {
  // Sort by seq for deterministic ordering
  const sortedEvents = [...events].sort((a, b) => a.seq - b.seq);

  // Compute hashes in parallel for performance
  const hashPromises = sortedEvents.map((event) => computeEventHash(event));

  return Promise.all(hashPromises);
}

/**
 * Get the genesis hash for testing and verification.
 * This is the initial hash value before any events are added.
 *
 * @returns Promise resolving to the genesis hash
 */
export async function getGenesisHash(): Promise<string> {
  const state = await initRollingHash();
  return state.currentHash;
}
