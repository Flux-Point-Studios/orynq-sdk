/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-cardano-node/src/node-payer.ts
 * @summary Server-side Cardano Payer implementation for payment execution.
 *
 * This file implements the Payer interface from @poi-sdk/core for server-side
 * Cardano payment processing. It uses a pluggable provider for blockchain data
 * and a signer abstraction for key management.
 *
 * Used by:
 * - Server-side payment processing applications
 * - Backend services that need to execute payments
 *
 * Dependencies:
 * - @poi-sdk/core for types and interfaces
 * - CardanoProvider implementation for blockchain data
 * - Signer implementation for transaction signing
 */

import type {
  Payer,
  PaymentProof,
  PaymentRequest,
  ChainId,
  Signer,
} from "@poi-sdk/core";
import {
  InsufficientBalanceError,
  PaymentFailedError,
  ChainNotSupportedError,
  AssetNotSupportedError,
} from "@poi-sdk/core";
import type { CardanoProvider, UTxO } from "./providers/interface.js";
import { buildPaymentTx, calculateTotalAmount } from "./tx-builder.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for CardanoNodePayer.
 */
export interface CardanoNodePayerConfig {
  /** Signer implementation for transaction signing */
  signer: Signer;

  /** Cardano blockchain data provider */
  provider: CardanoProvider;

  /**
   * Whether to wait for transaction confirmation after submission.
   * Default: false (returns immediately after submission)
   */
  awaitConfirmation?: boolean;

  /**
   * Timeout for transaction confirmation in milliseconds.
   * Only used if awaitConfirmation is true.
   * Default: 120000 (2 minutes)
   */
  confirmationTimeout?: number;
}

// ---------------------------------------------------------------------------
// Cardano Node Payer Implementation
// ---------------------------------------------------------------------------

/**
 * Server-side Cardano Payer for payment execution.
 *
 * Implements the Payer interface to handle Cardano payments from server-side
 * environments. Uses a pluggable provider for blockchain data and signer
 * for secure key management.
 *
 * Features:
 * - Multiple provider support (Blockfrost, Koios)
 * - Flexible signer abstraction (MemorySigner, KmsSigner)
 * - Automatic UTxO selection
 * - Split payment support
 * - Transaction confirmation awaiting (optional)
 *
 * @example
 * ```typescript
 * import { CardanoNodePayer } from "@poi-sdk/payer-cardano-node";
 * import { BlockfrostProvider } from "@poi-sdk/payer-cardano-node/providers";
 * import { KmsSigner } from "@poi-sdk/payer-cardano-node/signers";
 *
 * const payer = new CardanoNodePayer({
 *   signer: new KmsSigner({ keyId: "alias/my-key" }),
 *   provider: new BlockfrostProvider({
 *     projectId: "your-project-id",
 *     network: "mainnet",
 *   }),
 * });
 *
 * // Execute payment
 * const proof = await payer.pay(paymentRequest);
 * console.log("Transaction hash:", proof.txHash);
 * ```
 */
export class CardanoNodePayer implements Payer {
  /**
   * Supported CAIP-2 chain identifiers.
   * Determined by the provider's network configuration.
   */
  readonly supportedChains: readonly ChainId[];

  private readonly signer: Signer;
  private readonly provider: CardanoProvider;
  private readonly awaitConfirmation: boolean;
  private readonly confirmationTimeout: number;

  /**
   * Create a new CardanoNodePayer instance.
   *
   * @param config - Payer configuration
   */
  constructor(config: CardanoNodePayerConfig) {
    this.signer = config.signer;
    this.provider = config.provider;
    this.awaitConfirmation = config.awaitConfirmation ?? false;
    this.confirmationTimeout = config.confirmationTimeout ?? 120000;

    // Determine supported chains from provider network
    const network = this.provider.getNetworkId();
    this.supportedChains = [
      network === "mainnet" ? "cardano:mainnet" : "cardano:preprod",
    ];
  }

  /**
   * Check if this payer supports the given payment request.
   *
   * Validates:
   * - Chain is supported (cardano:mainnet or cardano:preprod)
   * - Asset is supported (ADA/lovelace for now)
   *
   * @param request - Payment request to evaluate
   * @returns true if this payer can handle the request
   */
  supports(request: PaymentRequest): boolean {
    // Check if chain is supported
    if (!this.supportedChains.includes(request.chain)) {
      return false;
    }

    // Check if asset is supported
    // Currently only support ADA (lovelace)
    const supportedAssets = ["ADA", "ada", "lovelace"];
    if (!supportedAssets.includes(request.asset)) {
      // Could support native assets in the future
      return false;
    }

    return true;
  }

