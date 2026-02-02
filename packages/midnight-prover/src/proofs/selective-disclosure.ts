/**
 * @fileoverview Selective disclosure proof generation and verification.
 *
 * Location: packages/midnight-prover/src/proofs/selective-disclosure.ts
 *
 * Summary:
 * This module implements the SelectiveDisclosureProver class which generates ZK proofs
 * demonstrating that a specific span exists in a trace bundle without revealing other
 * spans. It uses Merkle proofs for inclusion verification and supports optional
 * disclosure of the span and event data.
 *
 * Usage:
 * - Used by the MidnightProver to generate selective disclosure proofs
 * - Integrates with process-trace Merkle tree utilities
 * - Binds proofs to Cardano anchor transactions for cross-chain verification
 *
 * @example
 * ```typescript
 * import { SelectiveDisclosureProver } from './selective-disclosure.js';
 *
 * const prover = new SelectiveDisclosureProver();
 *
 * const proof = await prover.generateProof({
 *   bundle: traceBundle,
 *   spanId: 'span-123',
 *   merkleRoot: traceBundle.merkleRoot,
 *   cardanoAnchorTxHash: 'txhash...',
 * });
 *
 * const isValid = await prover.verifyProof(proof);
 * ```
 */

import {
  sha256StringHex,
  canonicalize,
} from "@fluxpointstudios/poi-sdk-core/utils";

import type {
  TraceBundle,
  TraceSpan,
  TraceEvent,
  MerkleProof,
} from "@fluxpointstudios/poi-sdk-process-trace";

import type {
  DisclosureInput,
  DisclosureProof,
  DisclosurePublicInputs,
} from "../types.js";

import {
  MidnightProverError,
  MidnightProverException,
} from "../types.js";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Options for the SelectiveDisclosureProver.
 */
export interface SelectiveDisclosureProverOptions {
  /**
   * Enable debug logging.
   */
  debug?: boolean;

  /**
   * Always include disclosed span data in the proof.
   * Default: true
   */
  includeSpanData?: boolean;

  /**
   * Always include disclosed event data in the proof.
   * Default: true
   */
  includeEventData?: boolean;
}

/**
 * Merkle inclusion proof with span details.
 */
export interface MerkleInclusionResult {
  spanHash: string;
  leafHash: string;
  merkleProof: MerkleProof;
  span: TraceSpan;
  events: TraceEvent[];
}

/**
 * Domain separation prefixes for selective disclosure proofs.
 */
const DISCLOSURE_DOMAIN_PREFIXES = {
  proof: "poi-prover:disclosure:v1|",
  witness: "poi-prover:disclosure-witness:v1|",
  publicInput: "poi-prover:disclosure-input:v1|",
  span: "poi-trace:span:v1|",
  leaf: "poi-trace:leaf:v1|",
  node: "poi-trace:node:v1|",
} as const;

// =============================================================================
// MERKLE UTILITIES
// =============================================================================

/**
 * Compute the hash for a span including its event hashes.
 *
 * The span hash is computed as:
 * H("poi-trace:span:v1|" + canon(spanHeaderWithoutHash) + "|" + eventHashes joined by "|")
 *
 * @param span - The span to compute hash for
 * @param eventHashes - Array of event hashes in sequence order
 * @returns Promise resolving to the span hash as a hex string
 */
export async function computeSpanHash(
  span: TraceSpan,
  eventHashes: string[]
): Promise<string> {
  // Extract span header (all fields except hash)
  const spanHeader: Omit<TraceSpan, "hash"> = {
    id: span.id,
    spanSeq: span.spanSeq,
    name: span.name,
    status: span.status,
    visibility: span.visibility,
    startedAt: span.startedAt,
    eventIds: span.eventIds,
    childSpanIds: span.childSpanIds,
  };

  // Include optional fields only if they exist
  if (span.parentSpanId !== undefined) {
    (spanHeader as Record<string, unknown>).parentSpanId = span.parentSpanId;
  }
  if (span.endedAt !== undefined) {
    (spanHeader as Record<string, unknown>).endedAt = span.endedAt;
  }
  if (span.durationMs !== undefined) {
    (spanHeader as Record<string, unknown>).durationMs = span.durationMs;
  }
  if (span.metadata !== undefined) {
    (spanHeader as Record<string, unknown>).metadata = span.metadata;
  }

  // Canonicalize the span header
  const canonicalHeader = canonicalize(spanHeader, { removeNulls: true });

  // Build the hash input: prefix + canon(header) + "|" + eventHashes joined by "|"
  let hashInput = DISCLOSURE_DOMAIN_PREFIXES.span + canonicalHeader;

  // Append event hashes if any exist
  if (eventHashes.length > 0) {
    hashInput += "|" + eventHashes.join("|");
  }

  return sha256StringHex(hashInput);
}

