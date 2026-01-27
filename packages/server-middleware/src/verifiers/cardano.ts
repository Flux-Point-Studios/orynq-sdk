/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/server-middleware/src/verifiers/cardano.ts
 * @summary Cardano blockchain payment verifier using Blockfrost or Koios APIs.
 *
 * This file implements the ChainVerifier interface for Cardano networks.
 * It supports verification of both transaction hash proofs and signed CBOR
 * transaction proofs. The verifier can use either Blockfrost or Koios as
 * the blockchain data provider.
 *
 * Used by:
 * - Express middleware for verifying Cardano payment proofs
 * - Fastify plugin for verifying Cardano payment proofs
 */

import type { ChainId, PaymentProof } from "@poi-sdk/core";
import type { ChainVerifier, VerificationResult } from "./interface.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration options for the Cardano verifier.
 */
export interface CardanoVerifierConfig {
  /**
   * Blockfrost project ID for API access.
   * Required when provider is "blockfrost".
   * Get one at: https://blockfrost.io
   */
  blockfrostProjectId?: string;

  /**
   * Koios API key for authenticated access.
   * Optional - Koios has a free tier without authentication.
   */
  koiosApiKey?: string;

  /**
   * Which blockchain data provider to use.
   * @default "blockfrost"
   */
  provider?: "blockfrost" | "koios";

  /**
   * Cardano network to verify against.
   * @default "mainnet"
   */
  network?: "mainnet" | "preprod" | "preview";

  /**
   * Custom API base URL (overrides default for provider).
   * Useful for self-hosted instances or proxies.
   */
  baseUrl?: string;

  /**
   * Request timeout in milliseconds.
   * @default 30000 (30 seconds)
   */
  timeout?: number;

  /**
   * Minimum confirmations required for verification.
   * @default 1
   */
  minConfirmations?: number;
}

// ---------------------------------------------------------------------------
// Blockfrost Response Types
// ---------------------------------------------------------------------------

interface BlockfrostUtxoResponse {
  hash: string;
  inputs: BlockfrostUtxoInput[];
  outputs: BlockfrostUtxoOutput[];
}

interface BlockfrostUtxoInput {
  address: string;
  amount: BlockfrostAmount[];
  tx_hash: string;
  output_index: number;
}

interface BlockfrostUtxoOutput {
  address: string;
  amount: BlockfrostAmount[];
  output_index: number;
}

interface BlockfrostAmount {
  unit: string;
  quantity: string;
}

interface BlockfrostTxResponse {
  hash: string;
  block: string;
  block_height: number;
  block_time: number;
  slot: number;
  index: number;
  fees: string;
  size: number;
  valid_contract: boolean;
}

interface BlockfrostTipResponse {
  height: number;
  hash: string;
  slot: number;
  epoch: number;
  epoch_slot: number;
  time: number;
}

// ---------------------------------------------------------------------------
// Koios Response Types
// ---------------------------------------------------------------------------

interface KoiosUtxoResponse {
  tx_hash: string;
  inputs: KoiosUtxoInput[];
  outputs: KoiosUtxoOutput[];
}

interface KoiosUtxoInput {
  payment_addr: { bech32: string };
  value: string;
  asset_list: KoiosAsset[];
}

interface KoiosUtxoOutput {
  payment_addr: { bech32: string };
  value: string;
  asset_list: KoiosAsset[];
}

interface KoiosAsset {
  policy_id: string;
  asset_name: string;
  quantity: string;
}

interface KoiosTxInfoResponse {
  tx_hash: string;
  block_hash: string;
  block_height: number;
  tx_timestamp: number;
  tx_block_index: number;
  tx_size: number;
  total_output: string;
  fee: string;
}

interface KoiosTipResponse {
  hash: string;
  epoch_no: number;
  abs_slot: number;
  epoch_slot: number;
  block_no: number;
  block_time: number;
}

// ---------------------------------------------------------------------------
// Cardano Verifier Implementation
// ---------------------------------------------------------------------------

