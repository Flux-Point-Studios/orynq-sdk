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
  verifySpanDisclosure,
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
 * Facts the caller supplies to {@link SelectiveDisclosureProver.verifyDisclosure}
 * from a source it already trusts, never from the proof: the contract of
 * process-trace's `verifyDisclosure` for membership entries.
 */
export interface DisclosureProofVerifyOptions {
  /**
   * Merkle leaf hash for each span ID. A partial disclosure verifies only as
   * membership of a span listed here, and a full disclosure of a listed span
   * must hash to that leaf.
   */
  leafHashes?: Readonly<Record<string, string>>;
  /** Number of leaves in the anchored tree; when given, the proof's path must be exactly as deep. */
  leafCount?: number;
}

/** Result of {@link SelectiveDisclosureProver.verifyDisclosure}. */
export interface DisclosureProofVerification {
  valid: boolean;
  /**
   * The proof discloses a span without its events, or events without their
   * span. Nothing binds such data to the public span hash, so the proof shows
   * only that a span is in the tree, and only for a span whose leaf hash, and
   * the tree's leaf count, the caller authenticated.
   */
  unbound: boolean;
  /** The span the proof shows to be in the tree: the disclosed span, or the authenticated span with the proven leaf. */
  spanId?: string;
  /** A full disclosure's span, as committed. */
  span?: TraceSpan;
  /** A full disclosure's events, in `seq` order, as committed. */
  events?: TraceEvent[];
  errors: string[];
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
// DISCLOSED DATA
// =============================================================================

const invalid = (...errors: string[]): DisclosureProofVerification => ({ valid: false, unbound: false, errors });

/** A disclosed span and its events, which must hash to the leaf `path` proves. */
async function fullDisclosure(
  path: MerkleProof,
  span: TraceSpan,
  events: TraceEvent[],
  { leafHashes }: DisclosureProofVerifyOptions
): Promise<DisclosureProofVerification> {
  const checked = await verifySpanDisclosure({ spanId: String(span.id), proof: path, span, events }, path.rootHash);
  if (!checked.valid || checked.span === undefined || checked.events === undefined) {
    return invalid(...checked.errors);
  }
  const spanId = checked.span.id;
  if (leafHashes !== undefined && Object.hasOwn(leafHashes, spanId) && leafHashes[spanId] !== path.leafHash) {
    return invalid(`Disclosed span "${spanId}" does not hash to its authenticated leaf hash`);
  }
  return { valid: true, unbound: false, spanId, span: checked.span, events: checked.events, errors: [] };
}

/**
 * A span without its events, or events without their span, as membership of
 * the authenticated span whose leaf hash `leafHash` is.
 */
function partialDisclosure(
  leafHash: string,
  span: TraceSpan | undefined,
  { leafHashes, leafCount }: DisclosureProofVerifyOptions
): DisclosureProofVerification {
  const unbound = (reason: string): DisclosureProofVerification => ({
    valid: false,
    unbound: true,
    errors: [
      `Partial disclosure is unbound: ${reason}. A span without its events, or events without their span, ` +
        "verify only as membership: pass the anchored tree's leaf hashes and leaf count from an authenticated source.",
    ],
  });
  if (leafHashes === undefined || leafCount === undefined) {
    return unbound("no authenticated leaf hashes and leaf count were given");
  }
  if (span !== undefined) {
    if (typeof span.id !== "string") {
      return invalid("Disclosed span has no string ID");
    }
    if (!Object.hasOwn(leafHashes, span.id)) {
      return unbound(`span "${span.id}" has no authenticated leaf hash`);
    }
    return leafHashes[span.id] === leafHash
      ? { valid: true, unbound: false, spanId: span.id, errors: [] }
      : invalid(`Disclosed span "${span.id}" is not the span with the proven leaf hash`);
  }
  const owners = Object.keys(leafHashes).filter((id) => leafHashes[id] === leafHash);
  if (owners.length === 0) {
    return unbound("no authenticated span has the proven leaf hash");
  }
  return owners.length === 1
    ? { valid: true, unbound: false, spanId: owners[0]!, errors: [] }
    : invalid("More than one authenticated span has the proven leaf hash");
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
   * Verify a selective disclosure proof; true exactly when
   * {@link verifyDisclosure} returns `valid`.
   *
   * @param proof - The disclosure proof to verify
   * @param options - Authenticated leaf hashes and leaf count
   * @returns Promise resolving to true if valid
   */
  async verifyProof(proof: DisclosureProof, options: DisclosureProofVerifyOptions = {}): Promise<boolean> {
    return (await this.verifyDisclosure(proof, options)).valid;
  }

  /**
   * Verify a selective disclosure proof and report what it binds.
   *
   * The Merkle path carried in the proof bytes must lead from the public span
   * hash to the public Merkle root. Then:
   * - a full disclosure (span and events) must recompute to the public span
   *   hash; the result holds the span and events as committed;
   * - a membership proof (neither) shows only that the public span hash is in
   *   the tree;
   * - a partial disclosure (a span without its events, or events without their
   *   span) cannot be hashed, so it verifies as membership of the span whose
   *   leaf hash the caller authenticated, given the tree's authenticated leaf
   *   count, and is reported `unbound` without them. Its data is not returned.
   *
   * @param proof - The disclosure proof to verify
   * @param options - Authenticated leaf hashes and leaf count
   * @returns Promise resolving to the verification result
   */
  async verifyDisclosure(
    proof: DisclosureProof,
    options: DisclosureProofVerifyOptions = {}
  ): Promise<DisclosureProofVerification> {
    if (this.mode !== "simulation" || proof.simulation !== true || !proof.proofId.startsWith("simulation-")) {
      return invalid("Only a simulation-mode prover verifies simulation fixtures");
    }

    try {
      if (proof.proofType !== "selective-disclosure") {
        return invalid(`Proof type ${String(proof.proofType)} is not selective-disclosure`);
      }
      if (!proof.proof || proof.proof.length === 0) {
        return invalid("Proof bytes are missing");
      }

      const { publicInputs } = proof;
      if (!publicInputs.spanHash || publicInputs.spanHash.length !== 64) {
        return invalid("Public span hash must be 64 hex characters");
      }
      if (!publicInputs.merkleRoot || publicInputs.merkleRoot.length !== 64) {
        return invalid("Public Merkle root must be 64 hex characters");
      }
      if (!publicInputs.cardanoAnchorTxHash || publicInputs.cardanoAnchorTxHash.length === 0) {
        return invalid("Public Cardano anchor transaction hash is missing");
      }
      if (proof.proofId !== (await this.generateProofId(publicInputs))) {
        return invalid("Proof ID does not match the public inputs");
      }

      const path = await this.merklePath(proof.proof, publicInputs);
      if (path === null || !(await verifyMerkleProof(path, options.leafCount))) {
        return invalid("The Merkle path in the proof bytes does not lead from the public span hash to the public Merkle root");
      }

      const { disclosedSpan: span, disclosedEvents: events } = proof;
      if (span !== undefined && events !== undefined) {
        return fullDisclosure(path, span, events, options);
      }
      if (span === undefined && events === undefined) {
        return { valid: true, unbound: false, errors: [] };
      }
      return partialDisclosure(path.leafHash, span, options);
    } catch (error) {
      if (this.debug) {
        console.error("[SelectiveDisclosureProver] Verification error:", error);
      }
      return invalid(`Verification error: ${error instanceof Error ? error.message : String(error)}`);
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
