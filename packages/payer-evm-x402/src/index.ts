/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-evm-x402/src/index.ts
 * @summary Main entry point for @poi-sdk/payer-evm-x402 package.
 *
 * This package provides an EVM Payer implementation for the x402 payment protocol
 * using EIP-3009 "Transfer With Authorization" for gasless token transfers.
 *
 * Key features:
 * - Gasless UX: Buyer signs, facilitator pays gas
 * - EIP-3009 transferWithAuthorization signatures
 * - EIP-712 typed data signing for secure authorization
 * - Supports Base mainnet and Base Sepolia USDC
 * - Pluggable signer architecture (Viem, KMS)
 *
 * Usage:
 * ```typescript
 * import { createEvmX402Payer } from "@poi-sdk/payer-evm-x402";
 *
 * // Quick setup with private key
 * const payer = createEvmX402Payer("0x...", {
 *   chains: ["eip155:8453"], // Base mainnet
 * });
 *
 * // Create x402 payment signature
 * const proof = await payer.pay({
 *   protocol: "x402",
 *   chain: "eip155:8453",
 *   asset: "USDC",
 *   amountUnits: "1000000", // 1 USDC
 *   payTo: "0x...",
 * });
 *
 * // Use proof.signature in PAYMENT-SIGNATURE header
 * ```
 *
 * For custom signer configurations:
 * ```typescript
 * import { EvmX402Payer, ViemSigner } from "@poi-sdk/payer-evm-x402";
 *
 * const signer = new ViemSigner({ privateKey: "0x..." });
 * const payer = new EvmX402Payer({
 *   signer,
 *   chains: ["eip155:8453", "eip155:84532"],
 *   rpcUrls: {
 *     "eip155:8453": "https://mainnet.base.org",
 *   },
 * });
 * ```
 *
 * Used by:
 * - @poi-sdk/client for automatic x402 payment handling
 * - Browser applications with wallet integration
 * - Node.js servers for automated payments
 */

// ---------------------------------------------------------------------------
// Main Exports
// ---------------------------------------------------------------------------

export { EvmX402Payer, type EvmX402PayerConfig } from "./x402-payer.js";

// ---------------------------------------------------------------------------
// Signer Exports
// ---------------------------------------------------------------------------

export { ViemSigner, type ViemSignerConfig } from "./signers/viem-signer.js";
export { KmsSigner, type KmsSignerConfig } from "./signers/kms-signer.js";

// Re-export from signers barrel for convenience
export * from "./signers/index.js";

// ---------------------------------------------------------------------------
// EIP-3009 Exports
// ---------------------------------------------------------------------------

export {
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  USDC_DOMAIN_CONFIG,
  buildTypedData,
  generateNonce,
  calculateValidity,
  signAuthorization,
  serializeAuthorization,
  deserializeAuthorization,
  encodeAuthorizationToBase64,
  decodeAuthorizationFromBase64,
  isAuthorizationValid,
  getUsdcDomainConfig,
  type Eip712Domain,
  type TransferWithAuthorizationMessage,
  type Eip3009Authorization,
  type BuildTypedDataParams,
  type SerializedAuthorization,
} from "./eip3009.js";

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

import { ViemSigner } from "./signers/viem-signer.js";
import { EvmX402Payer, type EvmX402PayerConfig } from "./x402-payer.js";

/**
 * Create an EvmX402Payer with a private key.
 *
 * This is a convenience factory for quick setup. For more control over
 * the signer configuration, use ViemSigner and EvmX402Payer directly.
 *
 * @param privateKey - Private key for signing (hex string with 0x prefix)
 * @param options - Optional payer configuration
 * @returns Configured EvmX402Payer instance
 *
 * @example
 * ```typescript
 * import { createEvmX402Payer } from "@poi-sdk/payer-evm-x402";
 *
 * const payer = createEvmX402Payer("0x...", {
 *   chains: ["eip155:8453"],
 *   rpcUrls: {
 *     "eip155:8453": "https://mainnet.base.org",
 *   },
 * });
 *
 * const proof = await payer.pay(request);
 * ```
 */
export function createEvmX402Payer(
  privateKey: `0x${string}`,
  options?: Partial<Omit<EvmX402PayerConfig, "signer">>
): EvmX402Payer {
  const signer = new ViemSigner({ privateKey });
  return new EvmX402Payer({ signer, ...options });
}

/**
 * Create an EvmX402Payer with a pre-configured signer.
 *
 * Use this when you need custom signer configuration or want to use
 * a different signer implementation (e.g., KmsSigner for production).
 *
 * @param signer - Signer instance (ViemSigner or compatible)
 * @param options - Optional payer configuration
 * @returns Configured EvmX402Payer instance
 *
 * @example
 * ```typescript
 * import { createEvmX402PayerWithSigner, ViemSigner } from "@poi-sdk/payer-evm-x402";
 * import { privateKeyToAccount } from "viem/accounts";
 *
 * const account = privateKeyToAccount("0x...");
 * const signer = new ViemSigner({ account });
 *
 * const payer = createEvmX402PayerWithSigner(signer, {
 *   chains: ["eip155:8453"],
 * });
 * ```
 */
export function createEvmX402PayerWithSigner(
  signer: ViemSigner,
  options?: Partial<Omit<EvmX402PayerConfig, "signer">>
): EvmX402Payer {
  return new EvmX402Payer({ signer, ...options });
}

// ---------------------------------------------------------------------------
// Constants Export
// ---------------------------------------------------------------------------

/**
 * USDC contract addresses by chain.
 *
 * These are the official Circle USDC addresses that support EIP-3009.
 */
export const USDC_ADDRESSES: Record<string, `0x${string}`> = {
  /** Base Mainnet USDC */
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  /** Base Sepolia Testnet USDC */
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

/**
 * Supported chain IDs for x402 payments.
 */
export const SUPPORTED_CHAINS = ["eip155:8453", "eip155:84532"] as const;

/**
 * Type for supported chain IDs.
 */
export type SupportedChainId = (typeof SUPPORTED_CHAINS)[number];

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Package version.
 * Updated automatically during build.
 */
export const VERSION = "0.0.0";
