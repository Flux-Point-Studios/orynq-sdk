/**
 * @fileoverview Witness builder for hash-chain ZK proofs.
 *
 * Location: packages/midnight-prover/src/midnight/witness-builder.ts
 *
 * Summary:
 * This module converts trace events into a circuit-compatible witness format
 * for the hash-chain validity proof. The witness contains the private inputs
 * needed by the ZK circuit to prove that a sequence of events produces
 * the expected rolling hash.
 *
 * Usage:
 * Used by HashChainProver to prepare data for proof generation.
 * The witness format matches the expected Compact circuit input structure.
 *
 * Related files:
 * - hash-chain-proof.ts: Uses this to build witnesses for proof generation
 * - public-inputs.ts: Builds corresponding public inputs
 * - @fluxpointstudios/poi-sdk-process-trace: TraceEvent types
 */

import type { TraceEvent } from "@fluxpointstudios/poi-sdk-process-trace";
import {
  sha256StringHex,
  canonicalize,
  hexToBytes,
} from "@fluxpointstudios/poi-sdk-core/utils";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Hash domain prefix for event hashing in witness building.
 * Matches the process-trace package domain prefix for consistency.
 */
const HASH_DOMAIN_EVENT = "poi-trace:event:v1|";

/**
 * Hash domain prefix for rolling hash computation.
 * Matches the process-trace package domain prefix for consistency.
 */
const HASH_DOMAIN_ROLL = "poi-trace:roll:v1|";

/**
 * Witness for a single event in the hash chain.
 * Contains both the serialized event data and its computed hash.
 */
export interface EventWitness {
  /**
   * Sequence number (for ordering verification).
   */
  seq: number;

  /**
   * Serialized event data as bytes (canonical JSON).
   */
  eventData: Uint8Array;

  /**
   * SHA-256 hash of the event (domain-separated).
   */
  eventHash: string;
}

/**
 * Complete witness for hash-chain proof.
 * Contains all private inputs needed by the ZK circuit.
 */
export interface HashChainWitness {
  /**
   * Genesis hash (initial state of the rolling hash).
   */
  genesisHash: string;

  /**
   * Array of event witnesses in sequence order.
   */
  events: EventWitness[];

  /**
   * Computed rolling hash after processing all events.
   * Used for internal verification before submitting to circuit.
   */
  computedRollingHash: string;

  /**
   * Total number of events in the chain.
   */
  eventCount: number;
}

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Build a hash-chain witness from trace events.
 *
 * This function converts an array of TraceEvents into a circuit-compatible
 * witness format. The witness contains:
 * 1. The genesis hash (starting point)
 * 2. Each event serialized as bytes with its hash
 * 3. The computed rolling hash for verification
 *
 * The rolling hash computation matches the algorithm in process-trace:
 * - Events are sorted by seq number
 * - Each event hash is H(domain + canonical(event - hash field))
 * - Rolling hash is H(domain + prevHash + "|" + eventHash)
 *
 * @param events - Array of trace events to build witness from
 * @param genesisHash - Initial hash state (hex string, typically from initRollingHash)
 * @returns Promise resolving to the complete hash chain witness
 *
 * @example
 * ```typescript
 * const witness = await buildHashChainWitness(traceBundle.privateRun.events, genesisHash);
 * console.log(witness.eventCount); // Number of events
 * console.log(witness.computedRollingHash); // Final hash
 * ```
 */