/**
 * Compute the leaf hash for a span.
 *
 * The leaf hash is computed as: H("poi-trace:leaf:v1|" + spanHash)
 *
 * @param spanHash - The span hash
 * @returns Promise resolving to the leaf hash
 */
export async function computeLeafHash(spanHash: string): Promise<string> {
  return sha256StringHex(DISCLOSURE_DOMAIN_PREFIXES.leaf + spanHash);
}

/**
 * Compute the parent node hash from two children.
 *
 * The node hash is computed as: H("poi-trace:node:v1|" + left + "|" + right)
 *
 * @param left - Left child hash
 * @param right - Right child hash
 * @returns Promise resolving to the parent node hash
 */
export async function computeNodeHash(left: string, right: string): Promise<string> {
  return sha256StringHex(DISCLOSURE_DOMAIN_PREFIXES.node + left + "|" + right);
}

/**
 * Generate a Merkle inclusion proof for a span in a bundle.
 *
 * @param bundle - The trace bundle containing the span
 * @param spanId - ID of the span to prove inclusion for
 * @returns MerkleInclusionResult with proof and span data
 * @throws MidnightProverException if span not found
 */
export async function generateMerkleInclusionProof(
  bundle: TraceBundle,
  spanId: string
): Promise<MerkleInclusionResult> {
  const { privateRun } = bundle;
  const spans = privateRun.spans;
  const events = privateRun.events;

  // Find the span
  const span = spans.find((s) => s.id === spanId);
  if (!span) {
    throw new MidnightProverException(
      MidnightProverError.SPAN_NOT_FOUND,
      `Span not found: ${spanId}`
    );
  }

  // Create event map for quick lookup
  const eventMap = new Map<string, TraceEvent>();
  for (const event of events) {
    eventMap.set(event.id, event);
  }

  // Get events for this span in seq order
  const spanEvents = span.eventIds
    .map((id) => eventMap.get(id))
    .filter((e): e is TraceEvent => e !== undefined)
    .sort((a, b) => a.seq - b.seq);

  const eventHashes = spanEvents.map((e) => e.hash ?? "");

  // Compute span hash
  const spanHash = await computeSpanHash(span, eventHashes);

  // Sort spans by spanSeq for consistent ordering
  const sortedSpans = [...spans].sort((a, b) => a.spanSeq - b.spanSeq);
  const spanIndex = sortedSpans.findIndex((s) => s.id === spanId);

  if (spanIndex === -1) {
    throw new MidnightProverException(
      MidnightProverError.SPAN_NOT_FOUND,
      `Span not found in sorted spans: ${spanId}`
    );
  }

  // Build leaf hashes for all spans
  const leafHashes: string[] = [];
  for (const s of sortedSpans) {
    const sEvents = s.eventIds
      .map((id) => eventMap.get(id))
      .filter((e): e is TraceEvent => e !== undefined)
      .sort((a, b) => a.seq - b.seq);
    const sEventHashes = sEvents.map((e) => e.hash ?? "");
    const sSpanHash = await computeSpanHash(s, sEventHashes);
    const sLeafHash = await computeLeafHash(sSpanHash);
    leafHashes.push(sLeafHash);
  }

  // Compute the leaf hash for the target span
  const leafHash = await computeLeafHash(spanHash);

  // Generate Merkle proof (sibling path from leaf to root)
  const siblings: Array<{ hash: string; position: "left" | "right" }> = [];

  if (leafHashes.length > 1) {
    let currentLevel = [...leafHashes];
    let currentIndex = spanIndex;

    while (currentLevel.length > 1) {
      const isLeftChild = currentIndex % 2 === 0;
      const siblingIndex = isLeftChild ? currentIndex + 1 : currentIndex - 1;

      // Handle odd-leaf case: if no sibling exists, duplicate current
      let siblingHash: string;
      if (siblingIndex >= currentLevel.length) {
        const currentHash = currentLevel[currentIndex];
        if (!currentHash) {
          throw new MidnightProverException(
            MidnightProverError.PROOF_GENERATION_FAILED,
            "Unexpected undefined hash at current index"
          );
        }
        siblingHash = currentHash;
      } else {
        const hash = currentLevel[siblingIndex];
        if (!hash) {
          throw new MidnightProverException(
            MidnightProverError.PROOF_GENERATION_FAILED,
            "Unexpected undefined hash at sibling index"
          );
        }
        siblingHash = hash;
      }

      siblings.push({
        hash: siblingHash,
        position: isLeftChild ? "right" : "left",
      });

      // Build next level
      const nextLevel: string[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i] ?? "";
        const right = i + 1 < currentLevel.length ? (currentLevel[i + 1] ?? left) : left;
        const parentHash = await computeNodeHash(left, right);
        nextLevel.push(parentHash);
      }

      currentLevel = nextLevel;
      currentIndex = Math.floor(currentIndex / 2);
    }
  }

  // Compute root hash for verification
  const rootHash = leafHashes.length === 1 ? leafHashes[0] : await computeMerkleRoot(leafHashes);

  if (!rootHash) {
    throw new MidnightProverException(
      MidnightProverError.PROOF_GENERATION_FAILED,
      "Failed to compute Merkle root"
    );
  }

  const merkleProof: MerkleProof = {
    leafHash,
    leafIndex: spanIndex,
    siblings,
    rootHash,
  };

  return {
    spanHash,
    leafHash,
    merkleProof,
    span,
    events: spanEvents,
  };
}

