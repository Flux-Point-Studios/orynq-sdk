/**
 * @fileoverview Covert channel detection proof generator.
 *
 * Location: packages/midnight-prover/src/proofs/covert-channel-proof.ts
 *
 * Summary:
 * This module implements the CovertChannelProver class which generates and verifies
 * ZK proofs that a covert channel detector score exceeds a required threshold
 * without revealing the actual score. The proof is bound to a Cardano anchor
 * transaction for cross-chain verification.
 *
 * Usage:
 * The CovertChannelProver is used by the DefaultMidnightProver:
 * ```typescript
 * const prover = new CovertChannelProver();
 * const proof = await prover.generateProof({
 *   baseRootHash: traceBundle.rootHash,
 *   detectorScore: 0.95,
 *   threshold: 0.80,
 *   detectorConfigHash: configHash,
 *   cardanoAnchorTxHash: anchorTxHash,
 * });
 * const isValid = await prover.verifyProof(proof);
 * ```
 *
 * Related files:
 * - prover.ts: DefaultMidnightProver that orchestrates this prover
 * - prover-interface.ts: Abstract interface this fulfills
 * - types.ts: Type definitions for inputs and outputs
 */

import { randomUUID } from "node:crypto";

import type {
  CovertChannelInput,
  CovertChannelProof,
  CovertChannelPublicInputs,
} from "../types.js";

import {
  MidnightProverError,
  MidnightProverException,
} from "../types.js";

import { sha256StringHex } from "@fluxpointstudios/poi-sdk-core/utils";

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Magic header identifying mock covert channel proofs.
 */
const MOCK_MAGIC_HEADER = "MOCK-POI-CC-PROOF-V1";

// =============================================================================
// COVERT CHANNEL PROVER
// =============================================================================

/**
 * Options for CovertChannelProver configuration.
 */
export interface CovertChannelProverOptions {
  /**
   * Enable debug logging.
   */
  debug?: boolean;

  /**
   * Simulated proving time in milliseconds (for mock mode).
   * Set to 0 for instant proofs (useful in tests).
   */
  simulatedProvingTimeMs?: number;
}

/**
 * CovertChannelProver generates and verifies ZK proofs for covert channel detection.
 *
 * This prover demonstrates that:
 * 1. A detector score exists (private witness)
 * 2. That score exceeds a given threshold (public input)
 * 3. The result is bound to a Cardano anchor (cross-chain binding)
 *
 * Current implementation is a mock that simulates proof generation.
 * Real Midnight integration will be added when the Compact runtime is available.
 *
 * @example
 * ```typescript
 * const prover = new CovertChannelProver({ debug: true });
 *
 * const proof = await prover.generateProof({
 *   baseRootHash: "abc123...",
 *   detectorScore: 0.95,
 *   threshold: 0.80,
 *   detectorConfigHash: "def456...",
 *   cardanoAnchorTxHash: "txhash...",
 * });
 *
 * console.log("Score exceeds threshold:", proof.publicInputs.detectorScoreExceedsS);
 * ```
 */
export class CovertChannelProver {
  private readonly options: Required<CovertChannelProverOptions>;

  /**
   * Create a new CovertChannelProver.
   *
   * @param options - Configuration options
   */
  constructor(options: CovertChannelProverOptions = {}) {
    this.options = {
      debug: options.debug ?? false,
      simulatedProvingTimeMs: options.simulatedProvingTimeMs ?? 100,
    };
  }

  /**
   * Generate a covert channel detection proof.
   *
   * This method:
   * 1. Validates the input
   * 2. Evaluates whether the detector score exceeds the threshold
   * 3. Builds public inputs
   * 4. Generates a mock ZK proof
   * 5. Returns the proof with metrics
   *
   * @param input - Covert channel input
   * @returns Promise resolving to the generated proof
   * @throws MidnightProverException on validation or generation failure
   */
  async generateProof(input: CovertChannelInput): Promise<CovertChannelProof> {
    const startTime = Date.now();

    this.debug("Starting covert-channel proof generation");

    // Validate input
    this.validateInput(input);

    // Determine whether detector score exceeds threshold
    const detectorScoreExceedsS = input.detectorScore >= input.threshold;

    // Build public inputs
    const publicInputs: CovertChannelPublicInputs = {
      baseRootHash: normalizeHash(input.baseRootHash),
      detectorConfigHash: normalizeHash(input.detectorConfigHash),
      thresholdS: input.threshold,
      detectorScoreExceedsS,
      cardanoAnchorTxHash: normalizeHash(input.cardanoAnchorTxHash),
    };

    // Generate mock proof bytes
    const proofBytes = await this.generateMockProof(publicInputs);

    // Calculate metrics
    const provingTimeMs = Date.now() - startTime + this.options.simulatedProvingTimeMs;

    // Simulate proving delay
    if (this.options.simulatedProvingTimeMs > 0) {
      await this.delay(this.options.simulatedProvingTimeMs);
    }

    const proof: CovertChannelProof = {
      proofType: "covert-channel",
      proofId: randomUUID(),
      proof: proofBytes,
      createdAt: new Date().toISOString(),
      provingTimeMs,
      proofSizeBytes: proofBytes.length,
      publicInputs,
    };

    this.debug(`Proof generated: ${proof.proofId}`);
    this.debug(`Detector score exceeds threshold: ${detectorScoreExceedsS}`);

    return proof;
  }

