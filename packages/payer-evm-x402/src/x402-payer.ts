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
 * - Supports Base mainnet and Base Sepolia USDC
 * - Returns x402-signature proof type for facilitator submission
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
import { base, baseSepolia } from "viem/chains";
import type {
  Payer,
  PaymentProof,
  PaymentRequest,
  ChainId,
} from "@poi-sdk/core";
import { InsufficientBalanceError } from "@poi-sdk/core";
import type { ViemSigner } from "./signers/viem-signer.js";

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
  /** Base Mainnet USDC */
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  /** Base Sepolia Testnet USDC */
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

/**
 * Viem chain configurations indexed by CAIP-2 chain identifier.
 */
const CHAIN_CONFIGS: Record<ChainId, Chain> = {
  "eip155:8453": base,
  "eip155:84532": baseSepolia,
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
   * @throws Error if chain is not supported
   */
  async getBalance(chain: ChainId, asset: string): Promise<bigint> {
    const viemChain = CHAIN_CONFIGS[chain];
    if (!viemChain) {
      throw new Error(`Unsupported chain: ${chain}`);
    }

    const publicClient = this.getPublicClient(chain);
    const address = (await this.getAddress(chain)) as `0x${string}`;

    // Handle native asset (ETH)
    if (asset === "ETH" || asset === "native") {
      return publicClient.getBalance({ address });
    }

    // Resolve USDC to chain-specific address
    const contractAddress =
      asset === "USDC" ? USDC_ADDRESSES[chain] : (asset as `0x${string}`);

    if (!contractAddress) {
      throw new Error(`No address for asset ${asset} on ${chain}`);
    }

    // Query ERC-20 balance
    const balance = await publicClient.readContract({
      address: contractAddress,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [address],
    });

    return balance as bigint;
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
   * @throws Error if protocol is not "x402"
   * @throws InsufficientBalanceError if balance is too low
   */
  async pay(request: PaymentRequest): Promise<PaymentProof> {
    if (request.protocol !== "x402") {
      throw new Error(
        `EvmX402Payer only supports x402 protocol, got: ${request.protocol}`
      );
    }

    // Validate chain support
    if (!CHAIN_CONFIGS[request.chain]) {
      throw new Error(`Unsupported chain: ${request.chain}`);
    }

    // Check balance before creating signature
    const balance = await this.getBalance(request.chain, request.asset);
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
   */
  private async createX402Signature(request: PaymentRequest): Promise<string> {
    const viemChain = CHAIN_CONFIGS[request.chain];
    if (!viemChain) {
      throw new Error(`Unsupported chain: ${request.chain}`);
    }

    const account = this.signer.getAccount();

    // EIP-3009 transferWithAuthorization parameters
    const from = account.address;
    const to = request.payTo as `0x${string}`;
    const value = BigInt(request.amountUnits);

    // Valid immediately
    const validAfter = 0n;

    // Valid for the specified timeout (default 1 hour)
    const validBefore = BigInt(
      Math.floor(Date.now() / 1000) + (request.timeoutSeconds ?? 3600)
    );

    // Generate random nonce for replay protection
    const nonceBytes = new Uint8Array(32);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      crypto.getRandomValues(nonceBytes);
    } else {
      // Fallback for environments without Web Crypto API
      for (let i = 0; i < 32; i++) {
        nonceBytes[i] = Math.floor(Math.random() * 256);
      }
    }
    const nonce = BigInt("0x" + bytesToHex(nonceBytes));

    // Resolve contract address
    const contractAddress =
      request.asset === "USDC"
        ? USDC_ADDRESSES[request.chain]
        : (request.asset as `0x${string}`);

    if (!contractAddress) {
      throw new Error(`No contract for ${request.asset} on ${request.chain}`);
    }

    // EIP-712 domain for USDC (version 2)
    const domain = {
      name: "USD Coin",
      version: "2",
      chainId: BigInt(viemChain.id),
      verifyingContract: contractAddress,
    };

    // EIP-3009 TransferWithAuthorization type definition
    const types = {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    };

    // Message to sign
    const message = {
      from,
      to,
      value,
      validAfter,
      validBefore,
      nonce: ("0x" + nonce.toString(16).padStart(64, "0")) as `0x${string}`,
    };

    // Sign the typed data using EIP-712
    if (!account.signTypedData) {
      throw new Error(
        "Account does not support signTypedData. " +
          "EIP-712 typed data signing is required for x402 payments."
      );
    }

    const signature = await account.signTypedData({
      domain,
      types,
      primaryType: "TransferWithAuthorization",
      message,
    });

    // Return combined payload that includes signature + parameters
    // This is what the facilitator needs to execute the transfer
    const payload = {
      signature,
      from,
      to,
      value: value.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce: "0x" + nonce.toString(16).padStart(64, "0"),
      chainId: viemChain.id,
      contract: contractAddress,
    };

    // Encode as base64 for transport in HTTP header
    return stringToBase64(JSON.stringify(payload));
  }
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Convert Uint8Array to hex string (without 0x prefix).
 *
 * @param bytes - Bytes to convert
 * @returns Hex string
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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
