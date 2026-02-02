/**
 * @fileoverview Midnight proof server client for ZK proof generation.
 *
 * Location: packages/midnight-prover/src/midnight/proof-server-client.ts
 *
 * Summary:
 * This module implements the ProofServerClient class which handles communication
 * with the Midnight proof server for ZK proof generation. It manages connection
 * lifecycle, proof submission, and result retrieval.
 *
 * Usage:
 * - Used by the DefaultMidnightProver to generate proofs
 * - Handles connection management and request/response serialization
 * - Current implementation is a mock for testing; real Midnight integration TBD
 *
 * @example
 * ```typescript
 * import { ProofServerClient } from './proof-server-client.js';
 *
 * const client = new ProofServerClient();
 * await client.connect(config);
 *
 * const result = await client.submitProof('hash-chain', witness, publicInputs);
 * console.log('Proof generated:', result.proofId);
 *
 * await client.disconnect();
 * ```
 */

import type { ProofServerConfig, ProofType } from "../types.js";

import {
  MidnightProverError,
  MidnightProverException,
} from "../types.js";

import { sha256StringHex, canonicalize } from "@fluxpointstudios/poi-sdk-core/utils";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Result of proof generation from the server.
 */
export interface ProofResult {
  /**
   * Unique proof identifier.
   */
  proofId: string;

  /**
   * The generated proof bytes.
   */
  proof: Uint8Array;

  /**
   * Time taken to generate the proof in milliseconds.
   */
  provingTimeMs: number;

  /**
   * Size of the proof in bytes.
   */
  proofSizeBytes: number;

  /**
   * Circuit name used for proof generation.
   */
  circuit: string;

  /**
   * Server-side metadata.
   */
  serverMetadata: {
    serverId: string;
    circuitVersion: string;
    computeTimeMs: number;
  };
}

/**
 * Circuit information from the server.
 */
export interface CircuitInfo {
  name: string;
  version: string;
  constraintCount: number;
  publicInputCount: number;
  available: boolean;
}

/**
 * Options for the ProofServerClient.
 */
export interface ProofServerClientOptions {
  /**
   * Enable debug logging.
   */
  debug?: boolean;

  /**
   * Simulated proof generation time in milliseconds.
   * Default: 50ms for fast testing.
   */
  simulatedProvingTimeMs?: number;
}

/**
 * Circuit names for different proof types.
 */
const CIRCUIT_NAMES: Record<ProofType, string> = {
  "hash-chain": "poi_hash_chain_v1",
  "policy-compliance": "poi_policy_compliance_v1",
  "attestation-valid": "poi_attestation_v1",
  "selective-disclosure": "poi_disclosure_v1",
  "zkml-inference": "poi_inference_v1",
};

// =============================================================================
// PROOF SERVER CLIENT
// =============================================================================

/**
 * ProofServerClient handles communication with the Midnight proof server.
 *
 * This class provides:
 * - Connection management to the proof server
 * - Proof submission with witness and public inputs
 * - Circuit information queries
 *
 * Current implementation is a mock that simulates proof server behavior.
 * Real Midnight integration will be added when the Compact runtime is available.
 *
 * @example
 * ```typescript
 * const client = new ProofServerClient({ debug: true });
 *
 * await client.connect({
 *   proofServerUrl: 'https://proof.midnight.network',
 *   timeout: 300000,
 *   retries: 3,
 * });
 *
 * const result = await client.submitProof('hash-chain', witness, publicInputs);
 * console.log('Generated proof:', result.proofId);
 *
 * await client.disconnect();
 * ```
 */
export class ProofServerClient {
  private readonly options: Required<ProofServerClientOptions>;
  private config: ProofServerConfig | undefined;
  private connected = false;
  private serverId: string | undefined;

  /**
   * Create a new ProofServerClient instance.
   *
   * @param options - Configuration options
   */
  constructor(options: ProofServerClientOptions = {}) {
    this.options = {
      debug: options.debug ?? false,
      simulatedProvingTimeMs: options.simulatedProvingTimeMs ?? 50,
    };
  }

