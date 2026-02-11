/**
 * @fileoverview Monitor compliance proof generator.
 *
 * Location: packages/midnight-prover/src/proofs/monitor-compliance-proof.ts
 *
 * Summary:
 * This module implements the MonitorComplianceProver class which generates and verifies
 * ZK proofs that all required monitors ran for a given trace without revealing
 * individual monitor results. The proof is bound to a Cardano anchor transaction
 * for cross-chain verification.
 *
 * Usage:
 * The MonitorComplianceProver is used by the DefaultMidnightProver:
 * ```typescript
 * const prover = new MonitorComplianceProver();
 * const proof = await prover.generateProof({
 *   baseRootHash: traceBundle.rootHash,
 *   monitorConfigHash: configHash,
 *   monitorResults: [
 *     { monitorId: "toxicity", ran: true },
 *     { monitorId: "bias", ran: true },
 *   ],
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
  MonitorComplianceInput,
  MonitorComplianceProof,
  MonitorCompliancePublicInputs,
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
 * Magic header identifying mock monitor compliance proofs.
 */
const MOCK_MAGIC_HEADER = "MOCK-POI-MC-PROOF-V1";

// =============================================================================
// MONITOR COMPLIANCE PROVER
// =============================================================================

/**
 * Options for MonitorComplianceProver configuration.
 */
export interface MonitorComplianceProverOptions {
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
 * MonitorComplianceProver generates and verifies ZK proofs for monitor compliance.
 *
 * This prover demonstrates that:
 * 1. A set of monitor results exists (private witness)
 * 2. All required monitors ran (public input)
 * 3. The result is bound to a Cardano anchor (cross-chain binding)
 *
 * Current implementation is a mock that simulates proof generation.
 * Real Midnight integration will be added when the Compact runtime is available.
 *
 * @example
 * ```typescript
 * const prover = new MonitorComplianceProver({ debug: true });
 *
 * const proof = await prover.generateProof({
 *   baseRootHash: "abc123...",
 *   monitorConfigHash: "def456...",
 *   monitorResults: [
 *     { monitorId: "toxicity", ran: true },
 *     { monitorId: "bias", ran: true },
 *     { monitorId: "hallucination", ran: true },
 *   ],
 *   cardanoAnchorTxHash: "txhash...",
 * });
 *
 * console.log("All monitors ran:", proof.publicInputs.allRequiredMonitorsRan);
 * console.log("Monitor count:", proof.publicInputs.monitorCount);
 * ```
 */
export class MonitorComplianceProver {
  private readonly options: Required<MonitorComplianceProverOptions>;

  /**
   * Create a new MonitorComplianceProver.
   *
   * @param options - Configuration options
   */
  constructor(options: MonitorComplianceProverOptions = {}) {
    this.options = {
      debug: options.debug ?? false,
      simulatedProvingTimeMs: options.simulatedProvingTimeMs ?? 100,
    };
  }

