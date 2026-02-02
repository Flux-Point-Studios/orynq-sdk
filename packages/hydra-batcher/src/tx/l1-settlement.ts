/**
 * Location: packages/hydra-batcher/src/tx/l1-settlement.ts
 *
 * L1 Settlement Service for Hydra Batcher.
 *
 * This module provides the L1SettlementService class which handles anchoring
 * final Hydra Head state to Cardano mainnet (L1). When a Hydra Head closes,
 * this service creates an anchor entry with the final commitment accumulator
 * state and submits it to L1 using label 2222 metadata.
 *
 * The service:
 * - Builds anchor entries compatible with anchors-cardano package
 * - Submits transactions through a configurable AnchorProvider interface
 * - Waits for L1 confirmation with configurable timeout
 * - Includes retry logic for transient failures
 *
 * Used by:
 * - batcher.ts: For settling to L1 when head closes
 * - head-manager.ts: For triggering settlement during fanout
 *
 * @example
 * ```typescript
 * const settlementService = new L1SettlementService({
 *   network: 'preprod',
 *   anchorProvider: myProvider,
 *   confirmationBlocks: 6,
 *   timeoutMs: 300000,
 * });
 *
 * const result = await settlementService.settleToL1(
 *   finalState,
 *   headId,
 *   { agentId: 'my-agent', sessionId: 'session-123' }
 * );
 * console.log('L1 tx hash:', result.l1TxHash);
 * ```
 */

import type {
  AnchorEntry,
  CardanoNetwork,
  CommitmentDatum,
  RetryConfig,
  SettlementResult,
} from "../types.js";
import { HydraBatcherError, HydraBatcherException } from "../types.js";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Configuration for the L1 settlement service.
 */
export interface L1SettlementConfig {
  /**
   * Cardano network to settle on.
   */
  network: CardanoNetwork;

  /**
   * Provider for submitting anchor transactions to L1.
   * Can be a real provider or a mock for testing.
   */
  anchorProvider: AnchorProvider;

  /**
   * Number of confirmations to wait for before considering settlement complete.
   * @default 6
   */
  confirmationBlocks?: number;

  /**
   * Timeout in milliseconds for waiting for confirmation.
   * @default 300000 (5 minutes)
   */
  timeoutMs?: number;

  /**
   * Retry configuration for L1 submission failures.
   */
  retryConfig?: RetryConfig;
}

/**
 * Interface for anchor providers.
 * Abstracts the actual L1 transaction submission mechanism.
 */
export interface AnchorProvider {
  /**
   * Submit an anchor entry to L1.
   * @param entry - The anchor entry to submit
   * @returns Transaction hash of the submitted transaction
   */
  submitAnchor(entry: AnchorEntry): Promise<string>;

  /**
   * Get the current confirmation count for a transaction.
   * @param txHash - Transaction hash to check
   * @returns Number of confirmations, or 0 if not found
   */
  getConfirmations(txHash: string): Promise<number>;

  /**
   * Check if the provider is connected and ready.
   * @returns True if ready to submit transactions
   */
  isReady(): Promise<boolean>;

  /**
   * Get the network this provider is connected to.
   */
  getNetwork(): CardanoNetwork;
}

/**
 * Metadata to include in settlement anchor entry.
 */
export interface SettlementMetadata {
  /**
   * Identifier of the agent that produced the commitments.
   */
  agentId?: string;

  /**
   * Session identifier for the settlement.
   */
  sessionId?: string;

  /**
   * Optional storage URI for the full trace data.
   */
  storageUri?: string;

  /**
   * Optional additional metadata.
   */
  extra?: Record<string, unknown>;
}

/**
 * Options for waiting for confirmation.
 */
export interface WaitOptions {
  /**
   * Polling interval in milliseconds.
   * @default 10000 (10 seconds)
   */
  pollIntervalMs?: number;

  /**
   * Callback invoked on each poll with current confirmation count.
   */
  onProgress?: (confirmations: number) => void;
}

// =============================================================================
// DEFAULT VALUES
// =============================================================================

