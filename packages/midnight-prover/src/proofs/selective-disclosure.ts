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
} from "@fluxpointstudios/orynq-sdk-core/utils";

import {
  buildSpanMerkleTree,
  computeSpanHash,
  generateMerkleProof,
  getBundleSpanEvents,
  verifyMerkleProof,
  verifySpanInclusion,
} from "@fluxpointstudios/orynq-sdk-process-trace";
import type {
  TraceBundle,
  TraceSpan,
  TraceEvent,
  MerkleProof,
} from "@fluxpointstudios/orynq-sdk-process-trace";

export { computeSpanHash, verifyMerkleProof, verifySpanInclusion };

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
  mode?: "real" | "simulation";
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
  leaf: "poi-trace:leaf:v1|",
  node: "poi-trace:node:v1|",
} as const;

// =============================================================================
// MERKLE UTILITIES
// =============================================================================

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
  const { spans, events } = bundle.privateRun;

  // Leaves are ordered by spanSeq
  const sortedSpans = [...spans].sort((a, b) => a.spanSeq - b.spanSeq);
  const spanIndex = sortedSpans.findIndex((s) => s.id === spanId);
  const span = sortedSpans[spanIndex];
  if (span === undefined) {
    throw new MidnightProverException(
      MidnightProverError.SPAN_NOT_FOUND,
      `Span not found: ${spanId}`
    );
  }

  const spanEvents = getBundleSpanEvents(span, events);
  const spanHash = await computeSpanHash(span, spanEvents.map((e) => e.hash ?? ""));
  const merkleProof = generateMerkleProof(await buildSpanMerkleTree(spans, events), spanIndex);

  return {
    spanHash,
    leafHash: merkleProof.leafHash,
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
  private readonly mode: "real" | "simulation";
  private readonly debug: boolean;
  private readonly includeSpanData: boolean;
  private readonly includeEventData: boolean;

  /**
   * Create a new SelectiveDisclosureProver instance.
   *
   * @param options - Configuration options
   */
  constructor(options: SelectiveDisclosureProverOptions = {}) {
    this.mode = options.mode ?? "real";
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
    if (this.mode !== "simulation") {
      throw new MidnightProverException(
        MidnightProverError.PROOF_GENERATION_FAILED,
        "Legacy selective-disclosure proofs require explicit simulation mode"
      );
    }

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
      simulation: true,
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
   * This method verifies the Merkle path carried in the proof bytes against
   * the public inputs. Disclosed span data must come with its events, and both
   * must recompute to the public span hash.
   *
   * @param proof - The disclosure proof to verify
   * @returns Promise resolving to true if valid
   */
  async verifyProof(proof: DisclosureProof): Promise<boolean> {
    if (this.mode !== "simulation" || proof.simulation !== true || !proof.proofId.startsWith("simulation-")) {
      return false;
    }

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

      const path = await this.merklePath(proof.proof, publicInputs);
      if (path === null || !(await verifyMerkleProof(path))) {
        return false;
      }

      if (proof.disclosedSpan === undefined && proof.disclosedEvents === undefined) {
        return true;
      }
      return (
        proof.disclosedSpan !== undefined &&
        proof.disclosedEvents !== undefined &&
        verifySpanInclusion(path, proof.disclosedSpan, proof.disclosedEvents)
      );
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
      mode: this.mode,
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
   * Read the Merkle path from mock proof bytes, or null if the bytes are
   * malformed. The bytes carry no leaf index, so it is the one the sibling
   * positions encode.
   */
  private async merklePath(
    proofBytes: Uint8Array,
    publicInputs: DisclosurePublicInputs
  ): Promise<MerkleProof | null> {
    // Check minimum proof size and version byte
    if (proofBytes.length < 67 || proofBytes[0] !== 0x01) {
      return null;
    }

    // Commitment and witness hash must be non-zero
    const commitmentNonZero = proofBytes.slice(1, 33).some((b) => b !== 0);
    const witnessNonZero = proofBytes.slice(33, 65).some((b) => b !== 0);
    if (!commitmentNonZero || !witnessNonZero) {
      return null;
    }

    const siblingCount = (proofBytes[65]! << 8) | proofBytes[66]!;
    let encoded: Array<{ hash: string; pos: number }> = [];
    if (siblingCount > 0) {
      try {
        encoded = JSON.parse(new TextDecoder().decode(proofBytes.slice(67))) as typeof encoded;
      } catch (error) {
        if (this.debug) console.error("[SelectiveDisclosureProver] Invalid simulation fixture:", error);
        return null;
      }
      if (!Array.isArray(encoded) || encoded.length !== siblingCount) {
        return null;
      }
    }

    const siblings: MerkleProof["siblings"] = encoded.map((s) => ({
      hash: s.hash,
      position: s.pos === 0 ? "left" : "right",
    }));
    return {
      leafHash: await computeLeafHash(publicInputs.spanHash),
      leafIndex: siblings.reduce((index, s, level) => (s.position === "left" ? index + 2 ** level : index), 0),
      siblings,
      rootHash: publicInputs.merkleRoot,
    };
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
    return `simulation-disclosure-proof-${hash.slice(0, 16)}`;
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
