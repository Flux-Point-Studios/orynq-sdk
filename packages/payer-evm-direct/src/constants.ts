/**
 * @summary USDC contract addresses and ERC-20 ABI definitions for supported chains.
 *
 * This file contains the pre-configured USDC contract addresses for each supported
 * EVM chain (identified by CAIP-2 format) and the minimal ERC-20 ABI required
 * for balance checking and transfer operations.
 *
 * Used by:
 * - usdc-transfer.ts for resolving USDC contract addresses
 * - viem-payer.ts for balance and transfer operations
 */

// ---------------------------------------------------------------------------
// USDC Contract Addresses
// ---------------------------------------------------------------------------

/**
 * USDC contract addresses indexed by CAIP-2 chain identifier.
 *
 * These are the official Circle USDC contract addresses for each chain.
 * All addresses are checksummed and typed as hex strings.
 */
export const USDC_ADDRESSES: Record<string, `0x${string}`> = {
  /** Ethereum Mainnet (EIP-155 Chain ID: 1) */
  "eip155:1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",

  /** Base Mainnet (EIP-155 Chain ID: 8453) */
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",

  /** Base Sepolia Testnet (EIP-155 Chain ID: 84532) */
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",

  /** Polygon Mainnet (EIP-155 Chain ID: 137) */
  "eip155:137": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",

  /** Arbitrum One Mainnet (EIP-155 Chain ID: 42161) */
  "eip155:42161": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
};

// ---------------------------------------------------------------------------
// ERC-20 ABI
// ---------------------------------------------------------------------------

/**
 * Minimal ERC-20 ABI for balance queries and transfers.
 *
 * This includes only the functions needed for the payer operations:
 * - transfer: Send tokens to a recipient
 * - balanceOf: Query token balance
 * - decimals: Get token decimal places
 *
 * The ABI is typed as const for full type inference with viem.
 */
export const ERC20_ABI = [
  {
    constant: false,
    inputs: [
      { name: "_to", type: "address" },
      { name: "_value", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    type: "function",
  },
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "function",
  },
  {
    constant: true,
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    type: "function",
  },
] as const;

// ---------------------------------------------------------------------------
// Type Exports
// ---------------------------------------------------------------------------

/**
 * Supported chain IDs for USDC operations.
 */
export type SupportedUsdcChain = keyof typeof USDC_ADDRESSES;

/**
 * Check if a chain ID has a known USDC address.
 *
 * @param chainId - CAIP-2 chain identifier
 * @returns true if the chain has a configured USDC address
 */
export function hasUsdcSupport(chainId: string): chainId is SupportedUsdcChain {
  return chainId in USDC_ADDRESSES;
}

/**
 * Get the USDC address for a chain, or undefined if not supported.
 *
 * @param chainId - CAIP-2 chain identifier
 * @returns USDC contract address or undefined
 */
export function getUsdcAddress(chainId: string): `0x${string}` | undefined {
  return USDC_ADDRESSES[chainId];
}
