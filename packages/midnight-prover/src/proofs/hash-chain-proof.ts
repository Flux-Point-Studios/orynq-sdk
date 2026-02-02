/**
 * @fileoverview Hash-chain validity proof generator.
 *
 * Location: packages/midnight-prover/src/proofs/hash-chain-proof.ts
 *
 * Summary:
 * This module implements the HashChainProver class which generates and verifies
 * ZK proofs that a sequence of trace events produces an expected rolling hash.
 * The proof is bound to a Cardano anchor transaction for cross-chain verification.
 *
 * Usage:
 * The HashChainProver is the primary prover for PoI trace verification:
 * ```typescript
 * const prover = new HashChainProver();
 * const proof = await prover.generateProof({
 *   events: traceBundle.privateRun.events,
 *   genesisHash: await getGenesisHash(),
 *   expectedRootHash: traceBundle.rootHash,
 *   cardanoAnchorTxHash: anchorTxHash,
 * });
 * const isValid = await prover.verifyProof(proof);
 * ```
 *
 * Related files:
 * - witness-builder.ts: Builds witnesses for this prover
 * - public-inputs.ts: Builds public inputs for this prover
 * - prover-interface.ts: Abstract interface this implements
 * - types.ts: Type definitions for inputs and outputs
 */

import { randomUUID } from "node:crypto";

import type {
  HashChainInput,
  HashChainProof,
  HashChainPublicInputs,
} from "../types.js";

import {
  MidnightProverError,
  MidnightProverException,
} from "../types.js";

import {
  buildHashChainWitness,
  serializeWitness,
  computeWitnessSize,
  validateWitness,
  type HashChainWitness,
} from "../midnight/witness-builder.js";

import {
  buildPublicInputs,
  serializePublicInputs,
} from "../midnight/public-inputs.js";

import { sha256StringHex } from "@fluxpointstudios/poi-sdk-core/utils";

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Maximum number of events allowed in a single hash-chain proof.
 * This limit is imposed by circuit constraints.
 */
const MAX_EVENTS_PER_PROOF = 10_000;

/**
 * Maximum witness size in bytes (50 MB).
 */
const MAX_WITNESS_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * Hash domain prefix for rolling hash (matching process-trace).
 */
const HASH_DOMAIN_ROLL = "poi-trace:roll:v1|";

/**
 * Genesis seed for initial rolling hash state.
 */
const GENESIS_SEED = "genesis";

// =============================================================================
// HASH CHAIN PROVER
// =============================================================================

/**
 * Options for HashChainProver configuration.
 */
export interface HashChainProverOptions {
  /**
   * Enable debug logging.
   */
  debug?: boolean;

  /**
   * Maximum events per proof (defaults to MAX_EVENTS_PER_PROOF).
   */
  maxEvents?: number;

  /**
   * Simulated proving time in milliseconds (for mock mode).
   * Set to 0 for instant proofs (useful in tests).
   */
  simulatedProvingTimeMs?: number;
}

/**
 * HashChainProver generates and verifies ZK proofs for trace hash chains.
 *
 * This prover demonstrates that:
 * 1. A sequence of events exists (private witness)
 * 2. Processing them produces a specific rolling hash (public input)
 * 3. This hash matches what was anchored on Cardano (cross-chain binding)
 *
 * Current implementation is a mock that simulates proof generation.
 * Real Midnight integration will be added when the Compact runtime is available.
 *
 * @example
 * ```typescript
 * const prover = new HashChainProver({ debug: true });
 *
 * const proof = await prover.generateProof({
 *   events: bundle.privateRun.events,
 *   genesisHash: "abc123...",
 *   expectedRootHash: bundle.rootHash,
 *   cardanoAnchorTxHash: "def456...",
 * });
 *
 * console.log("Proof generated:", proof.proofId);
 * console.log("Proving time:", proof.provingTimeMs, "ms");
 *
 * const isValid = await prover.verifyProof(proof);
 * console.log("Proof valid:", isValid);
 * ```
 */
