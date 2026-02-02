/**
 * @fileoverview Proof publication to the Midnight network.
 *
 * Location: packages/midnight-prover/src/linking/proof-publication.ts
 *
 * Summary:
 * This module implements the ProofPublisher class which handles submitting ZK proofs
 * to the Midnight network and monitoring their publication status. It provides retry
 * logic for resilient publication and confirmation waiting for transaction finality.
 *
 * Usage:
 * - Used by the MidnightProver to publish proofs to the Midnight network
 * - Integrates with proof-server-client.ts for network communication
 * - Returns PublicationResult with midnightTxHash for cross-chain linking
 *
 * @example
 * ```typescript
 * import { ProofPublisher } from './proof-publication.js';
 *
 * const publisher = new ProofPublisher({ maxRetries: 3 });
 * await publisher.connect(config);
 *
 * const result = await publisher.publish(proof);
 * console.log('Published:', result.midnightTxHash);
 *
 * const confirmed = await publisher.waitForConfirmation(result.proofId);
 * console.log('Confirmed:', confirmed);
 * ```
 */

import type {
  Proof,
  PublicationResult,
  ProofServerConfig,
  AnyProof,
} from "../types.js";

import {
  MidnightProverError,
  MidnightProverException,
} from "../types.js";

import { sha256StringHex, canonicalize } from "@fluxpointstudios/poi-sdk-core/utils";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Status of a proof publication.
 */
export type ProofStatus =
  | "pending"        // Submitted but not yet confirmed
  | "confirmed"      // Included in a block
  | "failed"         // Transaction failed
  | "not_found";     // Proof not found on network

/**
 * Detailed status information for a proof.
 */
export interface ProofStatusInfo {
  status: ProofStatus;
  proofId: string;
  midnightTxHash: string | undefined;
  blockNumber: number | undefined;
  confirmations: number;
  timestamp: string | undefined;
  error: string | undefined;
}

/**
 * Options for the ProofPublisher.
 */
export interface ProofPublisherOptions {
  /**
   * Maximum number of retry attempts for publication.
   * Default: 3
   */
  maxRetries?: number;

  /**
   * Base delay between retries in milliseconds (exponential backoff).
   * Default: 1000
   */
  retryDelayMs?: number;

  /**
   * Maximum delay between retries in milliseconds.
   * Default: 30000
   */
  maxRetryDelayMs?: number;

  /**
   * Default timeout for confirmation waiting in milliseconds.
   * Default: 300000 (5 minutes)
   */
  defaultConfirmationTimeoutMs?: number;

  /**
   * Polling interval for status checks in milliseconds.
   * Default: 5000
   */
  pollIntervalMs?: number;

  /**
   * Enable debug logging.
   */
  debug?: boolean;
}

/**
 * Domain separation prefixes for proof publication.
 */
const PUBLICATION_DOMAIN_PREFIXES = {
  txHash: "poi-midnight:tx:v1|",
  proofId: "poi-midnight:proof:v1|",
} as const;

// =============================================================================
// PROOF PUBLISHER
// =============================================================================

/**
 * ProofPublisher handles submitting ZK proofs to the Midnight network.
 *
 * This class provides:
 * - Resilient proof publication with retry logic
 * - Status monitoring for submitted proofs
 * - Confirmation waiting with timeout support
 *
 * Current implementation is a mock that simulates network interaction.
 * Real Midnight integration will be added when the network SDK is available.
 *
 * @example
 * ```typescript
 * const publisher = new ProofPublisher({ maxRetries: 3, debug: true });
 * await publisher.connect(config);
 *
 * const result = await publisher.publish(hashChainProof);
 * console.log('Transaction:', result.midnightTxHash);
 *
 * // Wait for confirmation
 * const confirmed = await publisher.waitForConfirmation(result.proofId, 60000);
 * if (confirmed) {
 *   console.log('Proof confirmed on Midnight network');
 * }
 * ```
 */
export class ProofPublisher {
  private readonly options: Required<ProofPublisherOptions>;
  private config: ProofServerConfig | undefined;
  private connected = false;

  // Mock storage for simulated proofs (would be replaced with network state)
  private readonly publishedProofs = new Map<string, {
    result: PublicationResult;
    status: ProofStatus;
    confirmations: number;
    submittedAt: number;
  }>();

  /**
   * Create a new ProofPublisher instance.
   *
   * @param options - Configuration options
   */
  constructor(options: ProofPublisherOptions = {}) {
    this.options = {
      maxRetries: options.maxRetries ?? 3,
      retryDelayMs: options.retryDelayMs ?? 1000,
      maxRetryDelayMs: options.maxRetryDelayMs ?? 30000,
      defaultConfirmationTimeoutMs: options.defaultConfirmationTimeoutMs ?? 300000,
      pollIntervalMs: options.pollIntervalMs ?? 5000,
      debug: options.debug ?? false,
    };
  }