export async function buildHashChainWitness(
  events: TraceEvent[],
  genesisHash: string
): Promise<HashChainWitness> {
  // Sort events by sequence number for deterministic ordering
  const sortedEvents = [...events].sort((a, b) => a.seq - b.seq);

  // Build event witnesses
  const eventWitnesses: EventWitness[] = [];

  for (const event of sortedEvents) {
    const eventWitness = await buildEventWitness(event);
    eventWitnesses.push(eventWitness);
  }

  // Compute rolling hash
  const computedRollingHash = await computeRollingHashFromWitness(
    genesisHash,
    eventWitnesses
  );

  return {
    genesisHash,
    events: eventWitnesses,
    computedRollingHash,
    eventCount: eventWitnesses.length,
  };
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Build a witness for a single event.
 *
 * @param event - The trace event to convert
 * @returns Promise resolving to the event witness
 */
async function buildEventWitness(event: TraceEvent): Promise<EventWitness> {
  // Remove the hash field to avoid circularity
  const eventWithoutHash = removeHashField(event);

  // Canonicalize for deterministic serialization
  const canonical = canonicalize(eventWithoutHash);

  // Convert to bytes for circuit
  const eventData = new TextEncoder().encode(canonical);

  // Compute hash with domain separation
  const prefixedData = HASH_DOMAIN_EVENT + canonical;
  const eventHash = await sha256StringHex(prefixedData);

  return {
    seq: event.seq,
    eventData,
    eventHash,
  };
}

/**
 * Compute rolling hash from event witnesses.
 * Matches the algorithm in process-trace/rolling-hash.ts
 *
 * @param genesisHash - Initial hash state
 * @param eventWitnesses - Array of event witnesses
 * @returns Promise resolving to the final rolling hash
 */
async function computeRollingHashFromWitness(
  genesisHash: string,
  eventWitnesses: EventWitness[]
): Promise<string> {
  let currentHash = genesisHash;

  for (const witness of eventWitnesses) {
    // Rolling hash: H(domain + prevHash + "|" + eventHash)
    const input = HASH_DOMAIN_ROLL + currentHash + "|" + witness.eventHash;
    currentHash = await sha256StringHex(input);
  }

  return currentHash;
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

// =============================================================================
// SERIALIZATION UTILITIES
// =============================================================================

/**
 * Serialize a hash chain witness to a compact binary format.
 * Used for transmitting witness data to the proof server.
 *
 * Format:
 * - 4 bytes: event count (uint32 big-endian)
 * - 32 bytes: genesis hash
 * - For each event:
 *   - 4 bytes: event data length (uint32 big-endian)
 *   - N bytes: event data
 *   - 32 bytes: event hash
 *
 * @param witness - The witness to serialize
 * @returns Serialized witness as Uint8Array
 */
export function serializeWitness(witness: HashChainWitness): Uint8Array {
  // Calculate total size
  let totalSize = 4 + 32; // count + genesis hash
  for (const event of witness.events) {
    totalSize += 4 + event.eventData.length + 32; // length + data + hash
  }

  const buffer = new Uint8Array(totalSize);
  const view = new DataView(buffer.buffer);
  let offset = 0;

  // Write event count
  view.setUint32(offset, witness.eventCount, false); // big-endian
  offset += 4;

  // Write genesis hash
  const genesisBytes = hexToBytes(witness.genesisHash);
  buffer.set(genesisBytes, offset);
  offset += 32;

  // Write each event
  for (const event of witness.events) {
    // Event data length
    view.setUint32(offset, event.eventData.length, false);
    offset += 4;

    // Event data
    buffer.set(event.eventData, offset);
    offset += event.eventData.length;

    // Event hash
    const hashBytes = hexToBytes(event.eventHash);
    buffer.set(hashBytes, offset);
    offset += 32;
  }

  return buffer;
}

/**
 * Compute the total size of a witness for resource estimation.
 *
 * @param witness - The witness to measure
 * @returns Size in bytes
 */
export function computeWitnessSize(witness: HashChainWitness): number {
  let size = 4 + 32; // count + genesis hash
  for (const event of witness.events) {
    size += 4 + event.eventData.length + 32;
  }
  return size;
}

/**
 * Validate that a witness is well-formed.
 *
 * @param witness - The witness to validate
 * @returns Array of validation errors (empty if valid)
 */
export function validateWitness(witness: HashChainWitness): string[] {
  const errors: string[] = [];

  // Check genesis hash format
  if (!/^[0-9a-f]{64}$/i.test(witness.genesisHash)) {
    errors.push("Invalid genesis hash format (expected 64-char hex string)");
  }

  // Check event count matches
  if (witness.eventCount !== witness.events.length) {
    errors.push(
      `Event count mismatch: declared ${witness.eventCount}, actual ${witness.events.length}`
    );
  }

  // Check each event
  for (let i = 0; i < witness.events.length; i++) {
    const event = witness.events[i];
    if (event === undefined) {
      errors.push(`Event at index ${i} is undefined`);
      continue;
    }

    // Check event hash format
    if (!/^[0-9a-f]{64}$/i.test(event.eventHash)) {
      errors.push(`Event ${i}: Invalid hash format`);
    }

    // Check event data is not empty
    if (event.eventData.length === 0) {
      errors.push(`Event ${i}: Empty event data`);
    }

    // Check sequence ordering
    if (i > 0) {
      const prevEvent = witness.events[i - 1];
      if (prevEvent !== undefined && event.seq <= prevEvent.seq) {
        errors.push(
          `Event ${i}: Sequence ${event.seq} not greater than previous ${prevEvent.seq}`
        );
      }
    }
  }

  return errors;
}