/**
 * Compute the Merkle root from leaf hashes.
 *
 * @param leafHashes - Array of leaf hashes
 * @returns Promise resolving to the Merkle root hash
 */
export async function computeMerkleRoot(leafHashes: string[]): Promise<string> {
  if (leafHashes.length === 0) {
    return "";
  }

  if (leafHashes.length === 1) {
    return leafHashes[0] ?? "";
  }

  let currentLevel = [...leafHashes];

  while (currentLevel.length > 1) {
    const nextLevel: string[] = [];

    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i] ?? "";
      const right = i + 1 < currentLevel.length ? (currentLevel[i + 1] ?? left) : left;
      const parentHash = await computeNodeHash(left, right);
      nextLevel.push(parentHash);
    }

    currentLevel = nextLevel;
  }

  return currentLevel[0] ?? "";
}

/**
 * Verify a Merkle inclusion proof.
 *
 * @param proof - The Merkle proof to verify
 * @returns Promise resolving to true if valid
 */
export async function verifyMerkleProof(proof: MerkleProof): Promise<boolean> {
  let currentHash = proof.leafHash;

  for (const sibling of proof.siblings) {
    let left: string;
    let right: string;

    if (sibling.position === "left") {
      left = sibling.hash;
      right = currentHash;
    } else {
      left = currentHash;
      right = sibling.hash;
    }

    currentHash = await computeNodeHash(left, right);
  }

  return currentHash === proof.rootHash;
}

/**
 * Verify span inclusion using the proof and span data.
 *
 * @param proof - The Merkle proof
 * @param span - The span data
 * @param events - The events belonging to the span
 * @returns Promise resolving to true if span is validly included
 */
export async function verifySpanInclusion(
  proof: MerkleProof,
  span: TraceSpan,
  events: TraceEvent[]
): Promise<boolean> {
  // Sort events by seq for deterministic order
  const sortedEvents = [...events].sort((a, b) => a.seq - b.seq);
  const eventHashes = sortedEvents.map((e) => e.hash ?? "");

  // Recompute span hash
  const spanHash = await computeSpanHash(span, eventHashes);

  // Compute expected leaf hash
  const computedLeafHash = await computeLeafHash(spanHash);

  // Verify leaf hash matches
  if (computedLeafHash !== proof.leafHash) {
    return false;
  }

  // Verify Merkle proof
  return verifyMerkleProof(proof);
}