export class HashChainProver {
  private readonly options: Required<HashChainProverOptions>;

  /**
   * Create a new HashChainProver.
   *
   * @param options - Configuration options
   */
  constructor(options: HashChainProverOptions = {}) {
    this.options = {
      debug: options.debug ?? false,
      maxEvents: options.maxEvents ?? MAX_EVENTS_PER_PROOF,
      simulatedProvingTimeMs: options.simulatedProvingTimeMs ?? 100,
    };
  }

  /**
   * Generate a hash-chain validity proof.
   *
   * This method:
   * 1. Validates the input
   * 2. Builds a witness from the events
   * 3. Verifies the computed hash matches expected
   * 4. Generates a mock ZK proof
   * 5. Returns the proof with metrics
   *
   * @param input - Hash chain input with events and expected hash
   * @returns Promise resolving to the generated proof
   * @throws MidnightProverException on validation or generation failure
   */
  async generateProof(input: HashChainInput): Promise<HashChainProof> {
    const startTime = Date.now();

    this.debug("Starting hash-chain proof generation");
    this.debug(`Events: ${input.events.length}`);

    // Validate input
    this.validateInput(input);

    // Build witness
    const witness = await this.buildWitness(input);

    // Verify hash matches expected
    await this.verifyHashMatch(witness, input);

    // Build public inputs
    const publicInputs = this.buildPublicInputs(witness, input);

    // Generate mock proof
    const proofBytes = await this.generateMockProof(witness, publicInputs);

    // Calculate metrics
    const provingTimeMs = Date.now() - startTime + this.options.simulatedProvingTimeMs;

    // Simulate proving delay
    if (this.options.simulatedProvingTimeMs > 0) {
      await this.delay(this.options.simulatedProvingTimeMs);
    }

    const proof: HashChainProof = {
      proofType: "hash-chain",
      proofId: randomUUID(),
      proof: proofBytes,
      createdAt: new Date().toISOString(),
      provingTimeMs,
      proofSizeBytes: proofBytes.length,
      publicInputs,
    };

    this.debug(`Proof generated: ${proof.proofId}`);
    this.debug(`Proving time: ${proof.provingTimeMs}ms`);
    this.debug(`Proof size: ${proof.proofSizeBytes} bytes`);

    return proof;
  }

