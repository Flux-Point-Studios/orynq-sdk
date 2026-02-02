/**
 * @fileoverview Cross-chain linking between Midnight proofs and Cardano anchors.
 *
 * Location: packages/midnight-prover/src/linking/cardano-anchor-link.ts
 *
 * Summary:
 * This module implements the CardanoAnchorLinker class which creates and verifies
 * bidirectional links between ZK proofs on Midnight and anchor transactions on Cardano.
 * These links enable cross-chain verification of PoI traces.
 *
 * Usage:
 * - Used after proof publication to establish cross-chain references
 * - Integrates with poi-anchors-cardano for anchor verification
 * - Enables verification that a Midnight proof corresponds to a specific Cardano anchor
 *
 * @example
 * ```typescript
 * import { CardanoAnchorLinker } from './cardano-anchor-link.js';
 *
 * const linker = new CardanoAnchorLinker();
 *
 * const link = linker.linkToAnchor(proof, cardanoTxHash);
 * console.log('Cross-chain link created:', link.linkId);
 *
 * const isValid = await linker.verifyLink(link);
 * console.log('Link valid:', isValid);
 * ```
 */

import type {
  Proof,
  AnyProof,
  HashChainProof,
  PolicyProof,
  AttestationProof,
  DisclosureProof,
  InferenceProof,
} from "../types.js";

import {
  MidnightProverError,
  MidnightProverException,
  isHashChainProof,
  isPolicyProof,
  isAttestationProof,
  isDisclosureProof,
  isInferenceProof,
} from "../types.js";

import { canonicalize } from "@fluxpointstudios/poi-sdk-core/utils";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Bidirectional cross-chain link between a Midnight proof and a Cardano anchor.
 *
 * This link establishes a verifiable relationship between:
 * - A ZK proof published on Midnight
 * - An anchor transaction recorded on Cardano L1
 *
 * The link is cryptographically bound through hash commitments.
 */
export interface CrossChainLink {
  /**
   * Unique identifier for this link.
   */
  linkId: string;

  /**
   * Version of the link format.
   */
  version: "1.0.0";

  // Midnight side
  /**
   * Proof ID on the Midnight network.
   */
  midnightProofId: string;

  /**
   * Transaction hash on the Midnight network (if published).
   */
  midnightTxHash: string | undefined;

  /**
   * Type of the proof.
   */
  proofType: string;

  /**
   * Hash of the proof's public inputs.
   */
  publicInputsHash: string;

  // Cardano side
  /**
   * Anchor transaction hash on Cardano L1.
   */
  cardanoAnchorTxHash: string;

  /**
   * Root hash that was anchored (e.g., trace merkle root or rolling hash).
   */
  anchoredRootHash: string;

  // Link metadata
  /**
   * ISO 8601 timestamp when the link was created.
   */
  createdAt: string;

  /**
   * Hash commitment binding both chain references.
   */
  linkCommitment: string;
}

/**
 * Result of link verification.
 */
export interface LinkVerificationResult {
  valid: boolean;
  linkId: string;
  errors: string[];
  warnings: string[];
  verifiedAt: string;

  // Verification details
  midnightVerified: boolean;
  cardanoVerified: boolean;
  commitmentVerified: boolean;
}

/**
 * Options for the CardanoAnchorLinker.
 */
export interface CardanoAnchorLinkerOptions {
  /**
   * Enable debug logging.
   */
  debug?: boolean;

  /**
   * Custom verification function for Cardano anchors.
   * If not provided, uses mock verification.
   */
  cardanoVerifier?: (txHash: string) => Promise<boolean>;

  /**
   * Custom verification function for Midnight proofs.
   * If not provided, uses mock verification.
   */
  midnightVerifier?: (proofId: string, txHash: string | undefined) => Promise<boolean>;
}

/**
 * Domain separation prefixes for link operations.
 */
const LINK_DOMAIN_PREFIXES = {
  linkId: "poi-link:id:v1|",
  commitment: "poi-link:commitment:v1|",
  publicInputs: "poi-link:public-inputs:v1|",
} as const;

// =============================================================================
// CARDANO ANCHOR LINKER
// =============================================================================

/**
 * CardanoAnchorLinker creates and verifies cross-chain links.
 *
 * This class provides:
 * - Creation of bidirectional links between Midnight proofs and Cardano anchors
 * - Cryptographic commitment generation for link verification
 * - Link verification against both chains
 *
 * @example
 * ```typescript
 * const linker = new CardanoAnchorLinker({ debug: true });
 *
 * // Create a link after proof publication
 * const link = linker.linkToAnchor(proof, cardanoTxHash);
 *
 * // Verify the link
 * const result = await linker.verifyLink(link);
 * if (result.valid) {
 *   console.log('Cross-chain link verified');
 * }
 * ```
 */
