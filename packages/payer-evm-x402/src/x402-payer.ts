/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-evm-x402/src/x402-payer.ts
 * @summary Main Payer implementation for x402 protocol with EIP-3009 gasless signatures.
 *
 * This file implements the Payer interface from @poi-sdk/core for creating x402
 * payment signatures using EIP-3009 "Transfer With Authorization". Unlike direct
 * transfer payers, this payer creates cryptographic signatures that authorize
 * token transfers - the actual on-chain transaction is submitted by a facilitator.
 *
 * Key features:
 * - EIP-3009 "transferWithAuthorization" for gasless UX (buyer pays no gas)
 * - EIP-712 typed data signing for secure authorization
 * - Supports Base mainnet, Base Sepolia, Ethereum, and Polygon USDC
 * - Returns x402-signature proof type for facilitator submission
 * - Comprehensive error handling with PaymentError types
 *
 * Payment flow:
 * 1. Client receives 402 Payment Required with x402 headers
 * 2. Client calls payer.pay(request) to create signature
 * 3. Client sends signed authorization in PAYMENT-SIGNATURE header
 * 4. Server/facilitator executes the on-chain transfer
 *
 * Used by:
 * - @poi-sdk/client for automatic x402 payment handling
 * - Browser applications with wallet integration
 * - Node.js servers for automated payments
 */

import {
  createPublicClient,
  http,
  type Chain,
  type PublicClient,
} from "viem";
import { base, baseSepolia, mainnet, polygon } from "viem/chains";
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
  AssetNotSupportedError,
} from "@poi-sdk/core";
import type { ViemSigner } from "./signers/viem-signer.js";
import {
  buildTypedData,
  generateNonce,
  calculateValidity,
  serializeAuthorization,
  getUsdcDomainConfig,
  type Eip3009Authorization,
} from "./eip3009.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * USDC contract addresses indexed by CAIP-2 chain identifier.
 *
 * These are the official Circle USDC contract addresses that support
 * EIP-3009 "transferWithAuthorization".
 */
const USDC_ADDRESSES: Record<ChainId, `0x${string}`> = {
  /** Ethereum Mainnet USDC */
  "eip155:1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  /** Base Mainnet USDC */
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  /** Base Sepolia Testnet USDC */
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  /** Polygon Mainnet USDC */
  "eip155:137": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
};

/**
 * Viem chain configurations indexed by CAIP-2 chain identifier.
 */
const CHAIN_CONFIGS: Record<ChainId, Chain> = {
  "eip155:1": mainnet,
  "eip155:8453": base,
  "eip155:84532": baseSepolia,
  "eip155:137": polygon,
};

/**
 * ERC-20 balanceOf ABI fragment.
 */
const ERC20_BALANCE_ABI = [
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "function",
  },
] as const;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration options for EvmX402Payer.
 */
export interface EvmX402PayerConfig {
  /**
   * Signer for creating EIP-3009 signatures.
   * Must be a ViemSigner instance with an account that supports signTypedData.
   */
  signer: ViemSigner;

  /**
   * Custom RPC URLs for each chain.
   * If not provided, viem's default public RPC endpoints are used.
   *
   * @example
   * ```typescript
   * {
   *   "eip155:8453": "https://mainnet.base.org",
   *   "eip155:84532": "https://sepolia.base.org",
   * }
   * ```
   */
  rpcUrls?: Record<ChainId, string>;

  /**
   * List of chains this payer should support.
   * Defaults to Base mainnet and Base Sepolia if not specified.
   *
   * @default ["eip155:8453", "eip155:84532"]
   */
  chains?: ChainId[];
}

// ---------------------------------------------------------------------------
// EvmX402Payer Implementation
// ---------------------------------------------------------------------------

/**
 * EVM Payer using x402 protocol with EIP-3009 "Transfer With Authorization".
 *
 * This enables gasless payments where:
 * - The buyer signs an authorization (no gas required)
 * - The facilitator/server submits the transaction and pays gas
 * - The buyer's tokens are transferred atomically
 *
 * EIP-3009 provides:
 * - No need for approval transactions
 * - Time-bounded authorization (validAfter, validBefore)
 * - Nonce-based replay protection
 * - Atomic execution by any party
 *
 * @example
 * ```typescript
 * import { EvmX402Payer, ViemSigner } from "@poi-sdk/payer-evm-x402";
 *
 * const signer = new ViemSigner({ privateKey: "0x..." });
 * const payer = new EvmX402Payer({
 *   signer,
 *   chains: ["eip155:8453"], // Base mainnet only
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
 * // proof.kind === "x402-signature"
 * // Send proof.signature in PAYMENT-SIGNATURE header
 * ```
 */
export class EvmX402Payer implements Payer {
  /** List of CAIP-2 chain IDs this payer supports */
  readonly supportedChains: readonly ChainId[];

  /** Signer for creating EIP-3009 authorizations */
  private signer: ViemSigner;