// =============================================================================
// SELECTIVE DISCLOSURE PROVER
// =============================================================================

/**
 * SelectiveDisclosureProver generates and verifies ZK proofs of span membership.
 *
 * This prover creates a proof that a specific span exists in a trace bundle
 * without revealing other spans. The proof uses Merkle tree inclusion proofs
 * and optionally includes the disclosed span and event data.
 *
 * @example
 * ```typescript
 * const prover = new SelectiveDisclosureProver();
 * const proof = await prover.generateProof(input);
 *
 * // Proof includes optional span data for verification
 * console.log(proof.disclosedSpan?.name); // e.g., "inference"
 * ```
 */
export class SelectiveDisclosureProver {
  private readonly debug: boolean;
  private readonly includeSpanData: boolean;
  private readonly includeEventData: boolean;

  /**
   * Create a new SelectiveDisclosureProver instance.
   *
   * @param options - Configuration options
   */
  constructor(options: SelectiveDisclosureProverOptions = {}) {
    this.debug = options.debug ?? false;
    this.includeSpanData = options.includeSpanData ?? true;
    this.includeEventData = options.includeEventData ?? true;
  }

  /**
   * Generate a selective disclosure proof.
   *
   * This method creates a ZK proof that a specific span exists in the
   * trace bundle's Merkle tree. The proof binds to the Cardano anchor
   * transaction for cross-chain verification.
   *
   * @param input - Selective disclosure input
   * @returns Promise resolving to the disclosure proof
   * @throws MidnightProverException on validation or generation failure
   */
  async generateProof(input: DisclosureInput): Promise<DisclosureProof> {
    const startTime = performance.now();

    // Validate input
    this.validateInput(input);

    if (this.debug) {
      console.log("[SelectiveDisclosureProver] Generating proof for span:", input.spanId);
    }

    // Generate Merkle inclusion proof
    const inclusionResult = await generateMerkleInclusionProof(input.bundle, input.spanId);

    // Verify the computed root matches the expected root
    if (inclusionResult.merkleProof.rootHash !== input.merkleRoot) {
      throw new MidnightProverException(
        MidnightProverError.HASH_MISMATCH,
        `Computed Merkle root ${inclusionResult.merkleProof.rootHash} does not match expected ${input.merkleRoot}`
      );
    }

    // Generate proof bytes (mock implementation)
    const proofBytes = await this.generateProofBytes(input, inclusionResult);

    const endTime = performance.now();
    const provingTimeMs = Math.round(endTime - startTime);

    // Construct public inputs
    const publicInputs: DisclosurePublicInputs = {
      spanHash: inclusionResult.spanHash,
      merkleRoot: input.merkleRoot,
      cardanoAnchorTxHash: input.cardanoAnchorTxHash,
    };

    // Generate proof ID
    const proofId = await this.generateProofId(publicInputs);

    const proof: DisclosureProof = {
      proofType: "selective-disclosure",
      proofId,
      proof: proofBytes,
      createdAt: new Date().toISOString(),
      provingTimeMs,
      proofSizeBytes: proofBytes.length,
      publicInputs,
      disclosedSpan: this.includeSpanData ? inclusionResult.span : undefined,
      disclosedEvents: this.includeEventData ? inclusionResult.events : undefined,
    };

    if (this.debug) {
      console.log("[SelectiveDisclosureProver] Proof generated:", {
        proofId,
        spanHash: inclusionResult.spanHash,
        leafIndex: inclusionResult.merkleProof.leafIndex,
        siblingCount: inclusionResult.merkleProof.siblings.length,
        provingTimeMs,
      });
    }

    return proof;
  }

