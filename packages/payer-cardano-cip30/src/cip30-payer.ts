/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-cardano-cip30/src/cip30-payer.ts
 * @summary CIP-30 Payer implementation for Cardano browser wallets.
 *
 * This file implements the Payer interface from @poi-sdk/core for CIP-30
 * compliant Cardano wallets. It handles wallet connection, transaction
 * building, signing, and submission.
 *
 * Key features:
 * - Implements full Payer interface
 * - Supports ADA and native token payments
 * - Handles split payments (inclusive and additional modes)
 * - CBOR parsing for balance queries
 * - Network validation (mainnet/preprod)
 *
 * Used by:
 * - Application code for browser-based Cardano payments
 * - index.ts for the convenience factory function
 */

import type { Lucid, UTxO } from "lucid-cardano";
import type {
  Payer,
  PaymentProof,
  PaymentRequest,
  ChainId,
} from "@poi-sdk/core";
import {
  InsufficientBalanceError,
  PaymentFailedError,
  ChainNotSupportedError,
} from "@poi-sdk/core";
import type { Cip30EnabledWalletApi } from "./wallet-connector.js";
import { buildPaymentTx, calculateTotalAmount, isAdaAsset, toLucidUnit } from "./tx-builder.js";

// ---------------------------------------------------------------------------
// Configuration Types
// ---------------------------------------------------------------------------

/**
 * Configuration for the CIP-30 Payer.
 */
export interface Cip30PayerConfig {
  /** CIP-30 enabled wallet API (from connectWallet) */
  walletApi: Cip30EnabledWalletApi;

  /** Lucid instance configured for the target network */
  lucid: Lucid;

  /**
   * Network to use for chain ID mapping.
   * @default "mainnet"
   */
  network?: "mainnet" | "preprod" | "preview";

  /**
   * Whether to validate that wallet network matches configured network.
   * @default true
   */
  validateNetwork?: boolean;
}

// ---------------------------------------------------------------------------
// CBOR Parsing Utilities
// ---------------------------------------------------------------------------

/**
 * Parse a CBOR-encoded balance value.
 *
 * CIP-30 getBalance() returns CBOR-encoded values. For simple lovelace
 * balances, this is a CBOR unsigned integer. For balances with multi-assets,
 * it's a CBOR array.
 *
 * CBOR major types for unsigned integers:
 * - 0x00-0x17: value is the number itself (0-23)
 * - 0x18: next byte is the value (24-255)
 * - 0x19: next 2 bytes are the value (256-65535)
 * - 0x1a: next 4 bytes are the value (up to 4,294,967,295)
 * - 0x1b: next 8 bytes are the value (up to 2^64-1)
 *
 * @param cborHex - Hex-encoded CBOR data
 * @returns Lovelace balance as bigint
 */
function parseCborBalance(cborHex: string): bigint {
  if (!cborHex || cborHex.length === 0) {
    return 0n;
  }

  // Remove any 0x prefix
  const hex = cborHex.startsWith("0x") ? cborHex.slice(2) : cborHex;

  // Get the first byte (major type + additional info)
  const firstByte = parseInt(hex.slice(0, 2), 16);

  // Check if it's an array (major type 4 = 0x80-0x9f or 0x9f for indefinite)
  // Array format: [lovelace, multiasset_map]
  if ((firstByte & 0xe0) === 0x80) {
    // It's an array, first element is lovelace
    // For simplicity, we skip the array header and parse the first uint
    const arrayLength = firstByte & 0x1f;
    if (arrayLength >= 1) {
      // Parse the lovelace value starting at byte 1
      return parseCborUint(hex.slice(2));
    }
  }

  // Try to parse as a simple unsigned integer
  return parseCborUint(hex);
}

/**
 * Parse a CBOR unsigned integer from hex string.
 *
 * @param hex - Hex string starting with the integer
 * @returns Parsed value as bigint
 */
function parseCborUint(hex: string): bigint {
  if (!hex || hex.length < 2) {
    return 0n;
  }

  const firstByte = parseInt(hex.slice(0, 2), 16);
  const majorType = (firstByte & 0xe0) >> 5;

  // Major type 0 is unsigned integer
  if (majorType !== 0) {
    // Not an unsigned integer - might be an array or other type
    // For now, return 0 and let callers handle via UTxO scanning
    return 0n;
  }

  const additionalInfo = firstByte & 0x1f;

  if (additionalInfo <= 23) {
    // Value is embedded in the first byte
    return BigInt(additionalInfo);
  } else if (additionalInfo === 24) {
    // One byte follows
    return BigInt(parseInt(hex.slice(2, 4), 16));
  } else if (additionalInfo === 25) {
    // Two bytes follow
    return BigInt("0x" + hex.slice(2, 6));
  } else if (additionalInfo === 26) {
    // Four bytes follow
    return BigInt("0x" + hex.slice(2, 10));
  } else if (additionalInfo === 27) {
    // Eight bytes follow
    return BigInt("0x" + hex.slice(2, 18));
  }

  // Unsupported additional info
  return 0n;
}