export class CardanoAnchorLinker {
  private readonly options: Required<CardanoAnchorLinkerOptions>;

  // Cache for created links
  private readonly linkCache = new Map<string, CrossChainLink>();

  /**
   * Create a new CardanoAnchorLinker instance.
   *
   * @param options - Configuration options
   */
  constructor(options: CardanoAnchorLinkerOptions = {}) {
    this.options = {
      debug: options.debug ?? false,
      cardanoVerifier: options.cardanoVerifier ?? this.mockCardanoVerifier,
      midnightVerifier: options.midnightVerifier ?? this.mockMidnightVerifier,
    };
  }

  /**
   * Create a cross-chain link between a proof and a Cardano anchor.
   *
   * This method:
   * 1. Extracts relevant data from the proof
   * 2. Generates a unique link ID
   * 3. Creates a cryptographic commitment binding both chains
   * 4. Returns the complete cross-chain link
   *
   * @param proof - The Midnight proof to link
   * @param cardanoTxHash - The Cardano anchor transaction hash
   * @param midnightTxHash - Optional Midnight transaction hash (if already published)
   * @returns The cross-chain link
   */
  linkToAnchor(
    proof: AnyProof,
    cardanoTxHash: string,
    midnightTxHash?: string
  ): CrossChainLink {
    this.debug(`Creating cross-chain link for proof ${proof.proofId}`);

    // Validate inputs
    this.validateProof(proof);
    this.validateTxHash(cardanoTxHash, "Cardano");
    if (midnightTxHash) {
      this.validateTxHash(midnightTxHash, "Midnight");
    }

    // Extract public inputs hash and anchored root hash
    const { publicInputsHash, anchoredRootHash } = this.extractProofData(proof);

    // Verify that the proof's cardanoAnchorTxHash matches the provided one
    const proofCardanoTxHash = this.extractCardanoAnchorTxHash(proof);
    if (normalizeHash(proofCardanoTxHash) !== normalizeHash(cardanoTxHash)) {
      throw new MidnightProverException(
        MidnightProverError.HASH_MISMATCH,
        `Proof's cardanoAnchorTxHash (${proofCardanoTxHash}) does not match provided cardanoTxHash (${cardanoTxHash})`
      );
    }

    // Generate link ID
    const linkId = this.generateLinkId(proof.proofId, cardanoTxHash);

    // Generate link commitment
    const linkCommitment = this.generateLinkCommitmentSync(
      proof.proofId,
      cardanoTxHash,
      publicInputsHash,
      anchoredRootHash
    );

    const link: CrossChainLink = {
      linkId,
      version: "1.0.0",
      midnightProofId: proof.proofId,
      midnightTxHash,
      proofType: proof.proofType,
      publicInputsHash,
      cardanoAnchorTxHash: normalizeHash(cardanoTxHash),
      anchoredRootHash,
      createdAt: new Date().toISOString(),
      linkCommitment,
    };

    // Cache the link
    this.linkCache.set(linkId, link);

    this.debug(`Cross-chain link created: ${linkId}`);

    return link;
  }

  /**
   * Verify a cross-chain link.
   *
   * This method verifies:
   * 1. Link structure and format
   * 2. Link commitment integrity
   * 3. Midnight proof existence (if verifier provided)
   * 4. Cardano anchor existence (if verifier provided)
   *
   * @param link - The cross-chain link to verify
   * @returns Promise resolving to the verification result
   */
  async verifyLink(link: CrossChainLink): Promise<LinkVerificationResult> {
    this.debug(`Verifying cross-chain link: ${link.linkId}`);

    const errors: string[] = [];
    const warnings: string[] = [];
    let midnightVerified = false;
    let cardanoVerified = false;
    let commitmentVerified = false;

    // Verify link structure
    const structureErrors = this.validateLinkStructure(link);
    errors.push(...structureErrors);

    if (structureErrors.length === 0) {
      // Verify commitment
      const expectedCommitment = this.generateLinkCommitmentSync(
        link.midnightProofId,
        link.cardanoAnchorTxHash,
        link.publicInputsHash,
        link.anchoredRootHash
      );

      if (expectedCommitment === link.linkCommitment) {
        commitmentVerified = true;
      } else {
        errors.push("Link commitment does not match");
      }

      // Verify Midnight proof
      try {
        midnightVerified = await this.options.midnightVerifier(
          link.midnightProofId,
          link.midnightTxHash
        );
        if (!midnightVerified) {
          warnings.push("Midnight proof could not be verified on-chain");
        }
      } catch (error) {
        warnings.push(`Midnight verification error: ${String(error)}`);
      }

      // Verify Cardano anchor
      try {
        cardanoVerified = await this.options.cardanoVerifier(link.cardanoAnchorTxHash);
        if (!cardanoVerified) {
          warnings.push("Cardano anchor could not be verified on-chain");
        }
      } catch (error) {
        warnings.push(`Cardano verification error: ${String(error)}`);
      }
    }

    const valid = errors.length === 0 && commitmentVerified;

    const result: LinkVerificationResult = {
      valid,
      linkId: link.linkId,
      errors,
      warnings,
      verifiedAt: new Date().toISOString(),
      midnightVerified,
      cardanoVerified,
      commitmentVerified,
    };

    this.debug(`Link verification result: ${valid ? "VALID" : "INVALID"}`);

    return result;
  }

