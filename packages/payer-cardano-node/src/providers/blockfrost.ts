/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-cardano-node/src/providers/blockfrost.ts
 * @summary Blockfrost API provider implementation for Cardano blockchain data.
 *
 * This file implements the CardanoProvider interface using the Blockfrost API
 * for UTxO fetching, protocol parameters, and transaction submission.
 *
 * Used by:
 * - CardanoNodePayer for blockchain data access
 *
 * @see https://docs.blockfrost.io/
 */

import type { CardanoProvider, UTxO, ProtocolParameters } from "./interface.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration options for Blockfrost provider.
 */
export interface BlockfrostConfig {
  /** Blockfrost project ID (API key) */
  projectId: string;

  /** Network to connect to (default: "mainnet") */
  network?: "mainnet" | "preprod";

  /** Custom base URL (overrides network setting) */
  baseUrl?: string;

  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;

  /** Number of retries for failed requests (default: 3) */
  retries?: number;
}

// ---------------------------------------------------------------------------
// Blockfrost API Response Types
// ---------------------------------------------------------------------------

/**
 * Blockfrost UTxO amount response type.
 */
interface BlockfrostAmount {
  unit: string;
  quantity: string;
}

/**
 * Blockfrost UTxO response type.
 */
interface BlockfrostUtxo {
  tx_hash: string;
  output_index: number;
  address: string;
  amount: BlockfrostAmount[];
  data_hash: string | null;
  inline_datum: string | null;
  reference_script_hash: string | null;
}

/**
 * Blockfrost protocol parameters response type.
 */
interface BlockfrostProtocolParams {
  min_fee_a: number;
  min_fee_b: number;
  max_tx_size: number;
  coins_per_utxo_size?: string;
  coins_per_utxo_word?: string;
  pool_deposit: string;
  key_deposit: string;
  max_val_size: number;
  collateral_percent: number;
  max_collateral_inputs: number;
}

// ---------------------------------------------------------------------------
// Blockfrost Provider Implementation
// ---------------------------------------------------------------------------

/**
 * Blockfrost API provider for Cardano blockchain data.
 *
 * Provides access to UTxOs, protocol parameters, and transaction submission
 * through the Blockfrost API.
 *
 * @example
 * ```typescript
 * const provider = new BlockfrostProvider({
 *   projectId: "mainnetXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
 *   network: "mainnet",
 * });
 *
 * const utxos = await provider.getUtxos("addr1...");
 * ```
 */
export class BlockfrostProvider implements CardanoProvider {
  private readonly baseUrl: string;
  private readonly projectId: string;
  private readonly network: "mainnet" | "preprod";
  private readonly timeout: number;
  private readonly retries: number;

  /**
   * Create a new Blockfrost provider instance.
   *
   * @param config - Blockfrost configuration
   */
  constructor(config: BlockfrostConfig) {
    this.projectId = config.projectId;
    this.network = config.network ?? "mainnet";
    this.timeout = config.timeout ?? 30000;
    this.retries = config.retries ?? 3;

    // Set base URL based on network or custom URL
    if (config.baseUrl !== undefined) {
      this.baseUrl = config.baseUrl;
    } else {
      this.baseUrl =
        this.network === "mainnet"
          ? "https://cardano-mainnet.blockfrost.io/api/v0"
          : "https://cardano-preprod.blockfrost.io/api/v0";
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

    const response = await this.fetchWithRetry<BlockfrostUtxo[]>(
      `/addresses/${address}/utxos`
    );

    // Handle empty address (no UTxOs)
    if (response === null) {
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
    const data = await this.fetchWithRetry<BlockfrostProtocolParams>(
      "/epochs/latest/parameters"
    );

    if (data === null) {
      throw new Error("Failed to fetch protocol parameters");
    }

    // Handle both coins_per_utxo_size (newer) and coins_per_utxo_word (older)
    const coinsPerUtxoByte = parseInt(
      data.coins_per_utxo_size ?? data.coins_per_utxo_word ?? "4310",
      10
    );

    return {
      minFeeA: data.min_fee_a,
      minFeeB: data.min_fee_b,
      maxTxSize: data.max_tx_size,
      coinsPerUtxoByte,
      poolDeposit: parseInt(data.pool_deposit, 10),
      keyDeposit: parseInt(data.key_deposit, 10),
      maxValSize: data.max_val_size,
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

    const response = await this.fetchRaw("/tx/submit", {
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

    // Blockfrost returns the tx hash as plain text (with quotes)
    const txHash = await response.text();
    return txHash.replace(/"/g, "");
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
        const response = await this.fetchRaw(`/txs/${txHash}`);
        if (response.ok) {
          return true;
        }
        // 404 means not yet on-chain, continue polling
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
   * Make a raw fetch request to Blockfrost API.
   */
  private async fetchRaw(
    path: string,
    init?: RequestInit
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...init?.headers,
          project_id: this.projectId,
        },
        signal: controller.signal,
      });

      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Make a fetch request with retries and JSON parsing.
   * Returns null for 404 responses.
   */
  private async fetchWithRetry<T>(
    path: string,
    init?: RequestInit
  ): Promise<T | null> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.retries; attempt++) {
      try {
        const response = await this.fetchRaw(path, init);

        // Handle 404 as empty result
        if (response.status === 404) {
          return null;
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Blockfrost API error (${response.status}): ${errorText}`);
        }

        return (await response.json()) as T;
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
   * Map Blockfrost UTxO response to UTxO interface.
   */
  private mapUtxo(data: BlockfrostUtxo): UTxO {
    const assets: Record<string, bigint> = {};

    // Extract native assets (skip lovelace)
    for (const amount of data.amount) {
      if (amount.unit === "lovelace") continue;
      assets[amount.unit] = BigInt(amount.quantity);
    }

    // Find lovelace amount
    const lovelaceAmount = data.amount.find((a) => a.unit === "lovelace");
    const lovelace = lovelaceAmount !== undefined
      ? BigInt(lovelaceAmount.quantity)
      : 0n;

    const utxo: UTxO = {
      txHash: data.tx_hash,
      outputIndex: data.output_index,
      address: data.address,
      lovelace,
      assets,
    };

    // Only set optional fields if they have values
    if (data.data_hash !== null) {
      utxo.datumHash = data.data_hash;
    }
    if (data.inline_datum !== null) {
      utxo.datum = data.inline_datum;
    }
    if (data.reference_script_hash !== null) {
      utxo.scriptRef = data.reference_script_hash;
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
