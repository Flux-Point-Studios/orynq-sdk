/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-evm-direct/src/usdc-transfer.ts
 * @summary ERC-20 transfer and balance query utilities using viem.
 *
 * This file provides helper functions for executing ERC-20 token transfers
 * and querying balances. It handles the mapping from CAIP-2 chain identifiers
 * to viem Chain objects and includes contract simulation before execution.
 *
 * Key features:
 * - Real ERC-20 transfer transactions via viem
 * - Proper gas estimation with retry logic for higher gas limits
 * - Transaction confirmation waiting (waitForTransactionReceipt)
 * - Support for multiple chains: Base, Base Sepolia, Ethereum, Polygon, Arbitrum
 * - Comprehensive error handling with PaymentError wrapping
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
  encodeFunctionData,
  BaseError,
  ContractFunctionRevertedError,
  InsufficientFundsError as ViemInsufficientFundsError,
} from "viem";
import { base, baseSepolia, mainnet, polygon, arbitrum } from "viem/chains";
import { USDC_ADDRESSES, ERC20_ABI } from "./constants.js";
import type { ChainId } from "@poi-sdk/core";
import { PaymentFailedError } from "@poi-sdk/core";

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

  /**
   * Gas limit multiplier for retry attempts.
   * When gas estimation fails, the estimated gas is multiplied by this value.
   *
   * @default 1.2 (20% buffer)
   */
  gasMultiplier?: number;

  /**
   * Maximum number of retry attempts for gas estimation failures.
   *
   * @default 3
   */
  maxRetries?: number;
}

/**
 * Options for gas estimation with retry logic.
 */
export interface GasEstimationOptions {
  /** Gas limit multiplier for retries */
  gasMultiplier?: number;
  /** Maximum retry attempts */
  maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Transfer Function
// ---------------------------------------------------------------------------

/**
 * Execute an ERC-20 token transfer with proper gas estimation and retry logic.
 *
 * This function:
 * 1. Resolves the contract address (USDC or custom)
 * 2. Estimates gas with retry logic for failures
 * 3. Simulates the transfer to check for errors
 * 4. Executes the transfer transaction
 * 5. Waits for transaction confirmation
 *
 * Gas estimation failures trigger retries with progressively higher gas limits.
 * RPC errors are wrapped in PaymentFailedError for consistent error handling.
 *
 * @param params - Transfer parameters
 * @returns Transaction hash as hex string
 * @throws PaymentFailedError if no USDC address configured for chain
 * @throws PaymentFailedError if transfer simulation fails (insufficient balance, allowance, etc.)
 * @throws PaymentFailedError if transaction reverts or RPC errors occur
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
    gasMultiplier = 1.2,
    maxRetries = 3,
  } = params;

  // Resolve contract address
  const contractAddress =
    asset === "USDC" ? USDC_ADDRESSES[chain] : (asset as `0x${string}`);

  if (!contractAddress) {
    throw new PaymentFailedError(
      {
        protocol: "flux",
        chain,
        asset,
        amountUnits: amount.toString(),
        payTo: to,
      },
      `No USDC address configured for chain ${chain}. ` +
        `Supported chains: ${Object.keys(USDC_ADDRESSES).join(", ")}`
    );
  }

  // Encode the transfer function call
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to, amount],
  });

  // Estimate gas with retry logic
  let estimatedGas: bigint;
  try {
    estimatedGas = await estimateGasWithRetry(
      publicClient,
      walletClient.account.address,
      contractAddress,
      data,
      { gasMultiplier, maxRetries }
    );
  } catch (error) {
    throw wrapRpcError(error, chain, asset, amount.toString(), to);
  }

  // Simulate the transfer to catch errors before execution
  // This validates balance, allowance, and other contract requirements
  try {
    const { request } = await publicClient.simulateContract({
      address: contractAddress,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [to, amount],
      account: walletClient.account,
      gas: estimatedGas,
    });

    // Execute the transfer
    const hash = await walletClient.writeContract(request);

    // Wait for transaction confirmation
    // This ensures the transaction is included in a block
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    // Check if transaction was successful
    if (receipt.status === "reverted") {
      throw new PaymentFailedError(
        {
          protocol: "flux",
          chain,
          asset,
          amountUnits: amount.toString(),
          payTo: to,
        },
        "Transaction reverted on-chain",
        hash
      );
    }

    return hash;
  } catch (error) {
    // If already a PaymentFailedError, rethrow
    if (error instanceof PaymentFailedError) {
      throw error;
    }
    throw wrapRpcError(error, chain, asset, amount.toString(), to);
  }
}

/**
 * Estimate gas with retry logic for failures.
 *
 * When gas estimation fails, retries with a higher gas limit using the multiplier.
 * This handles cases where the initial estimation is too conservative.
 *
 * @param publicClient - Viem public client
 * @param from - Sender address
 * @param to - Contract address
 * @param data - Encoded function call
 * @param options - Gas estimation options
 * @returns Estimated gas as bigint
 * @throws Original error after all retries exhausted
 */
async function estimateGasWithRetry(
  publicClient: PublicClient,
  from: `0x${string}`,
  to: `0x${string}`,
  data: `0x${string}`,
  options: GasEstimationOptions = {}
): Promise<bigint> {
  const { gasMultiplier = 1.2, maxRetries = 3 } = options;

  let lastError: Error | undefined;
  let gasLimit: bigint | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const estimated = await publicClient.estimateGas({
        account: from,
        to,
        data,
        gas: gasLimit,
      });

      // Apply multiplier for buffer
      return BigInt(Math.ceil(Number(estimated) * gasMultiplier));
    } catch (error) {
      lastError = error as Error;

      // If we have a previous estimate, try with higher gas
      if (gasLimit) {
        gasLimit = BigInt(Math.ceil(Number(gasLimit) * gasMultiplier));
      } else {
        // Start with a reasonable default for ERC-20 transfers
        gasLimit = BigInt(100000);
      }
    }
  }

  throw lastError ?? new Error("Gas estimation failed after retries");
}

/**
 * Wrap RPC errors in PaymentFailedError for consistent error handling.
 *
 * Maps viem error types to meaningful error messages:
 * - InsufficientFundsError: Not enough ETH for gas
 * - ContractFunctionRevertedError: Contract rejected the call
 * - BaseError: Generic viem errors
 *
 * @param error - Original error
 * @param chain - CAIP-2 chain identifier
 * @param asset - Asset identifier
 * @param amount - Amount in atomic units
 * @param to - Recipient address
 * @returns PaymentFailedError with appropriate message
 */
function wrapRpcError(
  error: unknown,
  chain: ChainId,
  asset: string,
  amount: string,
  to: string
): PaymentFailedError {
  const request = {
    protocol: "flux" as const,
    chain,
    asset,
    amountUnits: amount,
    payTo: to,
  };

  // Handle viem-specific errors
  if (error instanceof ViemInsufficientFundsError) {
    return new PaymentFailedError(
      request,
      "Insufficient ETH for gas fees",
      undefined,
      error
    );
  }

  if (error instanceof ContractFunctionRevertedError) {
    const reason = error.reason ?? "Contract function reverted";
    return new PaymentFailedError(request, reason, undefined, error);
  }

  if (error instanceof BaseError) {
    return new PaymentFailedError(
      request,
      `RPC error: ${error.shortMessage ?? error.message}`,
      undefined,
      error
    );
  }

  // Generic error wrapping
  const message =
    error instanceof Error ? error.message : "Unknown transfer error";
  return new PaymentFailedError(
    request,
    message,
    undefined,
    error instanceof Error ? error : undefined
  );
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