  /**
   * Verify a covert channel detection proof.
   *
   * This method checks:
   * 1. Proof format is valid
   * 2. Public inputs are consistent
   * 3. Mock proof data is correctly structured
   *
   * @param proof - The proof to verify
   * @returns Promise resolving to true if valid, false otherwise
   */
  async verifyProof(proof: CovertChannelProof): Promise<boolean> {
    this.debug(`Verifying proof: ${proof.proofId}`);

    try {
      // Validate proof type
      if (proof.proofType !== "covert-channel") {
        this.debug("Invalid proof type");
        return false;
      }

      if (!proof.proof || proof.proof.length === 0) {
        this.debug("Empty proof data");
        return false;
      }

      // Validate public inputs
      const { publicInputs } = proof;

      if (!isValidHexHash(publicInputs.baseRootHash)) {
        this.debug("Invalid baseRootHash format");
        return false;
      }

      if (!isValidHexHash(publicInputs.detectorConfigHash)) {
        this.debug("Invalid detectorConfigHash format");
        return false;
      }

      if (!isValidHexHash(publicInputs.cardanoAnchorTxHash)) {
        this.debug("Invalid cardanoAnchorTxHash format");
        return false;
      }

      if (typeof publicInputs.thresholdS !== "number") {
        this.debug("Invalid thresholdS");
        return false;
      }

      if (typeof publicInputs.detectorScoreExceedsS !== "boolean") {
        this.debug("Invalid detectorScoreExceedsS");
        return false;
      }

      // Verify mock proof structure
      const isValidMock = this.verifyMockProofStructure(proof);
      if (!isValidMock) {
        this.debug("Mock proof structure invalid");
        return false;
      }

      this.debug("Proof verified successfully");
      return true;
    } catch (error) {
      this.debug(`Verification error: ${error}`);
      return false;
    }
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  /**
   * Validate the input for proof generation.
   */
  private validateInput(input: CovertChannelInput): void {
    if (!isValidHexHash(input.baseRootHash)) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_CHANNEL_INPUT,
        `Invalid baseRootHash format: ${input.baseRootHash}`
      );
    }

    if (!isValidHexHash(input.detectorConfigHash)) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_CHANNEL_INPUT,
        `Invalid detectorConfigHash format: ${input.detectorConfigHash}`
      );
    }

    if (!isValidHexHash(input.cardanoAnchorTxHash)) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_CHANNEL_INPUT,
        `Invalid cardanoAnchorTxHash format: ${input.cardanoAnchorTxHash}`
      );
    }

    if (typeof input.detectorScore !== "number" || isNaN(input.detectorScore)) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_CHANNEL_INPUT,
        "detectorScore must be a valid number"
      );
    }

    if (typeof input.threshold !== "number" || isNaN(input.threshold)) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_CHANNEL_INPUT,
        "threshold must be a valid number"
      );
    }
  }

  /**
   * Generate a mock ZK proof.
   *
   * Creates a simulated proof structure with:
   * - A magic header identifying it as a mock proof
   * - Hash of the public inputs (for integrity)
   * - Random "proof" bytes (placeholder for real proof data)
   */
  private async generateMockProof(
    publicInputs: CovertChannelPublicInputs
  ): Promise<Uint8Array> {
    const magicHeader = new TextEncoder().encode(MOCK_MAGIC_HEADER);

    // Hash of public inputs for integrity
    const publicInputsStr = JSON.stringify(publicInputs);
    const publicInputsHash = await sha256StringHex(publicInputsStr);
    const publicInputsHashBytes = hexToBytes(publicInputsHash);

    // Random "proof" data (256 bytes)
    const randomProofData = new Uint8Array(256);
    crypto.getRandomValues(randomProofData);

    // Combine all parts: header + hash(32) + random(256)
    const proof = new Uint8Array(
      magicHeader.length + publicInputsHashBytes.length + randomProofData.length
    );

    let offset = 0;
    proof.set(magicHeader, offset);
    offset += magicHeader.length;
    proof.set(publicInputsHashBytes, offset);
    offset += publicInputsHashBytes.length;
    proof.set(randomProofData, offset);

    return proof;
  }

  /**
   * Verify the structure of a mock proof.
   */
  private verifyMockProofStructure(proof: CovertChannelProof): boolean {
    const data = proof.proof;
    const headerLen = MOCK_MAGIC_HEADER.length;

    // Minimum length: header + 32 (hash) + 256 (proof data)
    if (data.length < headerLen + 32 + 256) {
      return false;
    }

    // Check magic header
    const header = new TextDecoder().decode(data.slice(0, headerLen));
    if (header !== MOCK_MAGIC_HEADER) {
      return false;
    }

    return true;
  }

  /**
   * Debug logging helper.
   */
  private debug(message: string): void {
    if (this.options.debug) {
      console.log(`[CovertChannelProver] ${message}`);
    }
  }

  /**
   * Delay helper for simulated proving time.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Validate a hex hash string (64 characters, with or without 0x prefix).
 */
function isValidHexHash(value: string): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const cleanHex = value.startsWith("0x") ? value.slice(2) : value;
  return /^[0-9a-fA-F]{64}$/.test(cleanHex);
}

/**
 * Normalize a hash to lowercase without 0x prefix.
 */
function normalizeHash(hash: string): string {
  const cleanHex = hash.startsWith("0x") ? hash.slice(2) : hash;
  return cleanHex.toLowerCase();
}

/**
 * Convert a hex string to Uint8Array.
 */
function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.substring(i, i + 2), 16);
  }
  return bytes;
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a new CovertChannelProver instance.
 *
 * @param options - Configuration options
 * @returns A new CovertChannelProver instance
 */
export function createCovertChannelProver(
  options?: CovertChannelProverOptions
): CovertChannelProver {
  return new CovertChannelProver(options);
}
