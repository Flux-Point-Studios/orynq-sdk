/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-cardano-cip30/src/index.ts
 * @summary Main entry point for @poi-sdk/payer-cardano-cip30 package.
 *
 * This package provides a CIP-30 browser wallet adapter for Cardano payments
 * in the poi-sdk ecosystem. It allows dApps to accept payments via popular
 * Cardano wallets like Nami, Eternl, Lace, Vespr, Flint, and Typhon.
 *
 * Key features:
 * - CIP-30 wallet connection (getAvailableWallets, connectWallet)
 * - Payer interface implementation for payment execution
 * - Multi-output transaction building with split payments
 * - Support for both ADA and native token payments
 *
 * Usage:
 * ```typescript
 * import {
 *   createCip30Payer,
 *   getAvailableWallets,
 *   connectWallet,
 *   Cip30Payer,
 * } from "@poi-sdk/payer-cardano-cip30";
 *
 * // Quick start with convenience factory
 * const payer = await createCip30Payer("nami", "mainnet");
 * const proof = await payer.pay(paymentRequest);
 *
 * // Or manual setup for more control
 * const walletApi = await connectWallet("eternl");
 * const lucid = await Lucid.new(provider, "Mainnet");
 * lucid.selectWallet(walletApi);
 * const payer = new Cip30Payer({ walletApi, lucid, network: "mainnet" });
 * ```
 */

// ---------------------------------------------------------------------------
// Payer Implementation
// ---------------------------------------------------------------------------

export { Cip30Payer, type Cip30PayerConfig } from "./cip30-payer.js";

// Import type for use in factory function return type
import type { Cip30Payer as Cip30PayerType } from "./cip30-payer.js";

// ---------------------------------------------------------------------------
// Wallet Connection
// ---------------------------------------------------------------------------

export {
  // Functions
  getAvailableWallets,
  getWalletInfo,
  isWalletAvailable,
  isWalletConnected,
  connectWallet,
  disconnectWallet,
  getPreferredWallet,
  // Types
  type WalletName,
  type WalletInfo,
  type Cip30WalletApi,
  type Cip30EnabledWalletApi,
  type DataSignature,
  type CardanoWindow,
  // Constants
  KNOWN_WALLETS,
  WALLET_DISPLAY_NAMES,
  // Errors
  WalletConnectionError,
} from "./wallet-connector.js";

// ---------------------------------------------------------------------------
// Transaction Building
// ---------------------------------------------------------------------------

export {
  buildPaymentTx,
  buildBatchPaymentTx,
  calculateTotalAmount,
  isAdaAsset,
  parseAssetId,
  toLucidUnit,
  type TxBuilderConfig,
  type BuildPaymentOptions,
} from "./tx-builder.js";

// ---------------------------------------------------------------------------
// Convenience Factory
// ---------------------------------------------------------------------------

/**
 * Options for creating a CIP-30 payer with the convenience factory.
 */
export interface CreateCip30PayerOptions {
  /**
   * Blockfrost project ID for blockchain data access.
   * If not provided, Lucid will be initialized without a provider
   * (suitable for offline signing scenarios).
   */
  blockfrostProjectId?: string;

  /**
   * Custom Blockfrost API URL (optional).
   * Useful for self-hosted Blockfrost instances.
   */
  blockfrostUrl?: string;

  /**
   * Whether to validate that wallet network matches configured network.
   * @default true
   */
  validateNetwork?: boolean;
}

/**
 * Create a CIP-30 payer with automatic Lucid initialization.
 *
 * This is a convenience factory that handles Lucid setup automatically.
 * For more control over Lucid configuration, use the Cip30Payer class directly.
 *
 * NOTE: This factory dynamically imports lucid-cardano to support tree-shaking
 * when using manual setup. Ensure lucid-cardano is installed as a peer dependency.
 *
 * @param walletName - Name of the CIP-30 wallet to connect to
 * @param network - Cardano network to use
 * @param options - Optional configuration
 * @returns Promise resolving to configured Cip30Payer instance
 *
 * @example
 * // Basic usage (requires Blockfrost for full functionality)
 * const payer = await createCip30Payer("nami", "mainnet", {
 *   blockfrostProjectId: "your-project-id",
 * });
 *
 * // Check if request is supported
 * if (payer.supports(paymentRequest)) {
 *   const proof = await payer.pay(paymentRequest);
 *   console.log("Transaction hash:", proof.txHash);
 * }
 *
 * @example
 * // Testnet usage
 * const payer = await createCip30Payer("eternl", "preprod", {
 *   blockfrostProjectId: "preprodABCDEF123456",
 * });
 */
export async function createCip30Payer(
  walletName: import("./wallet-connector.js").WalletName,
  network: "mainnet" | "preprod" = "mainnet",
  options?: CreateCip30PayerOptions
): Promise<Cip30PayerType> {
  // Dynamic import to support tree-shaking
  const { Lucid, Blockfrost } = await import("lucid-cardano");
  const { connectWallet: connect } = await import("./wallet-connector.js");
  const { Cip30Payer: PayerClass } = await import("./cip30-payer.js");

  // Connect to wallet
  const walletApi = await connect(walletName);

  // Initialize Lucid
  let lucid: import("lucid-cardano").Lucid;

  if (options?.blockfrostProjectId) {
    // Full provider setup with Blockfrost
    const lucidNetwork = network === "mainnet" ? "Mainnet" : "Preprod";
    const blockfrostUrl =
      options.blockfrostUrl ??
      (network === "mainnet"
        ? "https://cardano-mainnet.blockfrost.io/api"
        : "https://cardano-preprod.blockfrost.io/api");

    const provider = new Blockfrost(blockfrostUrl, options.blockfrostProjectId);
    lucid = await Lucid.new(provider, lucidNetwork);
  } else {
    // Minimal setup without provider
    // Wallet-based UTxO fetching will be used
    const lucidNetwork = network === "mainnet" ? "Mainnet" : "Preprod";
    lucid = await Lucid.new(undefined, lucidNetwork);
  }

  // Select the connected wallet
  lucid.selectWallet(walletApi as Parameters<typeof lucid.selectWallet>[0]);

  // Create and return the payer
  // Note: We cast to Cip30PayerType since PayerClass is the same type from dynamic import
  return new PayerClass({
    walletApi,
    lucid,
    network,
    validateNetwork: options?.validateNetwork ?? true,
  }) as Cip30PayerType;
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Package version.
 * Updated automatically during build/release.
 */
export const VERSION = "0.0.0";
