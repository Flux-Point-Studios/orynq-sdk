/**
 * @summary Main entry point for @fluxpointstudios/poi-sdk-payer-evm-direct package.
 *
 * This package provides a legacy EVM payer for direct ERC-20 transfers.
 * It implements the Payer interface from @fluxpointstudios/poi-sdk-core and returns
 * evm-txhash proof types for servers that verify payments on-chain.
 *
 * Key features:
 * - Direct ERC-20 transfers using viem
 * - Support for Base, Ethereum, Polygon, and Arbitrum
 * - Pre-configured USDC contract addresses
 * - Balance checking before transfer
 * - NOT x402 compatible - for servers accepting raw txHash
 *
 * Usage:
 * ```typescript
 * import { createEvmPayer, ViemPayer } from "@fluxpointstudios/poi-sdk-payer-evm-direct";
 *
 * // Using factory function
 * const payer = createEvmPayer("0x...", {
 *   chains: ["eip155:8453"],
 * });
 *
 * // Or using class directly
 * const payer = new ViemPayer({
 *   privateKey: "0x...",
 *   chains: ["eip155:8453", "eip155:84532"],
 *   rpcUrls: { "eip155:8453": "https://mainnet.base.org" },
 * });
 *
 * // Execute payment
 * const proof = await payer.pay(request);
 * // proof = { kind: "evm-txhash", txHash: "0x..." }
 * ```
 */

// ---------------------------------------------------------------------------
// Main Payer Export
// ---------------------------------------------------------------------------

export { ViemPayer, type ViemPayerConfig } from "./viem-payer.js";

// ---------------------------------------------------------------------------
// Transfer Utilities
// ---------------------------------------------------------------------------

export {
  transferErc20,
  getErc20Balance,
  getViemChain,
  isChainSupported,
  getSupportedChains,
  CHAIN_CONFIGS,
  type TransferParams,
  type GasEstimationOptions,
} from "./usdc-transfer.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export {
  USDC_ADDRESSES,
  ERC20_ABI,
  hasUsdcSupport,
  getUsdcAddress,
  type SupportedUsdcChain,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Factory Function
// ---------------------------------------------------------------------------

import { ViemPayer, type ViemPayerConfig } from "./viem-payer.js";

/**
 * Convenience factory function for creating a ViemPayer with a private key.
 *
 * This is a simpler alternative to the class constructor when you only
 * need to provide a private key and optional configuration.
 *
 * @param privateKey - Private key as hex string (0x prefix + 64 hex chars)
 * @param options - Optional additional configuration
 * @returns Configured ViemPayer instance
 *
 * @example
 * ```typescript
 * import { createEvmPayer } from "@fluxpointstudios/poi-sdk-payer-evm-direct";
 *
 * // Simple usage with defaults (Base mainnet + Sepolia)
 * const payer = createEvmPayer("0x...");
 *
 * // With custom options
 * const payer = createEvmPayer("0x...", {
 *   chains: ["eip155:1", "eip155:137", "eip155:42161"],
 *   rpcUrls: {
 *     "eip155:1": process.env.ETH_RPC_URL,
 *     "eip155:137": process.env.POLYGON_RPC_URL,
 *   },
 * });
 * ```
 */
export function createEvmPayer(
  privateKey: `0x${string}`,
  options?: Omit<ViemPayerConfig, "privateKey">
): ViemPayer {
  return new ViemPayer({ privateKey, ...options });
}