const DEFAULT_CONFIRMATION_BLOCKS = 6;
const DEFAULT_TIMEOUT_MS = 300000; // 5 minutes
const DEFAULT_POLL_INTERVAL_MS = 10000; // 10 seconds
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

// =============================================================================
// L1 SETTLEMENT SERVICE
// =============================================================================

/**
 * L1SettlementService - Handles anchoring Hydra Head state to Cardano L1.
 *
 * This service is responsible for:
 * 1. Building anchor entries from final commitment state
 * 2. Submitting anchor transactions to L1
 * 3. Waiting for transaction confirmation
 * 4. Handling retries for transient failures
 *
 * The anchor entries use the poi-anchor-v2 schema with l2Metadata
 * containing Hydra-specific information (headId, totalCommits).
 *
 * @example
 * ```typescript
 * const service = new L1SettlementService({
 *   network: 'preprod',
 *   anchorProvider: blockfrostProvider,
 * });
 *
 * // Settle final state to L1
 * const result = await service.settleToL1(finalDatum, headId, {
 *   agentId: 'agent-001',
 *   sessionId: 'session-abc123',
 * });
 *
 * // Wait for confirmation
 * const confirmed = await service.waitForConfirmation(result.l1TxHash);
 * ```
 */
export class L1SettlementService {
  private readonly config: Required<Omit<L1SettlementConfig, 'retryConfig'>> & {
    retryConfig: RetryConfig;
  };

  constructor(config: L1SettlementConfig) {
    this.config = {
      network: config.network,
      anchorProvider: config.anchorProvider,
      confirmationBlocks: config.confirmationBlocks ?? DEFAULT_CONFIRMATION_BLOCKS,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      retryConfig: config.retryConfig ?? DEFAULT_RETRY_CONFIG,
    };
  }

  /**
   * Settle the final Hydra Head state to L1.
   *
   * Creates an anchor entry containing the final accumulator state and submits
   * it to L1 with retry logic. Does NOT wait for confirmation - use
   * waitForConfirmation() separately if needed.
   *
   * @param finalState - Final commitment datum from the Hydra Head
   * @param headId - Hydra Head identifier
   * @param metadata - Optional metadata for the anchor entry
   * @returns Settlement result with L1 transaction hash and anchor entry
   * @throws HydraBatcherException on submission failure after retries
   */
  async settleToL1(
    finalState: CommitmentDatum,
    headId: string,
    metadata?: SettlementMetadata
  ): Promise<SettlementResult> {
    // Validate provider is ready
    const isReady = await this.config.anchorProvider.isReady();
    if (!isReady) {
      throw new HydraBatcherException(
        HydraBatcherError.L1_SUBMISSION_FAILED,
        "Anchor provider is not ready"
      );
    }

    // Validate network matches
    const providerNetwork = this.config.anchorProvider.getNetwork();
    if (providerNetwork !== this.config.network) {
      throw new HydraBatcherException(
        HydraBatcherError.L1_SUBMISSION_FAILED,
        `Network mismatch: service configured for ${this.config.network}, provider is ${providerNetwork}`
      );
    }

    // Build anchor entry
    const anchorEntry = this.buildAnchorEntry(finalState, headId, metadata);

    // Submit with retry logic
    const txHash = await this.submitWithRetry(anchorEntry);

    // Calculate total items from batch history
    const totalItems = finalState.batchHistory.reduce(
      (sum, entry) => sum + entry.itemCount,
      0
    );

    // Update anchor entry with actual tx hash
    const finalAnchorEntry: AnchorEntry = {
      ...anchorEntry,
      l2Metadata: {
        ...anchorEntry.l2Metadata!,
        settlementTxHash: txHash,
      },
    };

    return {
      l1TxHash: txHash,
      finalAccumulatorRoot: finalState.accumulatorRoot,
      totalCommits: finalState.commitCount,
      totalItems,
      anchorEntry: finalAnchorEntry,
      fanoutUtxos: [], // Populated by head manager during actual fanout
    };
  }