  /**
   * Verify a selective disclosure proof.
   *
   * This method verifies the cryptographic validity of the proof and
   * optionally verifies that disclosed span data matches the proof.
   *
   * @param proof - The disclosure proof to verify
   * @returns Promise resolving to true if valid
   */
  async verifyProof(proof: DisclosureProof): Promise<boolean> {
    try {
      // Validate proof structure
      if (proof.proofType !== "selective-disclosure") {
        return false;
      }

      if (!proof.proof || proof.proof.length === 0) {
        return false;
      }

      // Validate public inputs
      const { publicInputs } = proof;
      if (!publicInputs.spanHash || publicInputs.spanHash.length !== 64) {
        return false;
      }
      if (!publicInputs.merkleRoot || publicInputs.merkleRoot.length !== 64) {
        return false;
      }
      if (!publicInputs.cardanoAnchorTxHash || publicInputs.cardanoAnchorTxHash.length === 0) {
        return false;
      }

      // Verify proof ID matches public inputs
      const expectedProofId = await this.generateProofId(publicInputs);
      if (proof.proofId !== expectedProofId) {
        return false;
      }

      // Extract Merkle proof from proof bytes and verify
      const merkleProofValid = await this.verifyProofBytes(proof.proof, publicInputs);
      if (!merkleProofValid) {
        return false;
      }

      // If disclosed span data is provided, verify it matches the span hash
      if (proof.disclosedSpan && proof.disclosedEvents) {
        // Note: This simplified verification doesn't check full Merkle path
        // In production, we'd extract and verify the full Merkle proof
        const sortedEvents = [...proof.disclosedEvents].sort((a, b) => a.seq - b.seq);
        const eventHashes = sortedEvents.map((e) => e.hash ?? "");
        const recomputedSpanHash = await computeSpanHash(proof.disclosedSpan, eventHashes);

        if (recomputedSpanHash !== publicInputs.spanHash) {
          return false;
        }
      }

      return true;
    } catch (error) {
      if (this.debug) {
        console.error("[SelectiveDisclosureProver] Verification error:", error);
      }
      return false;
    }
  }

  /**
   * Generate a proof without disclosure (membership proof only).
   *
   * This creates a proof that demonstrates span existence without
   * revealing any span or event data.
   *
   * @param input - Selective disclosure input
   * @returns Promise resolving to the disclosure proof without span data
   */
  async generateMembershipProof(input: DisclosureInput): Promise<DisclosureProof> {
    // Create a new prover instance with disclosure disabled
    const membershipProver = new SelectiveDisclosureProver({
      debug: this.debug,
      includeSpanData: false,
      includeEventData: false,
    });

    return membershipProver.generateProof(input);
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  /**
   * Validate disclosure input.
   */
  private validateInput(input: DisclosureInput): void {
    if (!input.bundle) {
      throw new MidnightProverException(
        MidnightProverError.MISSING_REQUIRED_FIELD,
        "Trace bundle is required"
      );
    }

    if (!input.spanId || input.spanId.length === 0) {
      throw new MidnightProverException(
        MidnightProverError.MISSING_REQUIRED_FIELD,
        "Span ID is required"
      );
    }

    if (!input.merkleRoot || input.merkleRoot.length !== 64) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_INPUT,
        "Invalid Merkle root: must be 64-character hex string"
      );
    }