  /**
   * Verify a hash-chain proof.
   *
   * This method checks:
   * 1. Proof format is valid
   * 2. Public inputs are consistent
   * 3. Mock proof data is correctly structured
   *
   * Note: In production, this would verify the actual ZK proof.
   * Current mock implementation verifies structural integrity.
   *
   * @param proof - The proof to verify
   * @returns Promise resolving to true if valid, false otherwise
   */
  async verifyProof(proof: HashChainProof): Promise<boolean> {
    this.debug(`Verifying proof: ${proof.proofId}`);

    try {
      // Validate proof structure
      if (proof.proofType !== "hash-chain") {
        this.debug("Invalid proof type");
        return false;
      }

      if (!proof.proof || proof.proof.length === 0) {
        this.debug("Empty proof data");
        return false;
      }

      // Validate public inputs
      const { publicInputs } = proof;

      if (!isValidHexHash(publicInputs.rootHash)) {
        this.debug("Invalid rootHash format");
        return false;
      }

      if (!isValidHexHash(publicInputs.cardanoAnchorTxHash)) {
        this.debug("Invalid cardanoAnchorTxHash format");
        return false;
      }

      if (!Number.isInteger(publicInputs.eventCount) || publicInputs.eventCount < 0) {
        this.debug("Invalid eventCount");
        return false;
      }

      // Verify mock proof structure
      const isValidMockProof = await this.verifyMockProofStructure(proof);
      if (!isValidMockProof) {
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

  /**
   * Compute the genesis hash for the rolling hash chain.
   * This matches the algorithm in process-trace/rolling-hash.ts
   *
   * @returns Promise resolving to the genesis hash
   */
  async getGenesisHash(): Promise<string> {
    const genesisInput = HASH_DOMAIN_ROLL + GENESIS_SEED;
    return sha256StringHex(genesisInput);
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  /**
   * Validate the input for proof generation.
   */
  private validateInput(input: HashChainInput): void {
    // Check events array
    if (!Array.isArray(input.events)) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_INPUT,
        "events must be an array"
      );
    }

    if (input.events.length === 0) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_INPUT,
        "events array is empty"
      );
    }

    if (input.events.length > this.options.maxEvents) {
      throw new MidnightProverException(
        MidnightProverError.WITNESS_TOO_LARGE,
        `Too many events: ${input.events.length} exceeds maximum ${this.options.maxEvents}`
      );
    }

    // Check hash formats
    if (!isValidHexHash(input.genesisHash)) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_INPUT,
        `Invalid genesisHash format: ${input.genesisHash}`
      );
    }

    if (!isValidHexHash(input.expectedRootHash)) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_INPUT,
        `Invalid expectedRootHash format: ${input.expectedRootHash}`
      );
    }

    if (!isValidHexHash(input.cardanoAnchorTxHash)) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_INPUT,
        `Invalid cardanoAnchorTxHash format: ${input.cardanoAnchorTxHash}`
      );
    }

    // Validate events have required fields
    for (let i = 0; i < input.events.length; i++) {
      const event = input.events[i];
      if (event === undefined) {
        throw new MidnightProverException(
          MidnightProverError.INVALID_INPUT,
          `Event at index ${i} is undefined`
        );
      }

      if (typeof event.seq !== "number") {
        throw new MidnightProverException(
          MidnightProverError.INVALID_INPUT,
          `Event at index ${i} missing seq number`
        );
      }

      if (typeof event.kind !== "string") {
        throw new MidnightProverException(
          MidnightProverError.INVALID_INPUT,
          `Event at index ${i} missing kind`
        );
      }
    }
  }

  /**
   * Build the witness from input.
   */
  private async buildWitness(input: HashChainInput): Promise<HashChainWitness> {
    this.debug("Building witness...");

    const witness = await buildHashChainWitness(
      input.events,
      normalizeHash(input.genesisHash)
    );

    // Validate witness
    const validationErrors = validateWitness(witness);
    if (validationErrors.length > 0) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_WITNESS,
        `Witness validation failed: ${validationErrors.join(", ")}`
      );
    }

    // Check witness size
    const witnessSize = computeWitnessSize(witness);
    if (witnessSize > MAX_WITNESS_SIZE_BYTES) {
      throw new MidnightProverException(
        MidnightProverError.WITNESS_TOO_LARGE,
        `Witness size ${witnessSize} bytes exceeds maximum ${MAX_WITNESS_SIZE_BYTES}`
      );
    }

    this.debug(`Witness built: ${witness.eventCount} events, ${witnessSize} bytes`);

    return witness;
  }

  /**
   * Verify that the computed rolling hash matches the expected root hash.
   */
  private async verifyHashMatch(
    witness: HashChainWitness,
    input: HashChainInput
  ): Promise<void> {
    const computedHash = normalizeHash(witness.computedRollingHash);
    const expectedHash = normalizeHash(input.expectedRootHash);

    if (computedHash !== expectedHash) {
      throw new MidnightProverException(
        MidnightProverError.HASH_MISMATCH,
        `Rolling hash mismatch: computed ${computedHash}, expected ${expectedHash}`
      );
    }

    this.debug("Hash match verified");
  }

  /**
   * Build public inputs for the proof.
   */
  private buildPublicInputs(
    witness: HashChainWitness,
    input: HashChainInput
  ): HashChainPublicInputs {
    return buildPublicInputs("hash-chain", {
      rootHash: witness.computedRollingHash,
      eventCount: witness.eventCount,
      cardanoAnchorTxHash: input.cardanoAnchorTxHash,
    });
  }

  /**
   * Generate a mock ZK proof.
   *
   * This creates a simulated proof structure that includes:
   * - A magic header identifying it as a mock proof
   * - Hash of the witness (for integrity)
   * - Serialized public inputs
   * - Random "proof" bytes (placeholder for real proof data)
   *
   * In production, this would call the Midnight proof server.
   */
  private async generateMockProof(
    witness: HashChainWitness,
    publicInputs: HashChainPublicInputs
  ): Promise<Uint8Array> {
    // Magic header for mock proofs: "MOCK-POI-HC-PROOF-V1"
    const magicHeader = new TextEncoder().encode("MOCK-POI-HC-PROOF-V1");

    // Compute witness hash for integrity
    const serializedWitness = serializeWitness(witness);
    // Copy to a fresh ArrayBuffer to ensure compatibility with crypto.subtle.digest
    const witnessBuffer = new ArrayBuffer(serializedWitness.byteLength);
    new Uint8Array(witnessBuffer).set(serializedWitness);
    const witnessHashBuffer = await crypto.subtle.digest("SHA-256", witnessBuffer);
    const witnessHash = new Uint8Array(witnessHashBuffer);

    // Serialize public inputs
    const serializedPublicInputs = serializePublicInputs("hash-chain", publicInputs);

    // Generate random "proof" data (256 bytes)
    const randomProofData = new Uint8Array(256);
    crypto.getRandomValues(randomProofData);

    // Combine all parts
    const proof = new Uint8Array(
      magicHeader.length + // 20 bytes
      4 +                  // witness hash length (4 bytes, always 32)
      witnessHash.length + // 32 bytes
      4 +                  // public inputs length
      serializedPublicInputs.length +
      4 +                  // proof data length
      randomProofData.length
    );

    let offset = 0;

    // Write magic header
    proof.set(magicHeader, offset);
    offset += magicHeader.length;

    // Write witness hash
    const view = new DataView(proof.buffer);
    view.setUint32(offset, witnessHash.length, false);
    offset += 4;
    proof.set(witnessHash, offset);
    offset += witnessHash.length;

    // Write public inputs
    view.setUint32(offset, serializedPublicInputs.length, false);
    offset += 4;
    proof.set(serializedPublicInputs, offset);
    offset += serializedPublicInputs.length;

    // Write random proof data
    view.setUint32(offset, randomProofData.length, false);
    offset += 4;
    proof.set(randomProofData, offset);

    return proof;
  }

  /**
   * Verify the structure of a mock proof.
   */
  private async verifyMockProofStructure(proof: HashChainProof): Promise<boolean> {
    const data = proof.proof;

    // Check minimum length
    if (data.length < 20 + 4 + 32 + 4 + 1 + 4 + 1) {
      return false;
    }

    // Check magic header
    const magicHeader = new TextDecoder().decode(data.slice(0, 20));
    if (magicHeader !== "MOCK-POI-HC-PROOF-V1") {
      return false;
    }

    // Verify structure can be parsed
    try {
      let offset = 20;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

      // Witness hash
      const witnessHashLen = view.getUint32(offset, false);
      offset += 4;
      if (witnessHashLen !== 32 || offset + witnessHashLen > data.length) {
        return false;
      }
      offset += witnessHashLen;

      // Public inputs
      const publicInputsLen = view.getUint32(offset, false);
      offset += 4;
      if (offset + publicInputsLen > data.length) {
        return false;
      }
      offset += publicInputsLen;

      // Proof data
      const proofDataLen = view.getUint32(offset, false);
      offset += 4;
      if (offset + proofDataLen > data.length) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Debug logging helper.
   */
  private debug(message: string): void {
    if (this.options.debug) {
      console.log(`[HashChainProver] ${message}`);
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

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a new HashChainProver instance.
 *
 * @param options - Configuration options
 * @returns A new HashChainProver instance
 */
export function createHashChainProver(
  options?: HashChainProverOptions
): HashChainProver {
  return new HashChainProver(options);
}
