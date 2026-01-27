/**
 * @summary Koios API provider implementation for Cardano blockchain data.
 *
 * This file implements the CardanoProvider interface using the Koios API
 * for UTxO fetching, protocol parameters, and transaction submission.
 *
 * Used by:
 * - CardanoNodePayer for blockchain data access
 *
 * @see https://api.koios.rest/
 */

import type { CardanoProvider, UTxO, ProtocolParameters } from "./interface.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration options for Koios provider.
 */
export interface KoiosConfig {
  /** Network to connect to (default: "mainnet") */
  network?: "mainnet" | "preprod";

  /** Custom base URL (overrides network setting) */
  baseUrl?: string;

  /** API key for authenticated requests (optional, increases rate limits) */
  apiKey?: string;

  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;

  /** Number of retries for failed requests (default: 3) */
  retries?: number;
}

// ---------------------------------------------------------------------------
// Koios API Response Types
// ---------------------------------------------------------------------------

/**
 * Koios UTxO asset response type.
 */
interface KoiosAsset {
  policy_id: string;
  asset_name: string;
  quantity: string;
}

/**
 * Koios UTxO response type.
 */
interface KoiosUtxo {
  tx_hash: string;
  tx_index: number;
  address: string;
  value: string;
  asset_list: KoiosAsset[];
  datum_hash: string | null;
  inline_datum: {
    bytes: string;
  } | null;
  reference_script: {
    hash: string;
  } | null;
}

/**
 * Koios protocol parameters response type.
 */
interface KoiosProtocolParams {
  min_fee_a: number;
  min_fee_b: number;
  max_tx_size: number;
  coins_per_utxo_size: string;
  pool_deposit: string;
  key_deposit: string;
  max_val_size: string;
  collateral_percent: number;
  max_collateral_inputs: number;
}

// ---------------------------------------------------------------------------
// Koios Provider Implementation
// ---------------------------------------------------------------------------

/**
 * Koios API provider for Cardano blockchain data.
 *
 * Provides access to UTxOs, protocol parameters, and transaction submission
 * through the Koios API.
 *
 * @example
 * ```typescript
 * const provider = new KoiosProvider({
 *   network: "mainnet",
 *   apiKey: "your-api-key", // Optional
 * });
 *
 * const utxos = await provider.getUtxos("addr1...");
 * ```
 */
export class KoiosProvider implements CardanoProvider {
  private readonly baseUrl: string;
  private readonly network: "mainnet" | "preprod";
  private readonly apiKey: string | undefined;
  private readonly timeout: number;
  private readonly retries: number;

  /**
   * Create a new Koios provider instance.
   *
   * @param config - Koios configuration
   */
  constructor(config: KoiosConfig = {}) {
    this.network = config.network ?? "mainnet";
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? 30000;
    this.retries = config.retries ?? 3;

    // Set base URL based on network or custom URL
    if (config.baseUrl !== undefined) {
      this.baseUrl = config.baseUrl;
    } else {
      this.baseUrl =
        this.network === "mainnet"
          ? "https://api.koios.rest/api/v1"
          : "https://preprod.koios.rest/api/v1";
    }
  }

  /**
   * Get the network ID for this provider.
   */
  getNetworkId(): "mainnet" | "preprod" {
    return this.network;
  }