  /**
   * Build an anchor entry from commitment state.
   *
   * Creates an AnchorEntry compatible with the anchors-cardano package,
   * using the poi-anchor-v2 schema with l2Metadata for Hydra-specific info.
   *
   * @param state - Commitment datum to anchor
   * @param headId - Hydra Head identifier
   * @param metadata - Optional metadata to include
   * @returns Complete anchor entry ready for submission
   */
  buildAnchorEntry(
    state: CommitmentDatum,
    headId: string,
    metadata?: SettlementMetadata
  ): AnchorEntry {
    const timestamp = new Date().toISOString();

    // Build the anchor entry
    const entry: AnchorEntry = {
      schema: "poi-anchor-v2",
      rootHash: state.accumulatorRoot,
      merkleRoot: state.latestBatchRoot,
      manifestHash: this.computeManifestHash(state, headId),
      storageUri: metadata?.storageUri ?? "",
      agentId: metadata?.agentId ?? "hydra-batcher",
      sessionId: metadata?.sessionId ?? headId,
      timestamp,
      l2Metadata: {
        headId,
        totalCommits: state.commitCount,
        settlementTxHash: "", // Will be updated after submission
      },
    };

    return entry;
  }

  /**
   * Wait for L1 transaction confirmation.
   *
   * Polls the anchor provider until the transaction reaches the required
   * number of confirmations or timeout occurs.
   *
   * @param txHash - Transaction hash to wait for
   * @param timeoutMs - Optional override for timeout (default from config)
   * @param options - Optional wait options (poll interval, progress callback)
   * @returns True if confirmed within timeout, false if timed out
   * @throws HydraBatcherException on provider errors
   */
  async waitForConfirmation(
    txHash: string,
    timeoutMs?: number,
    options?: WaitOptions
  ): Promise<boolean> {
    const timeout = timeoutMs ?? this.config.timeoutMs;
    const pollInterval = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const confirmations = await this.config.anchorProvider.getConfirmations(txHash);

        // Invoke progress callback if provided
        if (options?.onProgress) {
          options.onProgress(confirmations);
        }

        if (confirmations >= this.config.confirmationBlocks) {
          return true;
        }

        // Wait before next poll
        await this.sleep(pollInterval);
      } catch (error) {
        // Log error but continue polling
        console.warn(`Error checking confirmations for ${txHash}:`, error);
        await this.sleep(pollInterval);
      }
    }

    // Timed out
    return false;
  }

  /**
   * Get the current configuration.
   */
  getConfig(): Readonly<L1SettlementConfig> {
    return { ...this.config };
  }

  // =============================================================================
  // PRIVATE METHODS
  // =============================================================================

  /**
   * Submit anchor with retry logic.
   */
  private async submitWithRetry(entry: AnchorEntry): Promise<string> {
    const { maxRetries, initialDelayMs, maxDelayMs, backoffMultiplier } =
      this.config.retryConfig;

    let lastError: Error | undefined;
    let delay = initialDelayMs;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const txHash = await this.config.anchorProvider.submitAnchor(entry);
        return txHash;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < maxRetries) {
          // Wait before retry with exponential backoff
          await this.sleep(delay);
          delay = Math.min(delay * backoffMultiplier, maxDelayMs);
        }
      }
    }

    throw new HydraBatcherException(
      HydraBatcherError.L1_SUBMISSION_FAILED,
      `Failed to submit anchor after ${maxRetries + 1} attempts: ${lastError?.message}`,
      lastError
    );
  }

  /**
   * Compute manifest hash from commitment state.
   * Creates a deterministic hash of the state for the manifest field.
   */
  private computeManifestHash(state: CommitmentDatum, headId: string): string {
    // Create a canonical representation of the state
    const canonical = JSON.stringify({
      headId,
      accumulatorRoot: state.accumulatorRoot,
      commitCount: state.commitCount,
      latestBatchRoot: state.latestBatchRoot,
      latestBatchTimestamp: state.latestBatchTimestamp,
      batchHistoryLength: state.batchHistory.length,
    });

    // Simple hash using string code points
    // In production, would use a proper hash function
    let hash = 0;
    for (let i = 0; i < canonical.length; i++) {
      const char = canonical.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }

    return Math.abs(hash).toString(16).padStart(64, "0");
  }

  /**
   * Sleep for the specified duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// =============================================================================
// MOCK ANCHOR PROVIDER (FOR TESTING)
// =============================================================================

/**
 * Options for creating a mock anchor provider.
 */