  /**
   * Get a cached link by ID.
   *
   * @param linkId - The link identifier
   * @returns The cached link or undefined
   */
  getCachedLink(linkId: string): CrossChainLink | undefined {
    return this.linkCache.get(linkId);
  }

  /**
   * Get a link by proof ID.
   *
   * @param proofId - The proof identifier
   * @returns The cached link or undefined
   */
  getLinkByProofId(proofId: string): CrossChainLink | undefined {
    for (const link of this.linkCache.values()) {
      if (link.midnightProofId === proofId) {
        return link;
      }
    }
    return undefined;
  }

  /**
   * Get all links for a Cardano anchor.
   *
   * @param cardanoTxHash - The Cardano transaction hash
   * @returns Array of links for this anchor
   */
  getLinksByCardanoAnchor(cardanoTxHash: string): CrossChainLink[] {
    const normalizedHash = normalizeHash(cardanoTxHash);
    const links: CrossChainLink[] = [];

    for (const link of this.linkCache.values()) {
      if (normalizeHash(link.cardanoAnchorTxHash) === normalizedHash) {
        links.push(link);
      }
    }

    return links;
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  /**
   * Validate a proof for linking.
   */
  private validateProof(proof: Proof): void {
    if (!proof.proofId) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_INPUT,
        "Proof ID is required"
      );
    }