  /**
   * Connect to the Midnight network.
   *
   * @param config - Proof server configuration
   * @throws MidnightProverException on connection failure
   */
  async connect(config: ProofServerConfig): Promise<void> {
    this.debug("Connecting to Midnight network...");

    try {
      // Validate configuration
      if (!config.proofServerUrl) {
        throw new MidnightProverException(
          MidnightProverError.INVALID_INPUT,
          "Proof server URL is required"
        );
      }

      // Mock connection - in production, this would establish network connection
      await this.simulateNetworkDelay(50);

      this.config = config;
      this.connected = true;

      this.debug(`Connected to ${config.proofServerUrl}`);
    } catch (error) {
      if (error instanceof MidnightProverException) {
        throw error;
      }
      throw new MidnightProverException(
        MidnightProverError.CONNECTION_FAILED,
        `Failed to connect to Midnight network: ${String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Disconnect from the Midnight network.
   */
  async disconnect(): Promise<void> {
    if (this.connected) {
      this.debug("Disconnecting from Midnight network...");
      await this.simulateNetworkDelay(20);
      this.connected = false;
      this.config = undefined;
    }
  }

  /**
   * Check if connected to the network.
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
   * Publish a proof to the Midnight network.
   *
   * This method:
   * 1. Validates the proof structure
   * 2. Serializes the proof for transmission
   * 3. Submits to the network with retry logic
   * 4. Returns the publication result with transaction hash
   *
   * @param proof - The proof to publish
   * @returns Publication result with Midnight transaction hash
   * @throws MidnightProverException on failure after all retries
   */
  async publish(proof: Proof): Promise<PublicationResult> {
    this.ensureConnected();

    this.debug(`Publishing proof: ${proof.proofId}`);

    // Validate proof
    this.validateProof(proof);

    // Extract cardano anchor tx hash from proof if it has public inputs
    const cardanoAnchorTxHash = this.extractCardanoAnchorTxHash(proof as AnyProof);

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.options.maxRetries; attempt++) {
      try {
        const result = await this.attemptPublish(proof, cardanoAnchorTxHash, attempt);
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.debug(`Publication attempt ${attempt + 1} failed: ${lastError.message}`);

        if (attempt < this.options.maxRetries - 1) {
          const delay = this.calculateRetryDelay(attempt);
          this.debug(`Retrying in ${delay}ms...`);
          await this.delay(delay);
        }
      }
    }

    throw new MidnightProverException(
      MidnightProverError.PUBLICATION_FAILED,
      `Failed to publish proof after ${this.options.maxRetries} attempts`,
      lastError
    );
  }

  /**
   * Get the status of a published proof.
   *
   * @param proofId - Unique proof identifier
   * @returns Promise resolving to the proof status
   */
  async getProofStatus(proofId: string): Promise<ProofStatusInfo> {
    this.ensureConnected();

    await this.simulateNetworkDelay(30);

    const record = this.publishedProofs.get(proofId);
    if (!record) {
      return {
        status: "not_found",
        proofId,
        midnightTxHash: undefined,
        blockNumber: undefined,
        confirmations: 0,
        timestamp: undefined,
        error: undefined,
      };
    }

    // Simulate confirmation progression over time
    const elapsed = Date.now() - record.submittedAt;
    if (record.status === "pending" && elapsed > 10000) {
      record.status = "confirmed";
      record.confirmations = Math.min(Math.floor(elapsed / 5000), 10);
    } else if (record.status === "confirmed") {
      record.confirmations = Math.min(Math.floor(elapsed / 5000), 100);
    }

    return {
      status: record.status,
      proofId,
      midnightTxHash: record.result.midnightTxHash,
      blockNumber: record.result.blockNumber,
      confirmations: record.confirmations,
      timestamp: record.result.timestamp,
      error: undefined,
    };
  }

  /**
   * Wait for a proof to be confirmed on the network.
   *
   * @param proofId - Unique proof identifier
   * @param timeoutMs - Maximum time to wait in milliseconds (default: 5 minutes)
   * @returns Promise resolving to true if confirmed, false if timeout
   */
  async waitForConfirmation(
    proofId: string,
    timeoutMs?: number
  ): Promise<boolean> {
    this.ensureConnected();

    const timeout = timeoutMs ?? this.options.defaultConfirmationTimeoutMs;
    const startTime = Date.now();

    this.debug(`Waiting for confirmation of proof ${proofId} (timeout: ${timeout}ms)`);

    while (Date.now() - startTime < timeout) {
      const status = await this.getProofStatus(proofId);

      if (status.status === "confirmed") {
        this.debug(`Proof ${proofId} confirmed with ${status.confirmations} confirmations`);
        return true;
      }

      if (status.status === "failed") {
        this.debug(`Proof ${proofId} failed: ${status.error ?? "unknown error"}`);
        return false;
      }

      if (status.status === "not_found") {
        this.debug(`Proof ${proofId} not found on network`);
        return false;
      }

      // Wait before next poll
      await this.delay(this.options.pollIntervalMs);
    }

    this.debug(`Confirmation timeout for proof ${proofId}`);
    return false;
  }

  /**
   * Get the publication result for a proof.
   *
   * @param proofId - Unique proof identifier
   * @returns The publication result if found, undefined otherwise
   */
  getPublicationResult(proofId: string): PublicationResult | undefined {
    return this.publishedProofs.get(proofId)?.result;
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
        "Not connected to Midnight network. Call connect() first."
      );
    }
  }

  /**
   * Validate a proof before publication.
   */
  private validateProof(proof: Proof): void {
    if (!proof.proofId) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_INPUT,
        "Proof ID is required"
      );
    }

    if (!proof.proof || proof.proof.length === 0) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_PROOF_FORMAT,
        "Proof data is empty"
      );
    }

    if (!proof.proofType) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_INPUT,
        "Proof type is required"
      );
    }
  }

  /**
   * Extract Cardano anchor transaction hash from proof public inputs.
   */
  private extractCardanoAnchorTxHash(proof: AnyProof): string {
    // Type-safe access to publicInputs.cardanoAnchorTxHash
    const anyProof = proof as { publicInputs?: { cardanoAnchorTxHash?: string } };
    const txHash = anyProof.publicInputs?.cardanoAnchorTxHash;

    if (!txHash) {
      throw new MidnightProverException(
        MidnightProverError.MISSING_REQUIRED_FIELD,
        "Proof must have cardanoAnchorTxHash in public inputs for cross-chain linking"
      );
    }

    return txHash;
  }

  /**
   * Attempt to publish a proof (single attempt).
   */
  private async attemptPublish(
    proof: Proof,
    cardanoAnchorTxHash: string,
    _attempt: number
  ): Promise<PublicationResult> {
    // Simulate network submission
    await this.simulateNetworkDelay(100 + Math.random() * 100);

    // Generate mock transaction hash
    const txInputData = canonicalize({
      proofId: proof.proofId,
      proofType: proof.proofType,
      proofHash: await this.hashProofBytes(proof.proof),
      timestamp: new Date().toISOString(),
    });
    const midnightTxHash = await sha256StringHex(PUBLICATION_DOMAIN_PREFIXES.txHash + txInputData);

    // Simulate occasional network failures (10% failure rate on first attempt only)
    // This ensures retries work but doesn't cause flaky tests
    if (Math.random() < 0.1 && _attempt === 0) {
      throw new Error("Simulated network failure");
    }

    const result: PublicationResult = {
      midnightTxHash,
      proofId: proof.proofId,
      timestamp: new Date().toISOString(),
      cardanoAnchorTxHash,
      blockNumber: Math.floor(100000 + Math.random() * 10000),
      fee: BigInt(Math.floor(1000 + Math.random() * 500)),
    };

    // Store in mock registry
    this.publishedProofs.set(proof.proofId, {
      result,
      status: "pending",
      confirmations: 0,
      submittedAt: Date.now(),
    });

    this.debug(`Proof published: ${midnightTxHash}`);

    return result;
  }

  /**
   * Hash proof bytes for transaction identification.
   */
  private async hashProofBytes(proofBytes: Uint8Array): Promise<string> {
    // Create a copy to ensure ArrayBuffer type compatibility
    const buffer = new ArrayBuffer(proofBytes.length);
    new Uint8Array(buffer).set(proofBytes);
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * Calculate retry delay with exponential backoff.
   */
  private calculateRetryDelay(attempt: number): number {
    const delay = this.options.retryDelayMs * Math.pow(2, attempt);
    return Math.min(delay, this.options.maxRetryDelayMs);
  }

  /**
   * Simulate network delay for mock operations.
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
      console.log(`[ProofPublisher] ${message}`);
    }
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a new ProofPublisher instance.
 *
 * @param options - Configuration options
 * @returns New ProofPublisher instance
 */
export function createProofPublisher(
  options?: ProofPublisherOptions
): ProofPublisher {
  return new ProofPublisher(options);
}
