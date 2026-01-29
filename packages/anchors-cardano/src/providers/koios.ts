/**
 * @fileoverview Koios blockchain provider for Cardano anchor verification.
 *
 * Location: packages/anchors-cardano/src/providers/koios.ts
 *
 * This module implements the AnchorChainProvider interface using the Koios API,
 * a distributed, community-operated Cardano API. It provides functionality to
 * fetch transaction metadata and information for verifying PoI anchors stored
 * under metadata label 2222.
 *
 * Features:
 * - Transaction metadata retrieval via POST /tx_metadata
 * - Transaction info retrieval via POST /tx_info
 * - Current tip retrieval for confirmation calculation
 * - Configurable timeout, retries, and fetch function injection
 * - Support for optional API token authentication
 * - Proper error handling for rate limits and auth failures
 *
 * Used by:
 * - src/anchor-verifier.ts: For verifying anchors on-chain
 * - Consumer applications that need Koios-based verification
 *
 * @see https://www.koios.rest/ for API documentation
 * @see https://api.koios.rest/ for API reference
 */

import type {
  AnchorChainProvider,
  KoiosConfig,
  TxInfo,
  CardanoNetwork,
} from "../types.js";
import { POI_METADATA_LABEL } from "../types.js";

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Koios API base URLs for each Cardano network.
 */
const KOIOS_BASE_URLS: Record<CardanoNetwork, string> = {
  mainnet: "https://api.koios.rest/api/v1",
  preprod: "https://preprod.koios.rest/api/v1",
  preview: "https://preview.koios.rest/api/v1",
};

/**
 * Default request timeout in milliseconds.
 */
const DEFAULT_TIMEOUT = 30000;

/**
 * Default number of retry attempts for transient failures.
 */
const DEFAULT_RETRIES = 3;

/**
 * Base delay for exponential backoff in milliseconds.
 */
const BACKOFF_BASE_DELAY = 1000;

/**
 * Maximum jitter added to backoff delay in milliseconds.
 */
const BACKOFF_MAX_JITTER = 500;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get the Koios API base URL for a network.
 *
 * @param network - The Cardano network to get the URL for.
 * @returns The base URL for the Koios API on that network.
 *
 * @example
 * ```typescript
 * const url = getKoiosBaseUrl("mainnet");
 * // Returns: "https://api.koios.rest/api/v1"
 *
 * const preprodUrl = getKoiosBaseUrl("preprod");
 * // Returns: "https://preprod.koios.rest/api/v1"
 * ```
 */
export function getKoiosBaseUrl(network: CardanoNetwork): string {
  return KOIOS_BASE_URLS[network];
}

/**
 * Calculate exponential backoff delay with jitter.
 *
 * @param attempt - Current attempt number (0-indexed).
 * @returns Delay in milliseconds.
 */
function calculateBackoffDelay(attempt: number): number {
  const exponentialDelay = BACKOFF_BASE_DELAY * Math.pow(2, attempt);
  const jitter = Math.random() * BACKOFF_MAX_JITTER;
  return exponentialDelay + jitter;
}

/**
 * Sleep for a specified duration.
 *
 * @param ms - Duration in milliseconds.
 * @returns Promise that resolves after the delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalize a transaction hash by removing any "0x" prefix and converting to lowercase.
 *
 * @param txHash - Transaction hash to normalize.
 * @returns Normalized 64-character lowercase hex string.
 */