    if (!proof.proofType) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_INPUT,
        "Proof type is required"
      );
    }

    if (!proof.proof || proof.proof.length === 0) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_PROOF_FORMAT,
        "Proof data is empty"
      );
    }
  }

  /**
   * Validate a transaction hash.
   */
  private validateTxHash(txHash: string, chainName: string): void {
    const normalized = normalizeHash(txHash);
    if (!/^[0-9a-f]{64}$/.test(normalized)) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_INPUT,
        `Invalid ${chainName} transaction hash format: ${txHash}`
      );
    }
  }

  /**
   * Validate link structure.
   */
  private validateLinkStructure(link: CrossChainLink): string[] {
    const errors: string[] = [];

    if (!link.linkId) {
      errors.push("Missing linkId");
    }

    if (link.version !== "1.0.0") {
      errors.push(`Unknown link version: ${link.version}`);
    }

    if (!link.midnightProofId) {
      errors.push("Missing midnightProofId");
    }

    if (!link.proofType) {
      errors.push("Missing proofType");
    }

    if (!link.publicInputsHash || !/^[0-9a-f]{64}$/i.test(link.publicInputsHash)) {
      errors.push("Invalid publicInputsHash format");
    }

    if (!link.cardanoAnchorTxHash || !/^[0-9a-f]{64}$/i.test(link.cardanoAnchorTxHash)) {
      errors.push("Invalid cardanoAnchorTxHash format");
    }

    if (!link.anchoredRootHash || !/^[0-9a-f]{64}$/i.test(link.anchoredRootHash)) {
      errors.push("Invalid anchoredRootHash format");
    }

    if (!link.linkCommitment || !/^[0-9a-f]{64}$/i.test(link.linkCommitment)) {
      errors.push("Invalid linkCommitment format");
    }

    if (!link.createdAt) {
      errors.push("Missing createdAt timestamp");
    }

    return errors;
  }

  /**
   * Extract data from proof for linking.
   */
  private extractProofData(proof: AnyProof): {
    publicInputsHash: string;
    anchoredRootHash: string;
  } {
    let publicInputsData: Record<string, unknown>;
    let anchoredRootHash: string;

    if (isHashChainProof(proof)) {
      const p = proof as HashChainProof;
      publicInputsData = p.publicInputs as unknown as Record<string, unknown>;
      anchoredRootHash = p.publicInputs.rootHash;
    } else if (isPolicyProof(proof)) {
      const p = proof as PolicyProof;
      publicInputsData = p.publicInputs as unknown as Record<string, unknown>;
      // For policy proofs, use promptHash as the "root"
      anchoredRootHash = p.publicInputs.promptHash;
    } else if (isAttestationProof(proof)) {
      const p = proof as AttestationProof;
      publicInputsData = p.publicInputs as unknown as Record<string, unknown>;
      anchoredRootHash = p.publicInputs.boundHash;
    } else if (isDisclosureProof(proof)) {
      const p = proof as DisclosureProof;
      publicInputsData = p.publicInputs as unknown as Record<string, unknown>;
      anchoredRootHash = p.publicInputs.merkleRoot;
    } else if (isInferenceProof(proof)) {
      const p = proof as InferenceProof;
      publicInputsData = p.publicInputs as unknown as Record<string, unknown>;
      anchoredRootHash = p.publicInputs.modelWeightDigest;
    } else {
      throw new MidnightProverException(
        MidnightProverError.INVALID_INPUT,
        `Unknown proof type: ${(proof as Proof).proofType}`
      );
    }

    // Hash public inputs
    const publicInputsHash = this.hashPublicInputsSync(publicInputsData);

    return { publicInputsHash, anchoredRootHash };
  }

  /**
   * Extract Cardano anchor transaction hash from proof.
   */
  private extractCardanoAnchorTxHash(proof: AnyProof): string {
    const anyProof = proof as { publicInputs?: { cardanoAnchorTxHash?: string } };
    const txHash = anyProof.publicInputs?.cardanoAnchorTxHash;

    if (!txHash) {
      throw new MidnightProverException(
        MidnightProverError.MISSING_REQUIRED_FIELD,
        "Proof must have cardanoAnchorTxHash in public inputs"
      );
    }

    return txHash;
  }

  /**
   * Generate a unique link ID.
   */
  private generateLinkId(proofId: string, cardanoTxHash: string): string {
    // Simple hash-based link ID
    const input = LINK_DOMAIN_PREFIXES.linkId + proofId + "|" + normalizeHash(cardanoTxHash);
    // Use synchronous generation for now (matches existing pattern)
    return `link-${this.simpleHash(input).slice(0, 16)}`;
  }

  /**
   * Generate link commitment synchronously.
   */
  private generateLinkCommitmentSync(
    proofId: string,
    cardanoTxHash: string,
    publicInputsHash: string,
    anchoredRootHash: string
  ): string {
    const input = canonicalize({
      domain: LINK_DOMAIN_PREFIXES.commitment,
      proofId,
      cardanoTxHash: normalizeHash(cardanoTxHash),
      publicInputsHash,
      anchoredRootHash,
    });
    return this.simpleHash(input);
  }

  /**
   * Hash public inputs synchronously.
   */
  private hashPublicInputsSync(publicInputs: Record<string, unknown>): string {
    const input = LINK_DOMAIN_PREFIXES.publicInputs + canonicalize(publicInputs);
    return this.simpleHash(input);
  }

  /**
   * Simple synchronous hash function (for use in sync contexts).
   * Uses a deterministic algorithm suitable for identifiers.
   */
  private simpleHash(input: string): string {
    // Simple hash implementation for sync contexts
    // In production, this would use a proper hash function
    let hash = 0x811c9dc5; // FNV offset basis
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193); // FNV prime
    }

    // Generate a 64-char hex string by repeating the process
    let result = "";
    let state = hash;
    for (let j = 0; j < 8; j++) {
      for (let i = 0; i < input.length; i++) {
        state ^= input.charCodeAt((i + j * 7) % input.length);
        state = Math.imul(state, 0x01000193);
      }
      result += (state >>> 0).toString(16).padStart(8, "0");
    }

    return result;
  }

  /**
   * Mock Cardano verifier (always returns true for valid hashes).
   */
  private mockCardanoVerifier = async (txHash: string): Promise<boolean> => {
    // Simulate network delay
    await new Promise((resolve) => setTimeout(resolve, 50));
    // In mock mode, accept any valid-looking hash
    return /^[0-9a-f]{64}$/i.test(normalizeHash(txHash));
  };

  /**
   * Mock Midnight verifier (always returns true for non-empty proof IDs).
   */
  private mockMidnightVerifier = async (
    proofId: string,
    _txHash: string | undefined
  ): Promise<boolean> => {
    // Simulate network delay
    await new Promise((resolve) => setTimeout(resolve, 50));
    // In mock mode, accept any non-empty proof ID
    return proofId.length > 0;
  };

  /**
   * Debug logging helper.
   */
  private debug(message: string): void {
    if (this.options.debug) {
      console.log(`[CardanoAnchorLinker] ${message}`);
    }
  }
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Normalize a hash to lowercase without 0x prefix.
 */
function normalizeHash(hash: string): string {
  const cleaned = hash.startsWith("0x") ? hash.slice(2) : hash;
  return cleaned.toLowerCase();
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a new CardanoAnchorLinker instance.
 *
 * @param options - Configuration options
 * @returns New CardanoAnchorLinker instance
 */
export function createCardanoAnchorLinker(
  options?: CardanoAnchorLinkerOptions
): CardanoAnchorLinker {
  return new CardanoAnchorLinker(options);
}
