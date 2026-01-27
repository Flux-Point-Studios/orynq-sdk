/**
 * @summary CIP-30 Payer implementation for Cardano browser wallets using MeshJS.
 *
 * This file implements the Payer interface from @fluxpointstudios/poi-sdk-core for CIP-30
 * compliant Cardano wallets. It handles wallet connection, transaction
 * building, signing, and submission using MeshJS BrowserWallet.
 *
 * Key features:
 * - Implements full Payer interface
 * - Supports ADA and native token payments
 * - Handles split payments (inclusive and additional modes)
 * - Network validation (mainnet/preprod/preview)
 * - Graceful wallet disconnect handling
 * - UTxO-based balance queries
 *
 * Used by:
 * - Application code for browser-based Cardano payments
 * - index.ts for the convenience factory function
 */

import { BrowserWallet } from "@meshsdk/core";
import type { UTxO } from "@meshsdk/core";
import type {
  Payer,
  PaymentProof,
  PaymentRequest,
  ChainId,
} from "@fluxpointstudios/poi-sdk-core";
import {
  InsufficientBalanceError,
  PaymentFailedError,
  ChainNotSupportedError,
} from "@fluxpointstudios/poi-sdk-core";
import type { Cip30EnabledWalletApi, WalletName } from "./wallet-connector.js";
import {
  buildPaymentTx,
  calculateTotalAmount,
  isAdaAsset,
  toMeshUnit,
} from "./tx-builder.js";

// ---------------------------------------------------------------------------
// Configuration Types
// ---------------------------------------------------------------------------

/**
 * Network identifier for Cardano.
 */
export type CardanoNetwork = "mainnet" | "preprod" | "preview";

/**
 * Configuration for the CIP-30 Payer.
 */
export interface Cip30PayerConfig {
  /**
   * MeshJS BrowserWallet instance (preferred).
   * If provided, this will be used directly.
   */
  wallet?: BrowserWallet;

  /**
   * CIP-30 enabled wallet API (legacy support).
   * Used only if wallet is not provided.
   */
  walletApi?: Cip30EnabledWalletApi;

  /**
   * Wallet name for connecting via MeshJS.
   * Used only if neither wallet nor walletApi is provided.
   */
  walletName?: WalletName;

  /**
   * Network to use for chain ID mapping.
   * @default "mainnet"
   */
  network?: CardanoNetwork;

  /**
   * Whether to validate that wallet network matches configured network.
   * @default true
   */
  validateNetwork?: boolean;
}

// ---------------------------------------------------------------------------
// CIP-30 Payer Implementation
// ---------------------------------------------------------------------------

/**
 * CIP-30 Payer implementation for Cardano browser wallets using MeshJS.
 *
 * This class implements the Payer interface for CIP-30 wallets like
 * Nami, Eternl, Lace, Vespr, Flint, and Typhon. It uses MeshJS for
 * transaction building and wallet interaction.
 *
 * @example
 * import { Cip30Payer } from "@fluxpointstudios/poi-sdk-payer-cardano-cip30";
 * import { BrowserWallet } from "@meshsdk/core";
 *
 * // Connect using MeshJS BrowserWallet
 * const wallet = await BrowserWallet.enable("nami");
 * const payer = new Cip30Payer({ wallet, network: "mainnet" });
 *
 * // Execute payment
 * const proof = await payer.pay(paymentRequest);
 * console.log("Transaction hash:", proof.txHash);
 *
 * @example
 * // Using wallet name for automatic connection
 * const payer = new Cip30Payer({ walletName: "eternl", network: "preprod" });
 * const proof = await payer.pay(paymentRequest);
 */
export class Cip30Payer implements Payer {
  /** List of supported chain IDs (CAIP-2 format) */
  readonly supportedChains: readonly ChainId[];

  private readonly config: Cip30PayerConfig;
  private readonly network: CardanoNetwork;
  private wallet: BrowserWallet | null = null;
  private networkValidated = false;
  private walletConnected = false;

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

