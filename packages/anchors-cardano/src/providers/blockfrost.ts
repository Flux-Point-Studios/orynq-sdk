/**
 * @fileoverview Blockfrost provider for Cardano anchor verification.
 *
 * Location: packages/anchors-cardano/src/providers/blockfrost.ts
 *
 * This module implements the AnchorChainProvider interface using the Blockfrost
 * API service. It provides methods to fetch transaction metadata and info for
 * verifying PoI anchors stored on the Cardano blockchain.
 *
 * Key features:
 * - Fetches transaction metadata from Blockfrost API
 * - Retrieves transaction info including block height and confirmations
 * - Supports mainnet, preprod, and preview networks
 * - Configurable timeout, retries, and injectable fetch function
 * - Robust error handling with descriptive messages
 *
 * Used by:
 * - src/anchor-verifier.ts: Uses provider to verify anchors
 * - Application code needing to read anchor data from Cardano
 *
 * @example
 * ```typescript
 * import { createBlockfrostProvider } from "./providers/blockfrost.js";
 *
 * const provider = createBlockfrostProvider({
 *   projectId: "mainnetXXXXXXXX",
 *   network: "mainnet",
 *   timeout: 10000,
 * });
 *
 * const metadata = await provider.getTxMetadata(txHash);
 * const txInfo = await provider.getTxInfo(txHash);
 * console.log("Network:", provider.getNetworkId());
 * ```
 *
 * @see https://blockfrost.io/
 * @see https://docs.blockfrost.io/
 */

import type {
  AnchorChainProvider,
  BlockfrostConfig,
  TxInfo,
  CardanoNetwork,
} from "../types.js";
import { POI_METADATA_LABEL } from "../types.js";

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Default request timeout in milliseconds.
 */
const DEFAULT_TIMEOUT = 30000;

/**
 * Default number of retry attempts for transient failures.
 */
const DEFAULT_RETRIES = 3;

/**
 * Base delay for exponential backoff (milliseconds).
 */
const BASE_BACKOFF_DELAY = 1000;

/**
 * Maximum jitter to add to backoff delay (milliseconds).
 */
const MAX_JITTER = 500;

/**
 * Blockfrost API base URLs by network.
 */
const BLOCKFROST_BASE_URLS: Record<CardanoNetwork, string> = {
  mainnet: "https://cardano-mainnet.blockfrost.io/api/v0",
  preprod: "https://cardano-preprod.blockfrost.io/api/v0",
  preview: "https://cardano-preview.blockfrost.io/api/v0",
};

// =============================================================================
// URL HELPER
// =============================================================================

/**
 * Get the Blockfrost API base URL for a network.
 *
 * @param network - Cardano network identifier
 * @returns Base URL for the Blockfrost API on that network
 *
 * @example
 * ```typescript
 * const url = getBlockfrostBaseUrl("mainnet");
 * // => "https://cardano-mainnet.blockfrost.io/api/v0"
 * ```
 */
export function getBlockfrostBaseUrl(network: CardanoNetwork): string {
  return BLOCKFROST_BASE_URLS[network];
}

// =============================================================================
// ERROR TYPES
// =============================================================================

/**
 * Error thrown when Blockfrost API requests fail.
 */
export class BlockfrostError extends Error {
  /**
   * HTTP status code from the API response.
   */
  readonly statusCode: number;

  /**
   * Error code from Blockfrost (if available).
   */
  readonly errorCode?: string;

  constructor(message: string, statusCode: number, errorCode?: string) {
    super(message);
    this.name = "BlockfrostError";
    this.statusCode = statusCode;
    if (errorCode !== undefined) {
      this.errorCode = errorCode;
    }
  }
}

// =============================================================================
// INTERNAL TYPES
// =============================================================================

/**
 * Blockfrost transaction metadata response item.
 */
interface BlockfrostMetadataItem {
  label: string;
  json_metadata: unknown;
}

/**
 * Blockfrost transaction response structure.
 */
interface BlockfrostTxResponse {
  hash: string;
  block: string;
  block_height: number;
  slot: number;
  block_time: number;
}

/**
 * Blockfrost block tip response structure.
 */