/**
 * Payment verifier for Cardano blockchain networks.
 *
 * Supports verification of:
 * - Transaction hash proofs (cardano-txhash)
 * - Signed CBOR transaction proofs (cardano-signed-cbor)
 *
 * Uses Blockfrost or Koios APIs to query blockchain state.
 *
 * @example
 * ```typescript
 * const verifier = new CardanoVerifier({
 *   blockfrostProjectId: "mainnetXXXXXXX",
 *   network: "mainnet",
 * });
 *
 * const result = await verifier.verify(
 *   { kind: "cardano-txhash", txHash: "abc123..." },
 *   BigInt("1000000"),
 *   "addr1qy...",
 *   "cardano:mainnet"
 * );
 * ```
 */
export class CardanoVerifier implements ChainVerifier {
  readonly supportedChains: ChainId[];

  private readonly config: Required<
    Pick<CardanoVerifierConfig, "provider" | "network" | "timeout" | "minConfirmations">
  > &
    CardanoVerifierConfig;

  /**
   * Create a new Cardano verifier instance.
   *
   * @param config - Verifier configuration
   */
  constructor(config: CardanoVerifierConfig) {
    this.config = {
      provider: "blockfrost",
      network: "mainnet",
      timeout: 30000,
      minConfirmations: 1,
      ...config,
    };

    // Set supported chains based on network
    const chainId =
      this.config.network === "mainnet"
        ? "cardano:mainnet"
        : this.config.network === "preprod"
          ? "cardano:preprod"
          : "cardano:preview";

    this.supportedChains = [chainId];
  }