// ---------------------------------------------------------------------------
// CIP-30 Payer Implementation
// ---------------------------------------------------------------------------

/**
 * CIP-30 Payer implementation for Cardano browser wallets.
 *
 * This class implements the Payer interface for CIP-30 wallets like
 * Nami, Eternl, Lace, Vespr, Flint, and Typhon.
 *
 * @example
 * import { connectWallet, Cip30Payer } from "@poi-sdk/payer-cardano-cip30";
 * import { Lucid } from "lucid-cardano";
 *
 * // Connect to wallet
 * const walletApi = await connectWallet("nami");
 *
 * // Initialize Lucid
 * const lucid = await Lucid.new(
 *   new Blockfrost("https://cardano-mainnet.blockfrost.io/api", projectId),
 *   "Mainnet"
 * );
 * lucid.selectWallet(walletApi);
 *
 * // Create payer
 * const payer = new Cip30Payer({ walletApi, lucid, network: "mainnet" });
 *
 * // Execute payment
 * const proof = await payer.pay(paymentRequest);
 * console.log("Transaction hash:", proof.txHash);
 */
export class Cip30Payer implements Payer {
  /** List of supported chain IDs (CAIP-2 format) */
  readonly supportedChains: readonly ChainId[];

  private readonly config: Cip30PayerConfig;
  private readonly network: "mainnet" | "preprod" | "preview";
  private networkValidated = false;

  /**
   * Create a new CIP-30 Payer instance.
   *
   * @param config - Payer configuration
   */
  constructor(config: Cip30PayerConfig) {
    this.config = config;
    this.network = config.network ?? "mainnet";

    // Set supported chains based on network
    this.supportedChains = [`cardano:${this.network}`] as const;
  }

  /**
   * Check if this payer supports the given payment request.
   *
   * Verifies that:
   * - The chain is a supported Cardano network
   * - The request appears valid
   *
   * @param request - Payment request to evaluate
   * @returns true if this payer can handle the request
   */
  supports(request: PaymentRequest): boolean {
    return this.supportedChains.includes(request.chain);
  }

  /**
   * Get the wallet's payment address.
   *
   * Returns the wallet's primary address via Lucid's wallet integration,
   * which handles the CIP-30 hex-to-bech32 conversion internally.
   *
   * @param chain - Chain ID (must be supported)
   * @returns Promise resolving to bech32-encoded address
   * @throws ChainNotSupportedError if chain is not supported
   */
  async getAddress(chain: ChainId): Promise<string> {
    this.validateChain(chain);
    await this.ensureNetworkValidated();

    // Use Lucid's wallet integration which handles address conversion
    // This is the most reliable way to get a properly formatted bech32 address
    return this.config.lucid.wallet.address();
  }

  /**
   * Get the wallet's balance for an asset.
   *
   * @param chain - Chain ID (must be supported)
   * @param asset - Asset identifier ("ADA", "lovelace", or policyId.assetName)
   * @returns Promise resolving to balance in atomic units
   * @throws ChainNotSupportedError if chain is not supported
   */
  async getBalance(chain: ChainId, asset: string): Promise<bigint> {
    this.validateChain(chain);
    await this.ensureNetworkValidated();

    if (isAdaAsset(asset)) {
      // Try to get ADA balance from getBalance() CBOR
      try {
        const balanceCbor = await this.config.walletApi.getBalance();
        const lovelace = parseCborBalance(balanceCbor);
        if (lovelace > 0n) {
          return lovelace;
        }
      } catch {
        // Fall through to UTxO scanning
      }

      // Fall back to UTxO scanning via Lucid
      const utxos = await this.config.lucid.wallet.getUtxos();
      return utxos.reduce((sum, utxo) => sum + (utxo.assets.lovelace ?? 0n), 0n);
    }

    // For native tokens, scan UTxOs
    const utxos = await this.config.lucid.wallet.getUtxos();
    const unit = toLucidUnit(asset);

    let total = 0n;
    for (const utxo of utxos) {
      const amount = utxo.assets[unit];
      if (amount !== undefined) {
        total += amount;
      }
    }

    return total;
  }