    if (!input.cardanoAnchorTxHash || input.cardanoAnchorTxHash.length === 0) {
      throw new MidnightProverException(
        MidnightProverError.MISSING_REQUIRED_FIELD,
        "Cardano anchor transaction hash is required"
      );
    }
  }

  /**
   * Generate mock proof bytes.
   * In a real implementation, this would call the Midnight proof server.
   */
  private async generateProofBytes(
    input: DisclosureInput,
    inclusion: MerkleInclusionResult
  ): Promise<Uint8Array> {
    // Construct witness data (private inputs)
    const witnessData = canonicalize({
      spanId: input.spanId,
      spanHash: inclusion.spanHash,
      leafHash: inclusion.leafHash,
      leafIndex: inclusion.merkleProof.leafIndex,
      siblings: inclusion.merkleProof.siblings,
      merkleRoot: input.merkleRoot,
      cardanoAnchorTxHash: input.cardanoAnchorTxHash,
    });

    // Generate witness hash
    const witnessHash = await sha256StringHex(DISCLOSURE_DOMAIN_PREFIXES.witness + witnessData);

    // Construct public input commitment
    const publicInputData = canonicalize({
      spanHash: inclusion.spanHash,
      merkleRoot: input.merkleRoot,
      cardanoAnchorTxHash: input.cardanoAnchorTxHash,
    });
    const publicInputHash = await sha256StringHex(
      DISCLOSURE_DOMAIN_PREFIXES.publicInput + publicInputData
    );

    // Generate mock proof: commitment to witness + public inputs
    const proofCommitment = await sha256StringHex(
      DISCLOSURE_DOMAIN_PREFIXES.proof + witnessHash + "|" + publicInputHash
    );

    // Encode Merkle proof siblings for inclusion in proof bytes
    const siblingData = inclusion.merkleProof.siblings.map((s) => ({
      hash: s.hash,
      pos: s.position === "left" ? 0 : 1,
    }));
    const siblingJson = JSON.stringify(siblingData);
    const siblingBytes = new TextEncoder().encode(siblingJson);

    // Construct proof bytes:
    // - version (1 byte)
    // - commitment (32 bytes)
    // - witness hash (32 bytes)
    // - sibling count (2 bytes)
    // - sibling data (variable)
    const proofBytes = new Uint8Array(67 + siblingBytes.length);
    proofBytes[0] = 0x01; // Version 1

    // Copy commitment hash
    const commitmentBytes = this.hexToBytes(proofCommitment);
    proofBytes.set(commitmentBytes, 1);

    // Copy witness hash
    const witnessBytes = this.hexToBytes(witnessHash);
    proofBytes.set(witnessBytes, 33);

    // Write sibling count (big-endian)
    const siblingCount = inclusion.merkleProof.siblings.length;
    proofBytes[65] = (siblingCount >> 8) & 0xff;
    proofBytes[66] = siblingCount & 0xff;

    // Copy sibling data
    proofBytes.set(siblingBytes, 67);

    return proofBytes;
  }

  /**
   * Verify mock proof bytes.
   */
  private async verifyProofBytes(
    proofBytes: Uint8Array,
    publicInputs: DisclosurePublicInputs
  ): Promise<boolean> {
    // Check minimum proof size
    if (proofBytes.length < 67) {
      return false;
    }

    // Check version byte
    if (proofBytes[0] !== 0x01) {
      return false;
    }

    // Extract and verify commitment is non-zero
    const commitmentBytes = proofBytes.slice(1, 33);
    const witnessHashBytes = proofBytes.slice(33, 65);

    const commitmentNonZero = commitmentBytes.some((b) => b !== 0);
    const witnessNonZero = witnessHashBytes.some((b) => b !== 0);

    if (!commitmentNonZero || !witnessNonZero) {
      return false;
    }

    // Extract sibling count
    const siblingCount = (proofBytes[65]! << 8) | proofBytes[66]!;

    // Extract and parse sibling data if present
    if (siblingCount > 0 && proofBytes.length > 67) {
      try {
        const siblingJson = new TextDecoder().decode(proofBytes.slice(67));
        const siblings = JSON.parse(siblingJson) as Array<{ hash: string; pos: number }>;

        if (siblings.length !== siblingCount) {
          return false;
        }

        // Reconstruct Merkle proof and verify
        const merkleProof: MerkleProof = {
          leafHash: await computeLeafHash(publicInputs.spanHash),
          leafIndex: 0, // Not needed for verification
          siblings: siblings.map((s) => ({
            hash: s.hash,
            position: s.pos === 0 ? "left" : "right",
          })),
          rootHash: publicInputs.merkleRoot,
        };

        return verifyMerkleProof(merkleProof);
      } catch {
        // JSON parse error or other issue
        return false;
      }
    }

    // For single-leaf trees (no siblings), verify leaf hash equals root
    if (siblingCount === 0) {
      const leafHash = await computeLeafHash(publicInputs.spanHash);
      return leafHash === publicInputs.merkleRoot;
    }

    return true;
  }

  /**
   * Generate proof ID from public inputs.
   */
  private async generateProofId(publicInputs: DisclosurePublicInputs): Promise<string> {
    const data = canonicalize({
      type: "selective-disclosure",
      ...publicInputs,
    });
    const hash = await sha256StringHex(data);
    return `disclosure-proof-${hash.slice(0, 16)}`;
  }

  /**
   * Convert hex string to bytes.
   */
  private hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return bytes;
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a new SelectiveDisclosureProver instance.
 *
 * @param options - Configuration options
 * @returns New prover instance
 */
export function createSelectiveDisclosureProver(
  options?: SelectiveDisclosureProverOptions
): SelectiveDisclosureProver {
  return new SelectiveDisclosureProver(options);
}
