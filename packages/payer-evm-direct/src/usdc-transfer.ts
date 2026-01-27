/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-evm-direct/src/usdc-transfer.ts
 * @summary ERC-20 transfer and balance query utilities using viem.
 *
 * This file provides helper functions for executing ERC-20 token transfers
 * and querying balances. It handles the mapping from CAIP-2 chain identifiers
 * to viem Chain objects and includes contract simulation before execution.
 *
 * Used by:
 * - viem-payer.ts for executing USDC/ERC-20 payments
 * - External code that needs direct ERC-20 transfer capabilities
 */

import {
  type Account,
  type Chain,
  type PublicClient,
  type WalletClient,
  type Transport,
} from "viem";
import { base, baseSepolia, mainnet, polygon, arbitrum } from "viem/chains";
import { USDC_ADDRESSES, ERC20_ABI } from "./constants.js";
import type { ChainId } from "@poi-sdk/core";

// ---------------------------------------------------------------------------
// Chain Configurations
// ---------------------------------------------------------------------------

/**
 * Mapping from CAIP-2 chain identifiers to viem Chain objects.
 *
 * Each entry maps a CAIP-2 identifier (e.g., "eip155:8453") to the
 * corresponding viem chain configuration for proper RPC interaction.
 */
export const CHAIN_CONFIGS: Record<string, Chain> = {
  /** Ethereum Mainnet */
  "eip155:1": mainnet,

  /** Base Mainnet */
  "eip155:8453": base,

  /** Base Sepolia Testnet */
  "eip155:84532": baseSepolia,

  /** Polygon Mainnet */
  "eip155:137": polygon,

  /** Arbitrum One Mainnet */
  "eip155:42161": arbitrum,
};

// ---------------------------------------------------------------------------
// Transfer Parameters
// ---------------------------------------------------------------------------

/**
 * Parameters for executing an ERC-20 transfer.
 */
export interface TransferParams {
  /** Viem wallet client with account for signing transactions */
  walletClient: WalletClient<Transport, Chain, Account>;

  /** Viem public client for simulation and receipt waiting */
  publicClient: PublicClient;

  /** CAIP-2 chain identifier (e.g., "eip155:8453") */
  chain: ChainId;

  /** Recipient address (checksummed hex) */
  to: `0x${string}`;

  /** Amount to transfer in atomic units (smallest denomination) */
  amount: bigint;

  /**
   * Asset identifier:
   * - "USDC": Uses pre-configured USDC address for the chain
   * - `0x${string}`: Custom ERC-20 contract address
   *
   * @default "USDC"
   */
  asset?: string;
}

// ---------------------------------------------------------------------------
// Transfer Function
// ---------------------------------------------------------------------------

/**
 * Execute an ERC-20 token transfer.
 *
 * This function:
 * 1. Resolves the contract address (USDC or custom)
 * 2. Simulates the transfer to check for errors
 * 3. Executes the transfer transaction
 * 4. Waits for transaction confirmation
 *
 * @param params - Transfer parameters
 * @returns Transaction hash as hex string
 * @throws Error if no USDC address configured for chain
 * @throws Error if transfer simulation fails (insufficient balance, allowance, etc.)
 * @throws Error if transaction reverts
 *
 * @example
 * ```typescript
 * const txHash = await transferErc20({
 *   walletClient,
 *   publicClient,
 *   chain: "eip155:8453",
 *   to: "0x1234...5678",
 *   amount: 1000000n, // 1 USDC
 *   asset: "USDC",
 * });
 * ```
 */
export async function transferErc20(
  params: TransferParams
): Promise<`0x${string}`> {
  const {
    walletClient,
    publicClient,
    chain,
    to,
    amount,
    asset = "USDC",
  } = params;

  // Resolve contract address
  const contractAddress =
    asset === "USDC" ? USDC_ADDRESSES[chain] : (asset as `0x${string}`);

  if (!contractAddress) {
    throw new Error(
      `No USDC address configured for chain ${chain}. ` +
        `Supported chains: ${Object.keys(USDC_ADDRESSES).join(", ")}`
    );
  }

  // Simulate the transfer to catch errors before execution
  // This validates balance, allowance, and other contract requirements
  const { request } = await publicClient.simulateContract({
    address: contractAddress,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to, amount],
    account: walletClient.account,
  });

  // Execute the transfer
  const hash = await walletClient.writeContract(request);

  // Wait for transaction confirmation
  // This ensures the transaction is included in a block
  await publicClient.waitForTransactionReceipt({ hash });

  return hash;
}

// ---------------------------------------------------------------------------
// Balance Query Function
// ---------------------------------------------------------------------------

/**
 * Query ERC-20 token balance for an address.
 *
 * @param publicClient - Viem public client for reading contract state
 * @param chain - CAIP-2 chain identifier
 * @param address - Address to query balance for
 * @param asset - Asset identifier ("USDC" or contract address)
 * @returns Balance in atomic units as bigint
 * @throws Error if no USDC address configured for chain
 *
 * @example
 * ```typescript
 * const balance = await getErc20Balance(
 *   publicClient,
 *   "eip155:8453",
 *   "0x1234...5678",
 *   "USDC"
 * );
 * console.log(`Balance: ${balance} USDC units`);
 * ```
 */
export async function getErc20Balance(
  publicClient: PublicClient,
  chain: ChainId,
  address: `0x${string}`,
  asset: string = "USDC"
): Promise<bigint> {
  // Resolve contract address
  const contractAddress =
    asset === "USDC" ? USDC_ADDRESSES[chain] : (asset as `0x${string}`);

  if (!contractAddress) {
    throw new Error(
      `No USDC address configured for chain ${chain}. ` +
        `Supported chains: ${Object.keys(USDC_ADDRESSES).join(", ")}`
    );
  }

  // Query balance from contract
  const balance = await publicClient.readContract({
    address: contractAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address],
  });

  return balance as bigint;
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Get the viem Chain configuration for a CAIP-2 chain ID.
 *
 * @param chainId - CAIP-2 chain identifier
 * @returns Viem Chain object or undefined if not supported
 */
export function getViemChain(chainId: ChainId): Chain | undefined {
  return CHAIN_CONFIGS[chainId];
}

/**
 * Check if a chain is supported for ERC-20 transfers.
 *
 * @param chainId - CAIP-2 chain identifier
 * @returns true if the chain has a viem configuration
 */
export function isChainSupported(chainId: ChainId): boolean {
  return chainId in CHAIN_CONFIGS;
}

/**
 * Get all supported chain IDs.
 *
 * @returns Array of CAIP-2 chain identifiers
 */
export function getSupportedChains(): ChainId[] {
  return Object.keys(CHAIN_CONFIGS);
}