export interface MockAnchorProviderOptions {
  /**
   * Network to simulate.
   * @default 'preprod'
   */
  network?: CardanoNetwork;

  /**
   * Whether the provider should report as ready.
   * @default true
   */
  isReady?: boolean;

  /**
   * Simulated delay for submission in milliseconds.
   * @default 100
   */
  submitDelayMs?: number;

  /**
   * Number of confirmations to return.
   * Can be a function for dynamic behavior.
   * @default 10
   */
  confirmations?: number | ((txHash: string) => number);

  /**
   * Error to throw on submission.
   * If set, all submissions will fail with this error.
   */
  submitError?: Error;

  /**
   * Callback invoked when anchor is submitted.
   */
  onSubmit?: (entry: AnchorEntry) => void;
}

/**
 * Mock anchor provider for testing.
 *
 * Simulates L1 anchor submission without requiring actual blockchain connection.
 *
 * @example
 * ```typescript
 * const mockProvider = createMockAnchorProvider({
 *   network: 'preprod',
 *   confirmations: 10,
 * });
 *
 * const service = new L1SettlementService({
 *   network: 'preprod',
 *   anchorProvider: mockProvider,
 * });
 * ```
 */
export function createMockAnchorProvider(
  options: MockAnchorProviderOptions = {}
): AnchorProvider {
  const {
    network = "preprod",
    isReady = true,
    submitDelayMs = 100,
    confirmations = 10,
    submitError,
    onSubmit,
  } = options;

  let submissionCount = 0;
  const submissions: Map<string, AnchorEntry> = new Map();

  return {
    async submitAnchor(entry: AnchorEntry): Promise<string> {
      if (submitError) {
        throw submitError;
      }

      // Simulate network delay
      await new Promise(resolve => setTimeout(resolve, submitDelayMs));

      // Generate mock tx hash
      submissionCount++;
      const txHash = `mock_tx_${submissionCount}_${Date.now().toString(16)}`.padEnd(64, "0").slice(0, 64);

      // Store submission
      submissions.set(txHash, entry);

      // Invoke callback
      if (onSubmit) {
        onSubmit(entry);
      }

      return txHash;
    },

    async getConfirmations(txHash: string): Promise<number> {
      if (!submissions.has(txHash)) {
        return 0;
      }

      if (typeof confirmations === "function") {
        return confirmations(txHash);
      }

      return confirmations;
    },

    async isReady(): Promise<boolean> {
      return isReady;
    },

    getNetwork(): CardanoNetwork {
      return network;
    },
  };
}

// =============================================================================
// CONVENIENCE FUNCTIONS
// =============================================================================

/**
 * Settle commitment state to L1 and wait for confirmation.
 *
 * Convenience function that combines settleToL1 and waitForConfirmation.
 *
 * @param service - L1SettlementService instance
 * @param finalState - Final commitment datum
 * @param headId - Hydra Head identifier
 * @param metadata - Optional settlement metadata
 * @param waitOptions - Optional wait options
 * @returns Settlement result if confirmed, throws on timeout or failure
 */
export async function settleAndConfirm(
  service: L1SettlementService,
  finalState: CommitmentDatum,
  headId: string,
  metadata?: SettlementMetadata,
  waitOptions?: WaitOptions
): Promise<SettlementResult> {
  const result = await service.settleToL1(finalState, headId, metadata);

  const confirmed = await service.waitForConfirmation(
    result.l1TxHash,
    undefined,
    waitOptions
  );

  if (!confirmed) {
    throw new HydraBatcherException(
      HydraBatcherError.SETTLEMENT_TIMEOUT,
      `Settlement transaction ${result.l1TxHash} did not confirm within timeout`
    );
  }

  return result;
}