function normalizeTxHash(txHash: string): string {
  let normalized = txHash.toLowerCase();
  if (normalized.startsWith("0x")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

// =============================================================================
// KOIOS RESPONSE TYPES
// =============================================================================

/**
 * Koios transaction metadata response item.
 */
interface KoiosTxMetadataResponse {
  tx_hash: string;
  metadata: Record<string, unknown> | null;
}

/**
 * Koios transaction info response item.
 */
interface KoiosTxInfoResponse {
  tx_hash: string;
  block_hash: string;
  block_height: number;
  absolute_slot: number;
  tx_timestamp: number; // Unix timestamp
  // Other fields omitted - we only need these
}

/**
 * Koios tip response.
 */
interface KoiosTipResponse {
  block_no: number;
  // Other fields omitted
}

// =============================================================================
// ERROR HANDLING
// =============================================================================

/**
 * Custom error class for Koios API errors.
 */
export class KoiosError extends Error {
  /** HTTP status code if applicable. */
  public readonly statusCode: number | undefined;

  /** Whether this error is retryable. */
  public readonly retryable: boolean;

  constructor(message: string, statusCode?: number, retryable = false) {
    super(message);
    this.name = "KoiosError";
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

/**
 * Handle HTTP response errors from Koios API.
 *
 * @param response - Fetch response object.
 * @throws KoiosError with appropriate message.
 */
async function handleHttpError(response: Response): Promise<never> {
  const status = response.status;

  if (status === 401 || status === 403) {
    throw new KoiosError(
      "Invalid or missing Koios API token",
      status,
      false
    );
  }

  if (status === 429) {
    throw new KoiosError(
      "Koios rate limit exceeded",
      status,
      true
    );
  }

  if (status >= 500) {
    throw new KoiosError(
      `Koios server error: ${status}`,
      status,
      true
    );
  }

  // Try to get error message from response body
  let errorMessage = `Koios API error: ${status}`;
  try {
    const body = await response.text();
    if (body) {
      errorMessage = `Koios API error (${status}): ${body}`;
    }
  } catch {
    // Ignore body parse errors
  }

  throw new KoiosError(errorMessage, status, false);
}

// =============================================================================
// KOIOS PROVIDER IMPLEMENTATION
// =============================================================================

/**
 * Create a Koios provider for Cardano anchor verification.
 *
 * The Koios provider implements the AnchorChainProvider interface using the
 * Koios distributed Cardano API. It supports all three Cardano networks
 * (mainnet, preprod, preview) and provides configurable timeout, retry,
 * and authentication options.
 *
 * @param config - Koios configuration with network and optional API token.
 * @returns AnchorChainProvider implementation for Koios.
 *
 * @example
 * ```typescript
 * // Basic usage with preprod network
 * const koios = createKoiosProvider({
 *   network: "preprod",
 * });
 *
 * // With API token for higher rate limits
 * const authenticatedKoios = createKoiosProvider({
 *   network: "mainnet",
 *   apiToken: "your-api-token",
 *   timeout: 10000,
 *   retries: 5,
 * });
 *
 * // Fetch transaction metadata
 * const metadata = await koios.getTxMetadata(txHash);
 * if (metadata) {
 *   console.log("Found metadata:", metadata);
 * }
 *
 * // Fetch transaction info
 * const txInfo = await koios.getTxInfo(txHash);
 * if (txInfo) {
 *   console.log("Block height:", txInfo.blockHeight);
 *   console.log("Confirmations:", txInfo.confirmations);
 * }
 *
 * // Get network identifier
 * console.log("Network:", koios.getNetworkId());
 * ```
 *
 * @example
 * ```typescript
 * // Dependency injection for testing
 * const mockFetch = jest.fn().mockResolvedValue({
 *   ok: true,
 *   json: async () => [{ tx_hash: "...", metadata: {...} }],
 * });
 *
 * const testKoios = createKoiosProvider({
 *   network: "preprod",
 *   fetchFn: mockFetch,
 * });
 * ```
 */
export function createKoiosProvider(config: KoiosConfig): AnchorChainProvider {
  const {
    network,
    apiToken,
    fetchFn = fetch,
    timeout = DEFAULT_TIMEOUT,
    retries = DEFAULT_RETRIES,
  } = config;

  const baseUrl = getKoiosBaseUrl(network);

  /**
   * Build headers for Koios API requests.
   *
   * @returns Headers object with Content-Type and optional Authorization.
   */
  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (apiToken) {
      headers["Authorization"] = `Bearer ${apiToken}`;
    }

    return headers;
  }

  /**
   * Make a request to the Koios API with retry logic.
   *
   * @param endpoint - API endpoint path (e.g., "/tx_metadata").
   * @param body - Request body to send as JSON.
   * @returns Parsed JSON response.
   * @throws KoiosError on failure after all retries exhausted.
   */
  async function makeRequest<T>(endpoint: string, body: unknown): Promise<T> {
    const url = `${baseUrl}${endpoint}`;
    const headers = buildHeaders();

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        // Create abort controller for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
          const response = await fetchFn(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            await handleHttpError(response);
          }

          return (await response.json()) as T;
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if error is retryable
        const isRetryable =
          error instanceof KoiosError
            ? error.retryable
            : lastError.name === "AbortError" ||
              lastError.message.includes("network") ||
              lastError.message.includes("fetch");

        // Don't retry non-retryable errors or if we've exhausted retries
        if (!isRetryable || attempt >= retries) {
          break;
        }

        // Wait with exponential backoff before retrying
        await sleep(calculateBackoffDelay(attempt));
      }
    }

    // All retries exhausted, throw the last error
    if (lastError instanceof KoiosError) {
      throw lastError;
    }

    throw new KoiosError(
      `Koios request failed: ${lastError?.message || "Unknown error"}`,
      undefined,
      false
    );
  }

  /**
   * Fetch the current blockchain tip to calculate confirmations.
   *
   * @returns Current block height.
   * @throws KoiosError on failure.
   */
  async function getCurrentTipHeight(): Promise<number> {
    const url = `${baseUrl}/tip`;
    const headers = buildHeaders();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetchFn(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        await handleHttpError(response);
      }

      const data = (await response.json()) as KoiosTipResponse[];

      if (!Array.isArray(data) || data.length === 0) {
        throw new KoiosError("Invalid tip response from Koios", undefined, true);
      }

      const tipData = data[0];
      if (tipData === undefined) {
        throw new KoiosError("Invalid tip response from Koios", undefined, true);
      }

      return tipData.block_no;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // =========================================================================
  // AnchorChainProvider Implementation
  // =========================================================================

  return {
    /**
     * Get transaction metadata by hash.
     *
     * Fetches metadata for a transaction and extracts the content under
     * label 2222 if present. Returns null if the transaction is not found
     * or has no metadata under that label.
     *
     * @param txHash - Transaction hash (hex-encoded, with or without 0x prefix).
     * @returns Metadata object under label 2222 or null if not found.
     * @throws KoiosError on network or API errors.
     */
    async getTxMetadata(txHash: string): Promise<Record<string, unknown> | null> {
      const normalizedHash = normalizeTxHash(txHash);

      const requestBody = {
        _tx_hashes: [normalizedHash],
      };

      const response = await makeRequest<KoiosTxMetadataResponse[]>(
        "/tx_metadata",
        requestBody
      );

      // Empty array means transaction not found or no metadata
      if (!Array.isArray(response) || response.length === 0) {
        return null;
      }

      const txData = response[0];

      // Ensure txData exists (additional null check for TypeScript)
      if (txData === undefined) {
        return null;
      }

      // Check if metadata exists
      if (txData.metadata === null || typeof txData.metadata !== "object") {
        return null;
      }

      // Extract label 2222 metadata
      // Koios returns metadata with string keys
      const label2222 = txData.metadata[POI_METADATA_LABEL.toString()];

      if (label2222 === undefined || label2222 === null) {
        return null;
      }

      // Return the full metadata object with label 2222 content
      // This matches the expected format for parseAnchorMetadata
      return {
        [POI_METADATA_LABEL.toString()]: label2222,
      };
    },

    /**
     * Get transaction info by hash.
     *
     * Fetches detailed information about a transaction including block
     * context and calculates the current confirmation count by fetching
     * the chain tip.
     *
     * @param txHash - Transaction hash (hex-encoded, with or without 0x prefix).
     * @returns Transaction info or null if not found.
     * @throws KoiosError on network or API errors.
     */
    async getTxInfo(txHash: string): Promise<TxInfo | null> {
      const normalizedHash = normalizeTxHash(txHash);

      const requestBody = {
        _tx_hashes: [normalizedHash],
      };

      const response = await makeRequest<KoiosTxInfoResponse[]>(
        "/tx_info",
        requestBody
      );

      // Empty array means transaction not found
      if (!Array.isArray(response) || response.length === 0) {
        return null;
      }

      const txData = response[0];

      // Ensure txData exists (additional null check for TypeScript)
      if (txData === undefined) {
        return null;
      }

      // Fetch current tip to calculate confirmations
      const currentHeight = await getCurrentTipHeight();
      const confirmations = Math.max(0, currentHeight - txData.block_height);

      // Convert Unix timestamp to ISO string
      const timestamp = new Date(txData.tx_timestamp * 1000).toISOString();

      return {
        txHash: txData.tx_hash,
        blockHash: txData.block_hash,
        blockHeight: txData.block_height,
        slot: txData.absolute_slot,
        timestamp,
        confirmations,
      };
    },

    /**
     * Get the network this provider is connected to.
     *
     * @returns The Cardano network identifier.
     */
    getNetworkId(): CardanoNetwork {
      return network;
    },
  };
}