  /** Custom RPC URLs for chains */
  private rpcUrls: Record<ChainId, string>;

  /** Cache of initialized public clients per chain */
  private publicClients: Map<ChainId, PublicClient> = new Map();

  /**
   * Create a new EvmX402Payer instance.
   *
   * @param config - Payer configuration with signer and optional chain settings
   */
  constructor(config: EvmX402PayerConfig) {
    this.signer = config.signer;
    this.supportedChains = config.chains ?? ["eip155:8453", "eip155:84532"];
    this.rpcUrls = config.rpcUrls ?? {};
  }

  // -------------------------------------------------------------------------
  // Payer Interface Implementation
  // -------------------------------------------------------------------------

  /**
   * Check if this payer can handle the given payment request.
   *
   * Verifies that:
   * - The chain is in the supported chains list
   * - The protocol is "x402"
   * - The chain has a known configuration
   *
   * @param request - Payment request to evaluate
   * @returns true if this payer can handle the request
   */
  supports(request: PaymentRequest): boolean {
    return (
      this.supportedChains.includes(request.chain) &&
      request.protocol === "x402" &&
      request.chain in CHAIN_CONFIGS
    );
  }

  /**
   * Get the payment address for a specific chain.
   *
   * For EVM chains, the same address is used across all chains.
   *
   * @param chain - CAIP-2 chain identifier
   * @returns Promise resolving to the address
   */
  async getAddress(chain: ChainId): Promise<string> {
    return this.signer.getAddress(chain);
  }