    // If wallet is provided directly, use it
    if (config.wallet) {
      this.wallet = config.wallet;
      this.walletConnected = true;
    }
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
   * Returns the wallet's primary used address or change address.
   *
   * @param chain - Chain ID (must be supported)
   * @returns Promise resolving to bech32-encoded address
   * @throws ChainNotSupportedError if chain is not supported
   */
  async getAddress(chain: ChainId): Promise<string> {
    this.validateChain(chain);
    const wallet = await this.ensureWalletConnected();
    await this.ensureNetworkValidated(wallet);

    // Get used addresses first, fall back to change address
    const usedAddresses = await wallet.getUsedAddresses();
    if (usedAddresses.length > 0 && usedAddresses[0] !== undefined) {
      return usedAddresses[0];
    }

    // Fall back to change address if no used addresses
    const changeAddress = await wallet.getChangeAddress();
    return changeAddress;
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
    const wallet = await this.ensureWalletConnected();
    await this.ensureNetworkValidated(wallet);

    const unit = toMeshUnit(asset);

    if (isAdaAsset(asset)) {
      // Get lovelace balance
      const lovelace = await wallet.getLovelace();
      return BigInt(lovelace);
    }

    // For native tokens, get all assets and find the matching one
    const balance = await wallet.getBalance();

    for (const assetBalance of balance) {
      if (assetBalance.unit === unit) {
        return BigInt(assetBalance.quantity);
      }
    }

    // Asset not found in wallet
    return 0n;
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
    const wallet = await this.ensureWalletConnected();
    await this.ensureNetworkValidated(wallet);

    // Calculate total amount needed
    const totalAmount = calculateTotalAmount(request);

    // Check balance for the primary asset
    const balance = await this.getBalance(request.chain, request.asset);

    // For ADA, we need to account for fees (rough estimate: 0.5 ADA)
    // MeshJS handles min UTxO requirements automatically
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
      // Build the transaction using MeshJS
      const unsignedTx = await buildPaymentTx(wallet, request);

      // Sign with wallet
      const signedTx = await wallet.signTx(unsignedTx);

      // Submit to network
      const txHash = await wallet.submitTx(signedTx);

      return {
        kind: "cardano-txhash",
        txHash,
      };
    } catch (error) {
      // Check for user rejection
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (
          message.includes("user declined") ||
          message.includes("user rejected") ||
          message.includes("cancelled") ||
          message.includes("canceled")
        ) {
          throw new PaymentFailedError(
            request,
            "Transaction signing was cancelled by user",
            undefined,
            error
          );
        }
      }

      // Wrap other errors in PaymentFailedError
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
    const wallet = await this.ensureWalletConnected();
    return wallet.getUtxos();
  }

  /**
   * Get the wallet's collateral UTxOs (for smart contract interactions).
   *
   * @returns Promise resolving to array of collateral UTxOs, or empty array if not set
   */
  async getCollateral(): Promise<UTxO[]> {
    const wallet = await this.ensureWalletConnected();

    try {
      const collateral = await wallet.getCollateral();
      return collateral ?? [];
    } catch {
      // Some wallets don't support collateral or it's not set
      return [];
    }
  }

  /**
   * Get the underlying MeshJS BrowserWallet instance.
   * Useful for advanced operations not covered by the Payer interface.
   *
   * @returns Promise resolving to BrowserWallet instance
   */
  async getBrowserWallet(): Promise<BrowserWallet> {
    return this.ensureWalletConnected();
  }

  /**
   * Check if the wallet is currently connected.
   *
   * @returns true if wallet is connected
   */
  isConnected(): boolean {
    return this.walletConnected && this.wallet !== null;
  }

  /**
   * Get the network this payer is configured for.
   *
   * @returns Network identifier
   */
  getNetwork(): CardanoNetwork {
    return this.network;
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
   * Ensure the wallet is connected and return the BrowserWallet instance.
   *
   * @returns Promise resolving to BrowserWallet instance
   * @throws Error if wallet cannot be connected
   */
  private async ensureWalletConnected(): Promise<BrowserWallet> {
    if (this.wallet && this.walletConnected) {
      return this.wallet;
    }

    // Try to connect via wallet name if provided
    if (this.config.walletName) {
      try {
        this.wallet = await BrowserWallet.enable(this.config.walletName);
        this.walletConnected = true;
        return this.wallet;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to connect wallet";
        throw new Error(`Failed to connect to ${this.config.walletName}: ${message}`);
      }
    }

    // Try to use legacy walletApi if provided
    if (this.config.walletApi) {
      // For legacy API, we need to create a BrowserWallet from the enabled API
      // MeshJS doesn't directly support this, so we wrap the API
      throw new Error(
        "Legacy walletApi is not supported. Please provide a BrowserWallet instance or walletName."
      );
    }

    throw new Error(
      "No wallet configured. Provide either wallet, walletName, or walletApi in config."
    );
  }

  /**
   * Validate that the wallet is on the correct network.
   * Only performed once per payer instance.
   *
   * @param wallet - BrowserWallet instance to validate
   * @throws Error if network mismatch
   */
  private async ensureNetworkValidated(wallet: BrowserWallet): Promise<void> {
    if (this.networkValidated || this.config.validateNetwork === false) {
      return;
    }

    const networkId = await wallet.getNetworkId();
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

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

/**
 * Create a CIP-30 Payer by connecting to a wallet by name.
 *
 * @param walletName - Name of the wallet to connect to
 * @param network - Network to use (mainnet or preprod/preview)
 * @param validateNetwork - Whether to validate network on first operation
 * @returns Promise resolving to configured Cip30Payer instance
 *
 * @example
 * const payer = await createCip30PayerFromWallet("nami", "mainnet");
 * const proof = await payer.pay(paymentRequest);
 */
export async function createCip30PayerFromWallet(
  walletName: WalletName,
  network: CardanoNetwork = "mainnet",
  validateNetwork = true
): Promise<Cip30Payer> {
  const wallet = await BrowserWallet.enable(walletName);

  return new Cip30Payer({
    wallet,
    network,
    validateNetwork,
  });
}