  /**
   * Generate a monitor compliance proof.
   *
   * This method:
   * 1. Validates the input
   * 2. Evaluates whether all required monitors ran
   * 3. Builds public inputs
   * 4. Generates a mock ZK proof
   * 5. Returns the proof with metrics
   *
   * @param input - Monitor compliance input
   * @returns Promise resolving to the generated proof
   * @throws MidnightProverException on validation or generation failure
   */
  async generateProof(input: MonitorComplianceInput): Promise<MonitorComplianceProof> {
    const startTime = Date.now();

    this.debug("Starting monitor-compliance proof generation");

    // Validate input
    this.validateInput(input);

    // Determine whether all required monitors ran
    const allRequiredMonitorsRan = input.monitorResults.every((r) => r.ran);
    const monitorCount = input.monitorResults.length;

    // Build public inputs
    const publicInputs: MonitorCompliancePublicInputs = {
      baseRootHash: normalizeHash(input.baseRootHash),
      monitorConfigHash: normalizeHash(input.monitorConfigHash),
      allRequiredMonitorsRan,
      monitorCount,
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

    const proof: MonitorComplianceProof = {
      proofType: "monitor-compliance",
      proofId: randomUUID(),
      proof: proofBytes,
      createdAt: new Date().toISOString(),
      provingTimeMs,
      proofSizeBytes: proofBytes.length,
      publicInputs,
    };

    this.debug(`Proof generated: ${proof.proofId}`);
    this.debug(`All monitors ran: ${allRequiredMonitorsRan} (${monitorCount} monitors)`);

    return proof;
  }

  /**
   * Verify a monitor compliance proof.
   *
   * This method checks:
   * 1. Proof format is valid
   * 2. Public inputs are consistent
   * 3. Mock proof data is correctly structured
   *
   * @param proof - The proof to verify
   * @returns Promise resolving to true if valid, false otherwise
   */
  async verifyProof(proof: MonitorComplianceProof): Promise<boolean> {
    this.debug(`Verifying proof: ${proof.proofId}`);

    try {
      // Validate proof type
      if (proof.proofType !== "monitor-compliance") {
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

      if (!isValidHexHash(publicInputs.monitorConfigHash)) {
        this.debug("Invalid monitorConfigHash format");
        return false;
      }

      if (!isValidHexHash(publicInputs.cardanoAnchorTxHash)) {
        this.debug("Invalid cardanoAnchorTxHash format");
        return false;
      }

      if (typeof publicInputs.allRequiredMonitorsRan !== "boolean") {
        this.debug("Invalid allRequiredMonitorsRan");
        return false;
      }

      if (!Number.isInteger(publicInputs.monitorCount) || publicInputs.monitorCount < 0) {
        this.debug("Invalid monitorCount");
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
  private validateInput(input: MonitorComplianceInput): void {
    if (!isValidHexHash(input.baseRootHash)) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_COMPLIANCE_INPUT,
        `Invalid baseRootHash format: ${input.baseRootHash}`
      );
    }

    if (!isValidHexHash(input.monitorConfigHash)) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_COMPLIANCE_INPUT,
        `Invalid monitorConfigHash format: ${input.monitorConfigHash}`
      );
    }

    if (!isValidHexHash(input.cardanoAnchorTxHash)) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_COMPLIANCE_INPUT,
        `Invalid cardanoAnchorTxHash format: ${input.cardanoAnchorTxHash}`
      );
    }

    if (!Array.isArray(input.monitorResults)) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_COMPLIANCE_INPUT,
        "monitorResults must be an array"
      );
    }

    if (input.monitorResults.length === 0) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_COMPLIANCE_INPUT,
        "monitorResults array is empty"
      );
    }

    for (let i = 0; i < input.monitorResults.length; i++) {
      const result = input.monitorResults[i];
      if (result === undefined) {
        throw new MidnightProverException(
          MidnightProverError.INVALID_COMPLIANCE_INPUT,
          `Monitor result at index ${i} is undefined`
        );
      }
      if (typeof result.monitorId !== "string" || result.monitorId.length === 0) {
        throw new MidnightProverException(
          MidnightProverError.INVALID_COMPLIANCE_INPUT,
          `Monitor result at index ${i} has invalid monitorId`
        );
      }
      if (typeof result.ran !== "boolean") {
        throw new MidnightProverException(
          MidnightProverError.INVALID_COMPLIANCE_INPUT,
          `Monitor result at index ${i} has invalid ran flag`
        );
      }
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
    publicInputs: MonitorCompliancePublicInputs
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
  private verifyMockProofStructure(proof: MonitorComplianceProof): boolean {
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
      console.log(`[MonitorComplianceProver] ${message}`);
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
 * Create a new MonitorComplianceProver instance.
 *
 * @param options - Configuration options
 * @returns A new MonitorComplianceProver instance
 */
export function createMonitorComplianceProver(
  options?: MonitorComplianceProverOptions
): MonitorComplianceProver {
  return new MonitorComplianceProver(options);
}