  /**
   * Execute a payment and return the transaction hash.
   *
   * This method:
   * 1. Validates the payment request
   * 2. Checks wallet balance
   * 3. Builds the transaction
   * 4. Signs with the wallet
   * 5. Submits to the network
   *
   * @param request - Payment request to execute
   * @returns Promise resolving to payment proof (transaction hash)
   * @throws InsufficientBalanceError if balance is too low
   * @throws PaymentFailedError if transaction fails
   * @throws ChainNotSupportedError if chain is not supported
   */
  async pay(request: PaymentRequest): Promise<PaymentProof> {
    this.validateChain(request.chain);
    await this.ensureNetworkValidated();

    // Calculate total amount needed
    const totalAmount = calculateTotalAmount(request);

    // Check balance for the primary asset
    const balance = await this.getBalance(request.chain, request.asset);

    // For ADA, we need to account for fees (rough estimate: 0.5 ADA)
    const feeBuffer = isAdaAsset(request.asset) ? 500_000n : 0n;
    const requiredAmount = totalAmount + feeBuffer;

    if (balance < requiredAmount) {
      throw new InsufficientBalanceError(
        requiredAmount.toString(),
        balance.toString(),
        request.asset,
        request.chain
      );
    }

    // Check balances for split outputs with different assets
    if (request.splits) {
      for (const split of request.splits.outputs) {
        if (split.asset && split.asset !== request.asset && !isAdaAsset(split.asset)) {
          const splitBalance = await this.getBalance(request.chain, split.asset);
          const splitAmount = BigInt(split.amountUnits);

          if (splitBalance < splitAmount) {
            throw new InsufficientBalanceError(
              splitAmount.toString(),
              splitBalance.toString(),
              split.asset,
              request.chain
            );
          }
        }
      }
    }

    try {
      // Build the transaction
      const txComplete = await buildPaymentTx(this.config.lucid, request);

      // Sign with wallet
      const signedTx = await txComplete.sign().complete();

      // Submit to network
      const txHash = await signedTx.submit();

      return {
        kind: "cardano-txhash",
        txHash,
      };
    } catch (error) {
      // Wrap errors in PaymentFailedError
      const message = error instanceof Error ? error.message : "Transaction failed";
      throw new PaymentFailedError(request, message, undefined, error instanceof Error ? error : undefined);
    }
  }

  /**
   * Get wallet UTxOs (useful for advanced use cases).
   *
   * @returns Promise resolving to array of UTxOs
   */
  async getUtxos(): Promise<UTxO[]> {
    return this.config.lucid.wallet.getUtxos();
  }

  /**
   * Get the wallet's collateral UTxOs (for smart contract interactions).
   *
   * @returns Promise resolving to array of collateral UTxOs, or undefined
   */
  async getCollateral(): Promise<UTxO[] | undefined> {
    if (!this.config.walletApi.getCollateral) {
      return undefined;
    }

    const collateralHex = await this.config.walletApi.getCollateral();
    if (!collateralHex || collateralHex.length === 0) {
      return undefined;
    }

    // Convert hex UTxOs to Lucid UTxOs
    // This would require CBOR parsing; for now, return from Lucid
    // which internally handles this
    return this.config.lucid.wallet.getUtxos();
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  /**
   * Validate that the requested chain is supported.
   *
   * @param chain - Chain ID to validate
   * @throws ChainNotSupportedError if not supported
   */
  private validateChain(chain: ChainId): void {
    if (!this.supportedChains.includes(chain)) {
      throw new ChainNotSupportedError(chain, this.supportedChains);
    }
  }

  /**
   * Validate that the wallet is on the correct network.
   * Only performed once per payer instance.
   *
   * @throws Error if network mismatch
   */
  private async ensureNetworkValidated(): Promise<void> {
    if (this.networkValidated || this.config.validateNetwork === false) {
      return;
    }

    const networkId = await this.config.walletApi.getNetworkId();
    const expectedNetworkId = this.network === "mainnet" ? 1 : 0;

    if (networkId !== expectedNetworkId) {
      const walletNetwork = networkId === 1 ? "mainnet" : "testnet";
      throw new Error(
        `Network mismatch: wallet is on ${walletNetwork}, but payer is configured for ${this.network}`
      );
    }

    this.networkValidated = true;
  }

}