  /**
   * Verify a Cardano payment proof.
   *
   * @param proof - Payment proof (txHash or signed CBOR)
   * @param expectedAmount - Expected amount in lovelace
   * @param expectedRecipient - Expected recipient bech32 address
   * @param chain - Chain to verify on
   * @returns Verification result
   */
  async verify(
    proof: PaymentProof,
    expectedAmount: bigint,
    expectedRecipient: string,
    chain: ChainId
  ): Promise<VerificationResult> {
    // Validate proof kind
    if (proof.kind !== "cardano-txhash" && proof.kind !== "cardano-signed-cbor") {
      return {
        verified: false,
        error: `Unsupported proof kind: ${proof.kind}. Expected cardano-txhash or cardano-signed-cbor.`,
      };
    }

    // Validate chain
    if (!this.supportedChains.includes(chain)) {
      return {
        verified: false,
        error: `Chain ${chain} is not supported. Supported: ${this.supportedChains.join(", ")}`,
      };
    }

    try {
      // Get transaction hash
      let txHash: string;
      if (proof.kind === "cardano-txhash") {
        txHash = proof.txHash;
      } else {
        // For signed CBOR, we need to submit it first (or extract the hash)
        try {
          txHash = await this.submitCbor(proof.cborHex);
        } catch (err) {
          return {
            verified: false,
            error: `Failed to submit CBOR transaction: ${(err as Error).message}`,
          };
        }
      }

      // Validate tx hash format
      if (!this.isValidTxHash(txHash)) {
        return {
          verified: false,
          error: `Invalid transaction hash format: ${txHash}`,
        };
      }

      // Query transaction data
      const txData = await this.getTxData(txHash);
      if (!txData) {
        return {
          verified: false,
          error: `Transaction not found: ${txHash}`,
        };
      }

      // Get current tip for confirmation count
      const tip = await this.getTip();
      const confirmations = tip && txData.blockHeight
        ? Math.max(0, tip.height - txData.blockHeight + 1)
        : 0;

      // Check minimum confirmations
      if (confirmations < this.config.minConfirmations) {
        return {
          verified: false,
          txHash,
          confirmations,
          error: `Insufficient confirmations: ${confirmations} < ${this.config.minConfirmations}`,
        };
      }

      // Verify outputs match expected payment
      const hasExpectedOutput = this.checkOutput(
        txData.outputs,
        expectedRecipient,
        expectedAmount
      );

      if (!hasExpectedOutput) {
        return {
          verified: false,
          txHash,
          confirmations,
          error: `Transaction outputs do not match expected payment. Expected ${expectedAmount} lovelace to ${expectedRecipient}`,
        };
      }

      const result: VerificationResult = {
        verified: true,
        txHash,
        confirmations,
      };

      if (txData.blockHeight !== undefined) {
        result.blockNumber = txData.blockHeight;
      }

      if (txData.timestamp !== undefined) {
        result.confirmedAt = new Date(txData.timestamp * 1000).toISOString();
      }

      return result;
    } catch (err) {
      return {
        verified: false,
        error: `Verification failed: ${(err as Error).message}`,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Validate transaction hash format (64 hex characters).
   */
  private isValidTxHash(txHash: string): boolean {
    return /^[0-9a-fA-F]{64}$/.test(txHash);
  }

  /**
   * Get transaction data from the configured provider.
   */
  private async getTxData(
    txHash: string
  ): Promise<{ outputs: TransactionOutput[]; blockHeight?: number; timestamp?: number } | null> {
    if (this.config.provider === "koios") {
      return this.getTxDataKoios(txHash);
    }
    return this.getTxDataBlockfrost(txHash);
  }

  /**
   * Get transaction data from Blockfrost API.
   */
  private async getTxDataBlockfrost(
    txHash: string
  ): Promise<{ outputs: TransactionOutput[]; blockHeight?: number; timestamp?: number } | null> {
    const baseUrl = this.getBlockfrostBaseUrl();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      // Get UTXOs
      const utxoRes = await fetch(`${baseUrl}/txs/${txHash}/utxos`, {
        headers: {
          project_id: this.config.blockfrostProjectId!,
        },
        signal: controller.signal,
      });

      if (!utxoRes.ok) {
        if (utxoRes.status === 404) return null;
        throw new Error(`Blockfrost API error: ${utxoRes.status}`);
      }

      const utxoData = (await utxoRes.json()) as BlockfrostUtxoResponse;

      // Get transaction info for block height
      const txRes = await fetch(`${baseUrl}/txs/${txHash}`, {
        headers: {
          project_id: this.config.blockfrostProjectId!,
        },
        signal: controller.signal,
      });

      let blockHeight: number | undefined;
      let timestamp: number | undefined;

      if (txRes.ok) {
        const txInfo = (await txRes.json()) as BlockfrostTxResponse;
        blockHeight = txInfo.block_height;
        timestamp = txInfo.block_time;
      }

      // Convert to common format
      const outputs: TransactionOutput[] = utxoData.outputs.map((o) => ({
        address: o.address,
        lovelace: BigInt(
          o.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0"
        ),
        assets: o.amount
          .filter((a) => a.unit !== "lovelace")
          .map((a) => ({ unit: a.unit, quantity: BigInt(a.quantity) })),
      }));

      const result: { outputs: TransactionOutput[]; blockHeight?: number; timestamp?: number } = { outputs };
      if (blockHeight !== undefined) {
        result.blockHeight = blockHeight;
      }
      if (timestamp !== undefined) {
        result.timestamp = timestamp;
      }
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Get transaction data from Koios API.
   */
  private async getTxDataKoios(
    txHash: string
  ): Promise<{ outputs: TransactionOutput[]; blockHeight?: number; timestamp?: number } | null> {
    const baseUrl = this.getKoiosBaseUrl();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.config.koiosApiKey) {
      headers["authorization"] = `Bearer ${this.config.koiosApiKey}`;
    }

    try {
      // Get UTXOs
      const utxoRes = await fetch(`${baseUrl}/tx_utxos`, {
        method: "POST",
        headers,
        body: JSON.stringify({ _tx_hashes: [txHash] }),
        signal: controller.signal,
      });

      if (!utxoRes.ok) {
        throw new Error(`Koios API error: ${utxoRes.status}`);
      }

      const utxoData = (await utxoRes.json()) as KoiosUtxoResponse[];

      if (!utxoData || utxoData.length === 0) {
        return null;
      }

      const txUtxo = utxoData[0]!;

      // Get transaction info for block height
      const txInfoRes = await fetch(`${baseUrl}/tx_info`, {
        method: "POST",
        headers,
        body: JSON.stringify({ _tx_hashes: [txHash] }),
        signal: controller.signal,
      });

      let blockHeight: number | undefined;
      let timestamp: number | undefined;

      if (txInfoRes.ok) {
        const txInfoData = (await txInfoRes.json()) as KoiosTxInfoResponse[];
        if (txInfoData && txInfoData.length > 0) {
          blockHeight = txInfoData[0]!.block_height;
          timestamp = txInfoData[0]!.tx_timestamp;
        }
      }

      // Convert to common format
      const outputs: TransactionOutput[] = txUtxo.outputs.map((o) => ({
        address: o.payment_addr.bech32,
        lovelace: BigInt(o.value),
        assets: o.asset_list.map((a) => ({
          unit: `${a.policy_id}${a.asset_name}`,
          quantity: BigInt(a.quantity),
        })),
      }));

      const result: { outputs: TransactionOutput[]; blockHeight?: number; timestamp?: number } = { outputs };
      if (blockHeight !== undefined) {
        result.blockHeight = blockHeight;
      }
      if (timestamp !== undefined) {
        result.timestamp = timestamp;
      }
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Get the current blockchain tip.
   */
  private async getTip(): Promise<{ height: number } | null> {
    try {
      if (this.config.provider === "koios") {
        return this.getTipKoios();
      }
      return this.getTipBlockfrost();
    } catch {
      return null;
    }
  }

  /**
   * Get tip from Blockfrost.
   */
  private async getTipBlockfrost(): Promise<{ height: number } | null> {
    const baseUrl = this.getBlockfrostBaseUrl();

    const res = await fetch(`${baseUrl}/blocks/latest`, {
      headers: {
        project_id: this.config.blockfrostProjectId!,
      },
    });

    if (!res.ok) return null;

    const data = (await res.json()) as BlockfrostTipResponse;
    return { height: data.height };
  }

  /**
   * Get tip from Koios.
   */
  private async getTipKoios(): Promise<{ height: number } | null> {
    const baseUrl = this.getKoiosBaseUrl();

    const headers: Record<string, string> = {};
    if (this.config.koiosApiKey) {
      headers["authorization"] = `Bearer ${this.config.koiosApiKey}`;
    }

    const res = await fetch(`${baseUrl}/tip`, { headers });

    if (!res.ok) return null;

    const data = (await res.json()) as KoiosTipResponse[];
    if (!data || data.length === 0) return null;

    return { height: data[0]!.block_no };
  }

  /**
   * Submit signed CBOR transaction and return transaction hash.
   * Note: This is a placeholder - actual implementation would use
   * Blockfrost/Koios submit endpoints.
   */
  private async submitCbor(_cborHex: string): Promise<string> {
    // TODO: Implement CBOR submission
    // For now, throw an error as this requires additional work
    throw new Error(
      "CBOR transaction submission is not yet implemented. " +
        "Please submit the transaction directly and provide the txHash."
    );
  }

  /**
   * Check if transaction outputs contain the expected payment.
   */
  private checkOutput(
    outputs: TransactionOutput[],
    expectedRecipient: string,
    expectedAmount: bigint
  ): boolean {
    // Normalize recipient address for comparison
    const normalizedRecipient = expectedRecipient.toLowerCase();

    return outputs.some((output) => {
      const normalizedOutputAddress = output.address.toLowerCase();

      // Check address matches
      if (normalizedOutputAddress !== normalizedRecipient) {
        return false;
      }

      // Check amount is >= expected (allows for overpayment)
      return output.lovelace >= expectedAmount;
    });
  }

  /**
   * Get Blockfrost API base URL for configured network.
   */
  private getBlockfrostBaseUrl(): string {
    if (this.config.baseUrl) {
      return this.config.baseUrl;
    }

    switch (this.config.network) {
      case "mainnet":
        return "https://cardano-mainnet.blockfrost.io/api/v0";
      case "preprod":
        return "https://cardano-preprod.blockfrost.io/api/v0";
      case "preview":
        return "https://cardano-preview.blockfrost.io/api/v0";
      default:
        return "https://cardano-mainnet.blockfrost.io/api/v0";
    }
  }

  /**
   * Get Koios API base URL for configured network.
   */
  private getKoiosBaseUrl(): string {
    if (this.config.baseUrl) {
      return this.config.baseUrl;
    }

    switch (this.config.network) {
      case "mainnet":
        return "https://api.koios.rest/api/v1";
      case "preprod":
        return "https://preprod.koios.rest/api/v1";
      case "preview":
        return "https://preview.koios.rest/api/v1";
      default:
        return "https://api.koios.rest/api/v1";
    }
  }
}

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

/**
 * Normalized transaction output structure.
 */
interface TransactionOutput {
  address: string;
  lovelace: bigint;
  assets: Array<{ unit: string; quantity: bigint }>;
}