  /**
   * Fetch all UTxOs for a given address.
   *
   * @param address - Bech32-encoded Cardano address
   * @returns Promise resolving to array of UTxOs
   */
  async getUtxos(address: string): Promise<UTxO[]> {
    // Validate address format (basic check)
    if (!address.startsWith("addr")) {
      throw new Error(`Invalid Cardano address format: ${address}`);
    }

    // Koios uses POST with JSON body for address UTxOs
    const response = await this.fetchWithRetry<KoiosUtxo[]>("/address_utxos", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        _addresses: [address],
        _extended: true,
      }),
    });

    // Handle empty response
    if (response === null || response.length === 0) {
      return [];
    }

    return response.map((utxo) => this.mapUtxo(utxo));
  }

  /**
   * Fetch current protocol parameters.
   *
   * @returns Promise resolving to protocol parameters
   */
  async getProtocolParameters(): Promise<ProtocolParameters> {
    const response = await this.fetchWithRetry<KoiosProtocolParams[]>("/epoch_params", {
      method: "GET",
    });

    if (response === null || response.length === 0) {
      throw new Error("Failed to fetch protocol parameters");
    }

    // Get the most recent epoch's parameters
    const data = response[0];

    if (data === undefined) {
      throw new Error("Protocol parameters response is empty");
    }

    return {
      minFeeA: data.min_fee_a,
      minFeeB: data.min_fee_b,
      maxTxSize: data.max_tx_size,
      coinsPerUtxoByte: parseInt(data.coins_per_utxo_size, 10),
      poolDeposit: parseInt(data.pool_deposit, 10),
      keyDeposit: parseInt(data.key_deposit, 10),
      maxValSize: parseInt(data.max_val_size, 10),
      collateralPercentage: data.collateral_percent,
      maxCollateralInputs: data.max_collateral_inputs,
    };
  }

  /**
   * Submit a signed transaction to the network.
   *
   * @param txCbor - Hex-encoded CBOR of the signed transaction
   * @returns Promise resolving to the transaction hash
   */
  async submitTx(txCbor: string): Promise<string> {
    // Validate hex format
    if (!/^[0-9a-fA-F]+$/.test(txCbor)) {
      throw new Error("Invalid transaction CBOR: must be hex-encoded");
    }

    const response = await this.fetchRaw("/submittx", {
      method: "POST",
      headers: {
        "Content-Type": "application/cbor",
      },
      body: Buffer.from(txCbor, "hex"),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Transaction submission failed: ${errorText}`);
    }

    // Koios returns the tx hash in the response
    const txHash = await response.text();
    return txHash.replace(/"/g, "").trim();
  }

  /**
   * Wait for a transaction to be confirmed on-chain.
   *
   * @param txHash - Transaction hash to monitor
   * @param timeout - Maximum time to wait in milliseconds
   * @returns Promise resolving to true if confirmed, false if timeout
   */
  async awaitTx(txHash: string, timeout = 120000): Promise<boolean> {
    const startTime = Date.now();
    const pollInterval = 5000; // 5 seconds between checks

    while (Date.now() - startTime < timeout) {
      try {
        // Use POST to query transaction status
        const response = await this.fetchRaw("/tx_info", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            _tx_hashes: [txHash],
          }),
        });

        if (response.ok) {
          const data = await response.json() as Array<{ tx_hash: string }>;
          if (Array.isArray(data) && data.length > 0) {
            return true;
          }
        }
      } catch {
        // Network error, continue polling
      }

      // Wait before next poll
      await this.sleep(pollInterval);
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Make a raw fetch request to Koios API.
   */
  private async fetchRaw(
    path: string,
    init?: RequestInit
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers: Record<string, string> = {
        ...(init?.headers as Record<string, string>),
      };

      // Add API key if provided
      if (this.apiKey !== undefined) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });

      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Make a fetch request with retries and JSON parsing.
   * Returns null for empty responses.
   */
  private async fetchWithRetry<T>(
    path: string,
    init?: RequestInit
  ): Promise<T | null> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.retries; attempt++) {
      try {
        const response = await this.fetchRaw(path, init);

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Koios API error (${response.status}): ${errorText}`);
        }

        const data = await response.json() as T;

        // Koios returns empty array for not found
        if (Array.isArray(data) && data.length === 0) {
          return null;
        }

        return data;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on client errors (4xx except 429)
        if (
          lastError.message.includes("API error (4") &&
          !lastError.message.includes("429")
        ) {
          throw lastError;
        }

        // Exponential backoff for retries
        if (attempt < this.retries - 1) {
          await this.sleep(Math.pow(2, attempt) * 1000);
        }
      }
    }

    throw lastError ?? new Error("Request failed after retries");
  }

  /**
   * Map Koios UTxO response to UTxO interface.
   */
  private mapUtxo(data: KoiosUtxo): UTxO {
    const assets: Record<string, bigint> = {};

    // Extract native assets
    for (const asset of data.asset_list) {
      // Format as "policyId + assetNameHex"
      const assetId = asset.policy_id + asset.asset_name;
      assets[assetId] = BigInt(asset.quantity);
    }

    const utxo: UTxO = {
      txHash: data.tx_hash,
      outputIndex: data.tx_index,
      address: data.address,
      lovelace: BigInt(data.value),
      assets,
    };

    // Only set optional fields if they have values
    if (data.datum_hash !== null) {
      utxo.datumHash = data.datum_hash;
    }
    if (data.inline_datum !== null) {
      utxo.datum = data.inline_datum.bytes;
    }
    if (data.reference_script !== null) {
      utxo.scriptRef = data.reference_script.hash;
    }

    return utxo;
  }

  /**
   * Sleep for a specified duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