  /**
   * Get the payment address for a specific chain.
   *
   * @param chain - CAIP-2 chain identifier
   * @returns Promise resolving to the bech32 address
   * @throws ChainNotSupportedError if chain is not supported
   */
  async getAddress(chain: ChainId): Promise<string> {
    // Validate chain is supported
    if (!this.supportedChains.includes(chain)) {
      throw new ChainNotSupportedError(chain, [...this.supportedChains]);
    }

    return this.signer.getAddress(chain);
  }

  /**
   * Get the current balance for an asset on a chain.
   *
   * @param chain - CAIP-2 chain identifier
   * @param asset - Asset identifier (ADA, lovelace, or native asset)
   * @returns Promise resolving to balance in atomic units
   * @throws ChainNotSupportedError if chain is not supported
   */
  async getBalance(chain: ChainId, asset: string): Promise<bigint> {
    // Validate chain is supported
    if (!this.supportedChains.includes(chain)) {
      throw new ChainNotSupportedError(chain, [...this.supportedChains]);
    }

    // Get address and UTxOs
    const address = await this.signer.getAddress(chain);
    const utxos = await this.provider.getUtxos(address);

    // Sum up the balance
    return this.calculateBalance(utxos, asset);
  }

  /**
   * Execute a payment and return proof.
   *
   * Payment flow:
   * 1. Validate the request
   * 2. Fetch UTxOs and protocol parameters
   * 3. Build and sign the transaction
   * 4. Submit to the network
   * 5. Optionally wait for confirmation
   * 6. Return transaction hash proof
   *
   * @param request - Payment request to execute
   * @returns Promise resolving to payment proof (transaction hash)
   * @throws ChainNotSupportedError if chain is not supported
   * @throws AssetNotSupportedError if asset is not supported
   * @throws InsufficientBalanceError if balance is too low
   * @throws PaymentFailedError if transaction fails
   */
  async pay(request: PaymentRequest): Promise<PaymentProof> {
    // Validate chain
    if (!this.supportedChains.includes(request.chain)) {
      throw new ChainNotSupportedError(request.chain, [...this.supportedChains]);
    }

    // Validate asset (currently only ADA)
    const supportedAssets = ["ADA", "ada", "lovelace"];
    if (!supportedAssets.includes(request.asset)) {
      throw new AssetNotSupportedError(request.asset, request.chain);
    }

    try {
      // Get address
      const address = await this.signer.getAddress(request.chain);

      // Fetch UTxOs and protocol parameters in parallel
      const [utxos, protocolParams] = await Promise.all([
        this.provider.getUtxos(address),
        this.provider.getProtocolParameters(),
      ]);

      // Check balance
      const totalRequired = calculateTotalAmount(request);
      const availableBalance = this.calculateBalance(utxos, request.asset);

      // Add estimated fee buffer (0.5 ADA)
      const feeBuffer = 500000n;
      const totalWithFee = totalRequired + feeBuffer;

      if (availableBalance < totalWithFee) {
        throw new InsufficientBalanceError(
          totalWithFee.toString(),
          availableBalance.toString(),
          request.asset,
          request.chain
        );
      }

      // Build and sign transaction
      const { txCbor, txHash: _txHash } = await buildPaymentTx({
        request,
        utxos,
        changeAddress: address,
        protocolParameters: protocolParams,
        signer: this.signer,
      });

      // Submit transaction
      const submittedHash = await this.provider.submitTx(txCbor);

      // Optionally wait for confirmation
      if (this.awaitConfirmation) {
        const confirmed = await this.provider.awaitTx(
          submittedHash,
          this.confirmationTimeout
        );
        if (!confirmed) {
          // Transaction submitted but not confirmed in time
          // This is not necessarily a failure - the tx may still confirm
          console.warn(
            `Transaction ${submittedHash} not confirmed within ${this.confirmationTimeout}ms`
          );
        }
      }

      // Return proof
      return {
        kind: "cardano-txhash",
        txHash: submittedHash,
      };
    } catch (error) {
      // Re-throw payment-specific errors
      if (
        error instanceof InsufficientBalanceError ||
        error instanceof ChainNotSupportedError ||
        error instanceof AssetNotSupportedError
      ) {
        throw error;
      }

      // Wrap other errors
      const message = error instanceof Error ? error.message : String(error);
      throw new PaymentFailedError(
        request,
        message,
        undefined,
        error instanceof Error ? error : undefined
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Calculate balance for an asset from UTxOs.
   *
   * @param utxos - UTxOs to sum
   * @param asset - Asset identifier
   * @returns Total balance in atomic units
   */
  private calculateBalance(utxos: UTxO[], asset: string): bigint {
    // Handle ADA/lovelace
    if (asset === "ADA" || asset === "ada" || asset === "lovelace") {
      return utxos.reduce((sum, u) => sum + u.lovelace, 0n);
    }

    // Handle native assets
    return utxos.reduce((sum, u) => {
      const amount = u.assets[asset];
      return sum + (amount ?? 0n);
    }, 0n);
  }
}
