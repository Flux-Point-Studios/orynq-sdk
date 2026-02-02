/**
 * @summary Main entry point for @fluxpointstudios/orynq-sdk-payer-cardano-cip30 package.
 *
 * This package provides a CIP-30 browser wallet adapter for Cardano payments
 * in the orynq-sdk ecosystem using MeshJS. It allows dApps to accept payments
 * via popular Cardano wallets like Nami, Eternl, Lace, Vespr, Flint, and Typhon.
 *
 * Key features:
 * - CIP-30 wallet connection (getAvailableWallets, connectWallet)
 * - Payer interface implementation for payment execution
 * - Multi-output transaction building with split payments
 * - Support for both ADA and native token payments
 * - MeshJS-based transaction building and wallet integration
 *
 * Usage:
 * ```typescript
 * import {
 *   createCip30Payer,
 *   getAvailableWallets,
 *   Cip30Payer,
 * } from "@fluxpointstudios/orynq-sdk-payer-cardano-cip30";
 * import { BrowserWallet } from "@meshsdk/core";
 *
 * // Quick start with convenience factory
 * const payer = await createCip30Payer("nami", "mainnet");
 * const proof = await payer.pay(paymentRequest);
 *
 * // Or manual setup for more control
 * const wallet = await BrowserWallet.enable("eternl");
 * const payer = new Cip30Payer({ wallet, network: "mainnet" });
 * ```
 */

// ---------------------------------------------------------------------------
// Payer Implementation
// ---------------------------------------------------------------------------

export {
  Cip30Payer,
  createCip30PayerFromWallet,
  type Cip30PayerConfig,
  type CardanoNetwork,
} from "./cip30-payer.js";

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
  calculateRequiredAmounts,
  collectPaymentOutputs,
  isAdaAsset,
  parseAssetId,
  toMeshUnit,
  toMeshAsset,
  toLucidUnit, // Alias for backward compatibility
  type TxBuilderConfig,
  type BuildPaymentOptions,
  type PaymentOutput,
} from "./tx-builder.js";

// ---------------------------------------------------------------------------
// Convenience Factory
// ---------------------------------------------------------------------------

/**
 * Options for creating a CIP-30 payer with the convenience factory.
 */
export interface CreateCip30PayerOptions {
  /**
   * Whether to validate that wallet network matches configured network.
   * @default true
   */
  validateNetwork?: boolean;
}

/**
 * Create a CIP-30 payer with automatic MeshJS wallet connection.
 *
 * This is a convenience factory that handles wallet setup automatically.
 * For more control over wallet configuration, use the Cip30Payer class directly.
 *
 * @param walletName - Name of the CIP-30 wallet to connect to
 * @param network - Cardano network to use (mainnet, preprod, or preview)
 * @param options - Optional configuration
 * @returns Promise resolving to configured Cip30Payer instance
 *
 * @example
 * // Basic usage
 * const payer = await createCip30Payer("nami", "mainnet");
 *
 * // Check if request is supported
 * if (payer.supports(paymentRequest)) {
 *   const proof = await payer.pay(paymentRequest);
 *   console.log("Transaction hash:", proof.txHash);
 * }
 *
 * @example
 * // Testnet usage
 * const payer = await createCip30Payer("eternl", "preprod");
 */
export async function createCip30Payer(
  walletName: import("./wallet-connector.js").WalletName,
  network: "mainnet" | "preprod" | "preview" = "mainnet",
  options?: CreateCip30PayerOptions
): Promise<Cip30PayerType> {
  // Dynamic import to support tree-shaking
  const { BrowserWallet } = await import("@meshsdk/core");
  const { Cip30Payer: PayerClass } = await import("./cip30-payer.js");

  // Connect to wallet using MeshJS
  const wallet = await BrowserWallet.enable(walletName);

  // Create and return the payer
  return new PayerClass({
    wallet,
    network,
    validateNetwork: options?.validateNetwork ?? true,
  }) as Cip30PayerType;
}

// ---------------------------------------------------------------------------
// MeshJS Re-exports (for convenience)
// ---------------------------------------------------------------------------

/**
 * Re-export BrowserWallet from MeshJS for convenience.
 * This allows users to access MeshJS wallet functionality without
 * importing @meshsdk/core directly.
 */
export { BrowserWallet } from "@meshsdk/core";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Package version.
 * Updated automatically during build/release.
 */
export const VERSION = "0.0.0";