  /**
   * Get the current balance for an asset on a chain.
   *
   * Supports:
   * - Native assets: "ETH" or "native"
   * - USDC: "USDC" resolves to chain-specific contract
   * - Custom tokens: Contract address as asset identifier
   *
   * @param chain - CAIP-2 chain identifier
   * @param asset - Asset identifier
   * @returns Promise resolving to balance in atomic units as bigint
   * @throws ChainNotSupportedError if chain is not supported
   * @throws AssetNotSupportedError if asset is not supported on chain
   * @throws PaymentFailedError if RPC call fails
   */
  async getBalance(chain: ChainId, asset: string): Promise<bigint> {
    const viemChain = CHAIN_CONFIGS[chain];
    if (!viemChain) {
      throw new ChainNotSupportedError(chain, Object.keys(CHAIN_CONFIGS));
    }

    const publicClient = this.getPublicClient(chain);
    const address = (await this.getAddress(chain)) as `0x${string}`;

    try {
      // Handle native asset (ETH)
      if (asset === "ETH" || asset === "native") {
        return publicClient.getBalance({ address });
      }

      // Resolve USDC to chain-specific address
      const contractAddress =
        asset === "USDC" ? USDC_ADDRESSES[chain] : (asset as `0x${string}`);

      if (!contractAddress) {
        throw new AssetNotSupportedError(asset, chain);
      }

      // Query ERC-20 balance
      const balance = await publicClient.readContract({
        address: contractAddress,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [address],
      });

      return balance as bigint;
    } catch (error) {
      // Rethrow our custom errors
      if (
        error instanceof ChainNotSupportedError ||
        error instanceof AssetNotSupportedError
      ) {
        throw error;
      }

      // Wrap RPC errors
      throw new PaymentFailedError(
        {
          protocol: "x402",
          chain,
          asset,
          amountUnits: "0",
          payTo: "",
        },
        `Failed to query balance: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
        undefined,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Create an x402 payment signature using EIP-3009.
   *
   * This method does NOT submit a transaction - it creates a cryptographic
   * signature that authorizes a token transfer. The facilitator executes
   * the actual transfer using this signature.
   *
   * The signature includes:
   * - from: The payer's address
   * - to: The payment recipient
   * - value: The amount to transfer
   * - validAfter: Timestamp when authorization becomes valid (0 = immediately)
   * - validBefore: Timestamp when authorization expires
   * - nonce: Random value for replay protection
   *
   * @param request - Payment request to execute
   * @returns Promise resolving to x402-signature proof
   * @throws PaymentFailedError if protocol is not "x402"
   * @throws ChainNotSupportedError if chain is not supported
   * @throws InsufficientBalanceError if balance is too low
   */
  async pay(request: PaymentRequest): Promise<PaymentProof> {
    if (request.protocol !== "x402") {
      throw new PaymentFailedError(
        request,
        `EvmX402Payer only supports x402 protocol, got: ${request.protocol}`
      );
    }

    // Validate chain support
    if (!CHAIN_CONFIGS[request.chain]) {
      throw new ChainNotSupportedError(
        request.chain,
        Object.keys(CHAIN_CONFIGS)
      );
    }

    // Check balance before creating signature
    let balance: bigint;
    try {
      balance = await this.getBalance(request.chain, request.asset);
    } catch (error) {
      // If balance check fails, wrap in PaymentFailedError
      if (
        error instanceof InsufficientBalanceError ||
        error instanceof ChainNotSupportedError ||
        error instanceof AssetNotSupportedError
      ) {
        throw error;
      }
      throw new PaymentFailedError(
        request,
        `Failed to check balance: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
        undefined,
        error instanceof Error ? error : undefined
      );
    }

    const amount = BigInt(request.amountUnits);

    if (balance < amount) {
      throw new InsufficientBalanceError(
        request.amountUnits,
        balance.toString(),
        request.asset,
        request.chain
      );
    }

    // Create EIP-3009 signature
    const signature = await this.createX402Signature(request);

    return {
      kind: "x402-signature",
      signature,
      payload: JSON.stringify({
        chain: request.chain,
        asset: request.asset,
        amount: request.amountUnits,
        payTo: request.payTo,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Private Methods
  // -------------------------------------------------------------------------

  /**
   * Get or create a public client for a chain.
   *
   * Clients are lazily initialized and cached for reuse.
   *
   * @param chain - CAIP-2 chain identifier
   * @returns PublicClient for the chain
   */
  private getPublicClient(chain: ChainId): PublicClient {
    const cached = this.publicClients.get(chain);
    if (cached) {
      return cached;
    }

    const viemChain = CHAIN_CONFIGS[chain];
    if (!viemChain) {
      throw new Error(`Unsupported chain: ${chain}`);
    }

    const rpcUrl = this.rpcUrls[chain];
    const client = createPublicClient({
      chain: viemChain,
      transport: http(rpcUrl),
    });

    this.publicClients.set(chain, client);
    return client;
  }

  /**
   * Create an EIP-3009 "transferWithAuthorization" signature.
   *
   * EIP-3009 allows token holders to authorize transfers using a signature
   * instead of an on-chain approval. The signature can be executed by anyone
   * (typically the recipient or a relayer).
   *
   * The signature is created using EIP-712 typed data signing with the
   * TransferWithAuthorization type defined in the USDC contract.
   *
   * @param request - Payment request containing transfer details
   * @returns Base64-encoded JSON string containing signature and parameters
   * @throws PaymentFailedError if signing fails
   * @throws ChainNotSupportedError if chain is not supported
   * @throws AssetNotSupportedError if asset is not supported on chain
   */
  private async createX402Signature(request: PaymentRequest): Promise<string> {
    const viemChain = CHAIN_CONFIGS[request.chain];
    if (!viemChain) {
      throw new ChainNotSupportedError(
        request.chain,
        Object.keys(CHAIN_CONFIGS)
      );
    }

    const account = this.signer.getAccount();

    // Resolve contract address
    const contractAddress =
      request.asset === "USDC"
        ? USDC_ADDRESSES[request.chain]
        : (request.asset as `0x${string}`);

    if (!contractAddress) {
      throw new AssetNotSupportedError(request.asset, request.chain);
    }

    // Get USDC domain configuration for this chain
    const domainConfig = getUsdcDomainConfig(viemChain.id);

    // Calculate validity period
    const { validAfter, validBefore } = calculateValidity(
      request.timeoutSeconds ?? 3600
    );

    // Generate secure random nonce
    const nonce = generateNonce();

    // Build EIP-712 typed data
    const typedData = buildTypedData({
      tokenName: domainConfig.name,
      version: domainConfig.version,
      chainId: viemChain.id,
      tokenAddress: contractAddress,
      from: account.address,
      to: request.payTo as `0x${string}`,
      value: BigInt(request.amountUnits),
      validAfter,
      validBefore,
      nonce,
    });

    // Sign the typed data using EIP-712
    if (!account.signTypedData) {
      throw new PaymentFailedError(
        request,
        "Account does not support signTypedData. " +
          "EIP-712 typed data signing is required for x402 payments."
      );
    }

    let signature: `0x${string}`;
    try {
      signature = await account.signTypedData({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      });
    } catch (error) {
      throw new PaymentFailedError(
        request,
        `Failed to sign EIP-712 typed data: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
        undefined,
        error instanceof Error ? error : undefined
      );
    }

    // Create authorization object
    const authorization: Eip3009Authorization = {
      domain: typedData.domain,
      message: typedData.message,
      signature,
    };

    // Serialize for HTTP transport
    const serialized = serializeAuthorization(authorization);
    const json = JSON.stringify(serialized);

    // Encode as base64 for transport in HTTP header
    return stringToBase64(json);
  }
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Convert string to base64 encoding.
 * Works in both browser and Node.js environments.
 *
 * @param str - String to encode
 * @returns Base64 encoded string
 */
function stringToBase64(str: string): string {
  if (typeof btoa === "function") {
    // Browser environment
    return btoa(str);
  } else if (typeof Buffer !== "undefined") {
    // Node.js environment
    return Buffer.from(str, "utf-8").toString("base64");
  } else {
    throw new Error("No base64 encoding available in this environment");
  }
}