  /**
   * Connect to the Midnight proof server.
   *
   * @param config - Proof server configuration
   * @throws MidnightProverException on connection failure
   */
  async connect(config: ProofServerConfig): Promise<void> {
    this.debug(`Connecting to proof server at ${config.proofServerUrl}...`);

    try {
      // Validate configuration
      this.validateConfig(config);

      // Simulate connection establishment
      await this.simulateNetworkDelay(30);

      // In production, this would establish a WebSocket or HTTP connection
      // and perform any necessary handshaking/authentication
      if (config.apiKey) {
        this.debug("Authenticating with API key...");
        await this.simulateNetworkDelay(20);
      }

      // Generate a mock server ID
      this.serverId = `server-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      this.config = config;
      this.connected = true;

      this.debug(`Connected to proof server (serverId: ${this.serverId})`);
    } catch (error) {
      if (error instanceof MidnightProverException) {
        throw error;
      }
      throw new MidnightProverException(
        MidnightProverError.CONNECTION_FAILED,
        `Failed to connect to proof server: ${String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Disconnect from the proof server.
   */
  async disconnect(): Promise<void> {
    if (this.connected) {
      this.debug("Disconnecting from proof server...");
      await this.simulateNetworkDelay(10);
      this.connected = false;
      this.config = undefined;
      this.serverId = undefined;
      this.debug("Disconnected");
    }
  }

  /**
   * Check if connected to the proof server.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get the current configuration.
   */
  getConfig(): ProofServerConfig | undefined {
    return this.config;
  }

  /**
   * Submit a proof request to the server.
   *
   * This method:
   * 1. Validates the circuit and inputs
   * 2. Serializes the witness and public inputs
   * 3. Submits to the proof server
   * 4. Returns the generated proof
   *
   * @param circuit - Circuit name (e.g., "hash-chain", "policy-compliance")
   * @param witness - Private witness data for the proof
   * @param publicInputs - Public inputs for the proof
   * @returns Promise resolving to the proof result
   * @throws MidnightProverException on failure
   */
  async submitProof(
    circuit: string,
    witness: unknown,
    publicInputs: unknown
  ): Promise<ProofResult> {
    this.ensureConnected();

    const circuitName = this.resolveCircuitName(circuit);
    this.debug(`Submitting proof request for circuit: ${circuitName}`);

    const startTime = Date.now();

    try {
      // Validate circuit exists
      const circuitInfo = await this.getCircuitInfo(circuitName);
      if (!circuitInfo.available) {
        throw new MidnightProverException(
          MidnightProverError.CIRCUIT_NOT_FOUND,
          `Circuit '${circuitName}' is not available`
        );
      }

      // Serialize inputs
      const serializedWitness = this.serializeInput(witness);
      const serializedPublicInputs = this.serializeInput(publicInputs);

      this.debug(`Witness size: ${serializedWitness.length} bytes`);
      this.debug(`Public inputs size: ${serializedPublicInputs.length} bytes`);

      // Simulate proof generation
      await this.simulateProofGeneration();

      // Generate mock proof
      const proof = await this.generateMockProof(
        circuitName,
        serializedWitness,
        serializedPublicInputs
      );

      const provingTimeMs = Date.now() - startTime;

      // Generate proof ID
      const proofId = await this.generateProofId(proof);

      const result: ProofResult = {
        proofId,
        proof,
        provingTimeMs,
        proofSizeBytes: proof.length,
        circuit: circuitName,
        serverMetadata: {
          serverId: this.serverId ?? "unknown",
          circuitVersion: circuitInfo.version,
          computeTimeMs: this.options.simulatedProvingTimeMs,
        },
      };

      this.debug(`Proof generated: ${proofId} (${provingTimeMs}ms)`);

      return result;
    } catch (error) {
      if (error instanceof MidnightProverException) {
        throw error;
      }
      throw new MidnightProverException(
        MidnightProverError.PROOF_GENERATION_FAILED,
        `Proof generation failed: ${String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get information about a circuit.
   *
   * @param circuitName - Name of the circuit
   * @returns Circuit information
   */
  async getCircuitInfo(circuitName: string): Promise<CircuitInfo> {
    this.ensureConnected();

    await this.simulateNetworkDelay(20);

    // Mock circuit information
    const baseCircuitInfo: Omit<CircuitInfo, "name"> = {
      version: "1.0.0",
      constraintCount: 1000000,
      publicInputCount: 10,
      available: true,
    };

    // Circuit-specific information
    const circuitConfigs: Record<string, Partial<CircuitInfo>> = {
      poi_hash_chain_v1: {
        constraintCount: 500000,
        publicInputCount: 3,
      },
      poi_policy_compliance_v1: {
        constraintCount: 750000,
        publicInputCount: 5,
      },
      poi_attestation_v1: {
        constraintCount: 600000,
        publicInputCount: 4,
      },
      poi_disclosure_v1: {
        constraintCount: 400000,
        publicInputCount: 3,
      },
      poi_inference_v1: {
        constraintCount: 10000000, // Very large for zkML
        publicInputCount: 5,
        available: false, // Mark as unavailable by default
      },
    };

    const specificConfig = circuitConfigs[circuitName] ?? {};

    return {
      name: circuitName,
      ...baseCircuitInfo,
      ...specificConfig,
    };
  }

  /**
   * List all available circuits.
   *
   * @returns Array of circuit names
   */
  async listCircuits(): Promise<string[]> {
    this.ensureConnected();

    await this.simulateNetworkDelay(15);

    return Object.values(CIRCUIT_NAMES);
  }

  /**
   * Check if a circuit is available.
   *
   * @param circuit - Circuit name or proof type
   * @returns True if the circuit is available
   */
  async isCircuitAvailable(circuit: string): Promise<boolean> {
    const circuitName = this.resolveCircuitName(circuit);
    const info = await this.getCircuitInfo(circuitName);
    return info.available;
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  /**
   * Ensure connected before operations.
   */
  private ensureConnected(): void {
    if (!this.connected) {
      throw new MidnightProverException(
        MidnightProverError.CONNECTION_FAILED,
        "Not connected to proof server. Call connect() first."
      );
    }
  }

  /**
   * Validate server configuration.
   */
  private validateConfig(config: ProofServerConfig): void {
    if (!config.proofServerUrl) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_INPUT,
        "Proof server URL is required"
      );
    }

    if (config.timeout !== undefined && config.timeout <= 0) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_INPUT,
        "Timeout must be positive"
      );
    }

    if (config.retries !== undefined && config.retries < 0) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_INPUT,
        "Retries must be non-negative"
      );
    }
  }

  /**
   * Resolve circuit name from proof type or direct name.
   */
  private resolveCircuitName(circuit: string): string {
    // Check if it's a proof type
    const proofType = circuit as ProofType;
    if (proofType in CIRCUIT_NAMES) {
      return CIRCUIT_NAMES[proofType];
    }

    // Assume it's already a circuit name
    return circuit;
  }

  /**
   * Serialize input data for transmission.
   */
  private serializeInput(input: unknown): Uint8Array {
    const jsonString = canonicalize(input);
    return new TextEncoder().encode(jsonString);
  }

  /**
   * Simulate proof generation delay.
   */
  private async simulateProofGeneration(): Promise<void> {
    // Add some variance to simulate real proof generation
    const variance = Math.random() * 0.2 - 0.1; // +/- 10%
    const delay = this.options.simulatedProvingTimeMs * (1 + variance);
    await this.delay(delay);
  }

  /**
   * Generate a mock proof.
   */
  private async generateMockProof(
    circuitName: string,
    witness: Uint8Array,
    publicInputs: Uint8Array
  ): Promise<Uint8Array> {
    // Create a deterministic mock proof based on inputs
    const witnessHash = await this.hashBytes(witness);
    const publicInputsHash = await this.hashBytes(publicInputs);

    // Mock proof structure:
    // - Magic header (16 bytes): "MOCK-MIDNIGHT-V1"
    // - Circuit name hash (32 bytes)
    // - Witness commitment (32 bytes)
    // - Public inputs commitment (32 bytes)
    // - Random padding (144 bytes)
    // Total: 256 bytes

    const proof = new Uint8Array(256);
    const header = new TextEncoder().encode("MOCK-MIDNIGHT-V1");
    proof.set(header, 0);

    // Circuit name hash
    const circuitHash = await sha256StringHex(circuitName);
    const circuitHashBytes = this.hexToBytes(circuitHash);
    proof.set(circuitHashBytes, 16);

    // Witness commitment
    const witnessBytes = this.hexToBytes(witnessHash);
    proof.set(witnessBytes, 48);

    // Public inputs commitment
    const publicInputsBytes = this.hexToBytes(publicInputsHash);
    proof.set(publicInputsBytes, 80);

    // Random padding
    const randomPadding = new Uint8Array(144);
    crypto.getRandomValues(randomPadding);
    proof.set(randomPadding, 112);

    return proof;
  }

  /**
   * Generate a proof ID.
   */
  private async generateProofId(proof: Uint8Array): Promise<string> {
    const hash = await this.hashBytes(proof);
    return `proof-${hash.slice(0, 16)}`;
  }

  /**
   * Hash bytes to hex string.
   */
  private async hashBytes(data: Uint8Array): Promise<string> {
    // Create a copy to ensure ArrayBuffer type compatibility
    const buffer = new ArrayBuffer(data.length);
    new Uint8Array(buffer).set(data);
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
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

  /**
   * Simulate network delay.
   */
  private async simulateNetworkDelay(baseMs: number): Promise<void> {
    const jitter = Math.random() * baseMs * 0.2;
    await this.delay(baseMs + jitter);
  }

  /**
   * Delay helper.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Debug logging helper.
   */
  private debug(message: string): void {
    if (this.options.debug) {
      console.log(`[ProofServerClient] ${message}`);
    }
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a new ProofServerClient instance.
 *
 * @param options - Configuration options
 * @returns New ProofServerClient instance
 */
export function createProofServerClient(
  options?: ProofServerClientOptions
): ProofServerClient {
  return new ProofServerClient(options);
}