interface BlockfrostBlockTip {
  slot: number;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Sleep for a specified duration.
 *
 * @param ms - Milliseconds to sleep
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay with jitter.
 *
 * @param attempt - Current attempt number (0-indexed)
 * @returns Delay in milliseconds
 */
function calculateBackoff(attempt: number): number {
  const exponentialDelay = BASE_BACKOFF_DELAY * Math.pow(2, attempt);
  const jitter = Math.random() * MAX_JITTER;
  return exponentialDelay + jitter;
}

/**
 * Normalize a transaction hash by removing any 0x prefix.
 *
 * @param txHash - Transaction hash to normalize
 * @returns Normalized transaction hash (hex without prefix)
 */
function normalizeTxHash(txHash: string): string {
  return txHash.startsWith("0x") ? txHash.slice(2) : txHash;
}

// =============================================================================
// PROVIDER IMPLEMENTATION
// =============================================================================

/**
 * Create a Blockfrost provider for Cardano anchor verification.
 *
 * The provider implements the AnchorChainProvider interface, allowing
 * it to be used with the anchor verification functions. It supports
 * configurable timeout, retries with exponential backoff, and an
 * injectable fetch function for testing and edge runtime compatibility.
 *
 * @param config - Blockfrost configuration with projectId and network
 * @returns AnchorChainProvider implementation for Blockfrost
 *
 * @throws {Error} If projectId is empty or invalid
 * @throws {Error} If network is invalid
 *
 * @example
 * ```typescript
 * // Basic usage with defaults
 * const provider = createBlockfrostProvider({
 *   projectId: "mainnetXXXXXXXX",
 *   network: "mainnet",
 * });
 *
 * // With custom configuration
 * const provider = createBlockfrostProvider({
 *   projectId: "preprodXXXXXXXX",
 *   network: "preprod",
 *   timeout: 10000,
 *   retries: 5,
 *   fetchFn: customFetch,
 * });
 *
 * // Fetch metadata
 * const metadata = await provider.getTxMetadata(txHash);
 * if (metadata) {
 *   console.log("Found metadata:", metadata);
 * }
 *
 * // Get transaction info
 * const txInfo = await provider.getTxInfo(txHash);
 * if (txInfo) {
 *   console.log("Block height:", txInfo.blockHeight);
 *   console.log("Confirmations:", txInfo.confirmations);
 * }
 * ```
 */
export function createBlockfrostProvider(
  config: BlockfrostConfig
): AnchorChainProvider {
  // Validate configuration
  if (!config.projectId || typeof config.projectId !== "string") {
    throw new Error("Blockfrost projectId is required and must be a non-empty string");
  }

  if (!config.network) {
    throw new Error("Blockfrost network is required");
  }

  const validNetworks: CardanoNetwork[] = ["mainnet", "preprod", "preview"];
  if (!validNetworks.includes(config.network)) {
    throw new Error(
      `Invalid network '${config.network}'. Must be one of: ${validNetworks.join(", ")}`
    );
  }

  // Extract configuration with defaults
  const projectId = config.projectId;
  const network = config.network;
  const timeout = config.timeout ?? DEFAULT_TIMEOUT;
  const maxRetries = config.retries ?? DEFAULT_RETRIES;
  const fetchFn = config.fetchFn ?? globalThis.fetch;

  // Compute base URL
  const baseUrl = getBlockfrostBaseUrl(network);

  /**
   * Make an authenticated request to the Blockfrost API.
   *
   * Handles timeout via AbortController, retries with exponential backoff,
   * and maps common error responses to descriptive messages.
   *
   * @param endpoint - API endpoint (relative to base URL)
   * @returns Parsed JSON response
   * @throws {BlockfrostError} On API errors
   * @throws {Error} On network errors or timeout
   */
  async function blockfrostRequest<T>(endpoint: string): Promise<T> {
    const url = `${baseUrl}${endpoint}`;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetchFn(url, {
          method: "GET",
          headers: {
            project_id: projectId,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Handle successful responses
        if (response.ok) {
          return (await response.json()) as T;
        }

        // Handle error responses
        const status = response.status;

        // Parse error body if possible
        let errorBody: { message?: string; error?: string } = {};
        try {
          errorBody = await response.json();
        } catch {
          // Ignore JSON parse errors for error response
        }

        // Map common error codes to descriptive messages
        switch (status) {
          case 400:
            throw new BlockfrostError(
              errorBody.message || "Bad request to Blockfrost API",
              status
            );

          case 403:
            throw new BlockfrostError("Invalid Blockfrost project ID", status);

          case 404:
            // Return special marker for not found (handled by caller)
            throw new BlockfrostError("Resource not found", status, "NOT_FOUND");

          case 418:
            throw new BlockfrostError(
              "Blockfrost IP address is banned. Check your usage.",
              status
            );

          case 429:
            // Rate limit - should retry after backoff
            lastError = new BlockfrostError(
              "Blockfrost rate limit exceeded",
              status,
              "RATE_LIMITED"
            );
            // Fall through to retry logic
            break;

          case 500:
            lastError = new BlockfrostError(
              "Blockfrost internal server error",
              status
            );
            break;

          default:
            throw new BlockfrostError(
              errorBody.message ||
                `Blockfrost API error (status ${status})`,
              status
            );
        }
      } catch (error) {
        clearTimeout(timeoutId);

        // Re-throw BlockfrostError unless it's a retryable error
        if (error instanceof BlockfrostError) {
          if (error.errorCode === "NOT_FOUND") {
            throw error; // Don't retry 404s
          }
          if (error.errorCode !== "RATE_LIMITED" && error.statusCode !== 500) {
            throw error; // Don't retry non-retryable errors
          }
          lastError = error;
        } else if (error instanceof Error) {
          // Handle abort/timeout
          if (error.name === "AbortError") {
            lastError = new Error(`Request timeout after ${timeout}ms`);
          } else {
            // Network error - may be transient
            lastError = new Error(`Network error: ${error.message}`);
          }
        } else {
          lastError = new Error("Unknown error occurred");
        }
      }

      // Wait before retrying (except on last attempt)
      if (attempt < maxRetries) {
        const backoffDelay = calculateBackoff(attempt);
        await sleep(backoffDelay);
      }
    }

    // All retries exhausted
    throw lastError || new Error("Request failed after all retries");
  }

  /**
   * Get the current blockchain tip slot.
   * Used to calculate confirmations.
   *
   * @returns Current tip slot number
   */
  async function getCurrentSlot(): Promise<number> {
    const tip = await blockfrostRequest<BlockfrostBlockTip>("/blocks/latest");
    return tip.slot;
  }

  // Return the provider implementation
  return {
    /**
     * Get transaction metadata by hash.
     *
     * Fetches the metadata for a specific transaction and extracts
     * the data under label 2222 (POI_METADATA_LABEL).
     *
     * @param txHash - Transaction hash (hex-encoded, with or without 0x prefix)
     * @returns Metadata object for label 2222, or null if not found
     * @throws {Error} On network or API errors (not for missing transactions)
     *
     * @example
     * ```typescript
     * const metadata = await provider.getTxMetadata(
     *   "abc123def456..."
     * );
     * if (metadata) {
     *   console.log("Anchor schema:", metadata.schema);
     * } else {
     *   console.log("No metadata found");
     * }
     * ```
     */
    async getTxMetadata(txHash: string): Promise<Record<string, unknown> | null> {
      if (!txHash || typeof txHash !== "string") {
        throw new Error("Transaction hash is required");
      }

      const normalizedHash = normalizeTxHash(txHash);

      try {
        // Fetch transaction metadata from Blockfrost
        // Returns array: [{ label: "2222", json_metadata: {...} }, ...]
        const metadataItems = await blockfrostRequest<BlockfrostMetadataItem[]>(
          `/txs/${normalizedHash}/metadata`
        );

        // Handle empty metadata array
        if (!Array.isArray(metadataItems) || metadataItems.length === 0) {
          return null;
        }

        // Find the item with label 2222
        const label2222Item = metadataItems.find(
          (item) => item.label === POI_METADATA_LABEL.toString()
        );

        if (!label2222Item || label2222Item.json_metadata === undefined) {
          return null;
        }

        // Return the metadata in the expected format:
        // { "2222": { schema: "poi-anchor-v1", anchors: [...] } }
        return {
          [POI_METADATA_LABEL.toString()]: label2222Item.json_metadata,
        };
      } catch (error) {
        // Handle 404 - transaction not found or has no metadata
        if (error instanceof BlockfrostError && error.errorCode === "NOT_FOUND") {
          return null;
        }
        throw error;
      }
    },

    /**
     * Get transaction info by hash.
     *
     * Fetches transaction details including block height, slot, and
     * calculates approximate confirmations based on current tip.
     *
     * @param txHash - Transaction hash (hex-encoded, with or without 0x prefix)
     * @returns Transaction info or null if not found
     * @throws {Error} On network or API errors (not for missing transactions)
     *
     * @example
     * ```typescript
     * const txInfo = await provider.getTxInfo("abc123def456...");
     * if (txInfo) {
     *   console.log("Block height:", txInfo.blockHeight);
     *   console.log("Confirmations:", txInfo.confirmations);
     *   console.log("Timestamp:", txInfo.timestamp);
     * }
     * ```
     */
    async getTxInfo(txHash: string): Promise<TxInfo | null> {
      if (!txHash || typeof txHash !== "string") {
        throw new Error("Transaction hash is required");
      }

      const normalizedHash = normalizeTxHash(txHash);

      try {
        // Fetch transaction details
        const txResponse = await blockfrostRequest<BlockfrostTxResponse>(
          `/txs/${normalizedHash}`
        );

        // Fetch current tip for confirmations calculation
        let currentSlot: number;
        try {
          currentSlot = await getCurrentSlot();
        } catch {
          // If we can't get current slot, use tx slot (0 confirmations)
          currentSlot = txResponse.slot;
        }

        // Calculate approximate confirmations based on slot difference
        // Each slot is roughly 1 second on Cardano
        const slotDiff = currentSlot - txResponse.slot;
        // Convert slot difference to approximate block count
        // Cardano produces ~1 block per 20 slots on average
        const confirmations = Math.max(0, Math.floor(slotDiff / 20));

        // Map response to TxInfo
        const txInfo: TxInfo = {
          txHash: txResponse.hash,
          blockHash: txResponse.block,
          blockHeight: txResponse.block_height,
          slot: txResponse.slot,
          timestamp: new Date(txResponse.block_time * 1000).toISOString(),
          confirmations,
        };

        return txInfo;
      } catch (error) {
        // Handle 404 - transaction not found
        if (error instanceof BlockfrostError && error.errorCode === "NOT_FOUND") {
          return null;
        }
        throw error;
      }
    },

    /**
     * Get the network this provider is connected to.
     *
     * @returns Network identifier (mainnet, preprod, or preview)
     *
     * @example
     * ```typescript
     * console.log("Connected to:", provider.getNetworkId());
     * // => "mainnet"
     * ```
     */
    getNetworkId(): CardanoNetwork {
      return network;
    },
  };
}
