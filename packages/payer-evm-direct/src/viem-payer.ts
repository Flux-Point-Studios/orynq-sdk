/**
 * @summary Main Payer implementation for direct ERC-20 transfers using viem.
 *
 * This file implements the Payer interface from @fluxpointstudios/poi-sdk-core for executing
 * direct ERC-20 token transfers on EVM chains. It is the legacy payer for
 * servers that accept raw transaction hashes rather than x402 signatures.
 *
 * Key features:
 * - Supports multiple EVM chains (Base, Ethereum, Polygon, Arbitrum)
 * - Direct ERC-20 transfers without x402 facilitator
 * - Balance checking before payment execution
 * - Lazy client initialization for efficient resource usage
 *
 * NOT compatible with x402 protocol - use @fluxpointstudios/poi-sdk-payer-evm-x402 for that.
 *
 * Used by:
 * - Application code that needs to pay servers accepting raw txHash proofs
 * - Integration with legacy payment systems
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Chain,
  type PublicClient,
  type WalletClient,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type {
  Payer,
  PaymentProof,
  PaymentRequest,
  ChainId,
} from "@fluxpointstudios/poi-sdk-core";
import { InsufficientBalanceError } from "@fluxpointstudios/poi-sdk-core";
import { CHAIN_CONFIGS, transferErc20, getErc20Balance } from "./usdc-transfer.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration options for ViemPayer.
 */
export interface ViemPayerConfig {
  /**
   * Private key for signing transactions.
   * Must be a hex string starting with "0x" (64 hex chars + prefix).
   *
   * Either privateKey or account must be provided.
   */
  privateKey?: `0x${string}`;

  /**
   * Pre-configured viem Account for signing.
   * Use this when you already have an account from a wallet connector.
   *
   * Either privateKey or account must be provided.
   */
  account?: Account;

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
// Client Cache Entry
// ---------------------------------------------------------------------------

/**
 * Cached viem client pair for a chain.
 */
interface ClientPair {
  /** Public client for reading chain state */
  public: PublicClient;
  /** Wallet client for signing and sending transactions */
  wallet: WalletClient<Transport, Chain, Account>;
}

// ---------------------------------------------------------------------------
// ViemPayer Implementation
// ---------------------------------------------------------------------------

/**
 * Payer implementation for direct ERC-20 transfers using viem.
 *
 * This payer executes direct on-chain transfers and returns transaction hash
 * proofs. It is designed for servers that verify payments by checking
 * transaction hashes on-chain rather than using x402 signatures.
 *
 * @example
 * ```typescript
 * import { ViemPayer } from "@fluxpointstudios/poi-sdk-payer-evm-direct";
 *
 * const payer = new ViemPayer({
 *   privateKey: "0x...",
 *   chains: ["eip155:8453", "eip155:84532"],
 *   rpcUrls: {
 *     "eip155:8453": "https://mainnet.base.org",
 *   },
 * });
 *
 * // Check if payer supports a request
 * if (payer.supports(request)) {
 *   const proof = await payer.pay(request);
 *   // proof.kind === "evm-txhash"
 * }
 * ```
 */
export class ViemPayer implements Payer {
  /** List of CAIP-2 chain IDs this payer supports */
  readonly supportedChains: readonly ChainId[];

  /** The account used for signing transactions */
  private readonly account: Account;

  /** Cache of initialized viem clients per chain */
  private readonly clients: Map<ChainId, ClientPair> = new Map();

  /** Custom RPC URLs for chains */
  private readonly rpcUrls: Record<ChainId, string>;

  /**
   * Create a new ViemPayer instance.
   *
   * @param config - Payer configuration
   * @throws Error if neither privateKey nor account is provided
   */
  constructor(config: ViemPayerConfig) {
    if (!config.privateKey && !config.account) {
      throw new Error(
        "ViemPayer requires either privateKey or account in configuration"
      );
    }

    // Initialize account from private key or use provided account
    this.account = config.account ?? privateKeyToAccount(config.privateKey!);

    // Set supported chains (default to Base mainnet and Sepolia)
    this.supportedChains = config.chains ?? ["eip155:8453", "eip155:84532"];

    // Store custom RPC URLs
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
   * - The chain has a viem configuration
   *
   * @param request - Payment request to evaluate
   * @returns true if this payer can handle the request
   */
  supports(request: PaymentRequest): boolean {
    return (
      this.supportedChains.includes(request.chain) &&
      request.chain in CHAIN_CONFIGS
    );
  }

  /**
   * Get the payment address for a specific chain.
   *
   * For ViemPayer, all chains use the same address (derived from the private key).
   *
   * @param _chain - CAIP-2 chain identifier (unused, same address for all chains)
   * @returns Promise resolving to the address
   */
  async getAddress(_chain: ChainId): Promise<string> {
    return this.account.address;
  }

  /**
   * Get the current balance for an asset on a chain.
   *
   * Supports:
   * - Native assets: "ETH" or "native"
   * - ERC-20 tokens: "USDC" or contract address
   *
   * @param chain - CAIP-2 chain identifier
   * @param asset - Asset identifier
   * @returns Promise resolving to balance in atomic units as bigint
   * @throws Error if chain is not supported
   */
  async getBalance(chain: ChainId, asset: string): Promise<bigint> {
    const clients = await this.getClients(chain);

    // Handle native asset (ETH)
    if (asset === "ETH" || asset === "native") {
      return clients.public.getBalance({ address: this.account.address });
    }

    // Handle ERC-20 tokens (USDC or custom address)
    return getErc20Balance(clients.public, chain, this.account.address, asset);
  }

  /**
   * Execute a payment and return proof.
   *
   * This method:
   * 1. Calculates total amount including any additional splits
   * 2. Verifies sufficient balance
   * 3. Executes the transfer (ERC-20 or native ETH)
   * 4. Returns transaction hash proof
   *
   * Note: For split payments with mode "additional", only the main payment
   * is executed. Split handling requires separate implementation.
   *
   * @param request - Payment request to execute
   * @returns Promise resolving to payment proof with txHash
   * @throws InsufficientBalanceError if balance is too low
   * @throws Error if chain is not supported or transaction fails
   */
  async pay(request: PaymentRequest): Promise<PaymentProof> {
    const clients = await this.getClients(request.chain);

    // Calculate total amount including splits
    let totalAmount = BigInt(request.amountUnits);

    if (request.splits?.mode === "additional") {
      for (const split of request.splits.outputs) {
        totalAmount += BigInt(split.amountUnits);
      }
    }

    // Check balance before attempting transfer
    const balance = await this.getBalance(request.chain, request.asset);
    if (balance < totalAmount) {
      throw new InsufficientBalanceError(
        totalAmount.toString(),
        balance.toString(),
        request.asset,
        request.chain
      );
    }

    // Handle ERC-20 token transfers (USDC or custom contract)
    if (request.asset === "USDC" || request.asset.startsWith("0x")) {
      // Execute simple transfer to payTo address
      // Note: Multi-output split payments would require multiple transfers
      // or a batching contract - keeping simple for this implementation
      const txHash = await transferErc20({
        walletClient: clients.wallet,
        publicClient: clients.public,
        chain: request.chain,
        to: request.payTo as `0x${string}`,
        amount: BigInt(request.amountUnits),
        asset: request.asset,
      });

      return { kind: "evm-txhash", txHash };
    }

    // Handle native ETH transfers
    const hash = await clients.wallet.sendTransaction({
      to: request.payTo as `0x${string}`,
      value: BigInt(request.amountUnits),
    });

    // Wait for confirmation
    await clients.public.waitForTransactionReceipt({ hash });

    return { kind: "evm-txhash", txHash: hash };
  }

  // -------------------------------------------------------------------------
  // Private Methods
  // -------------------------------------------------------------------------

  /**
   * Get or create viem clients for a chain.
   *
   * Clients are lazily initialized and cached for reuse.
   *
   * @param chain - CAIP-2 chain identifier
   * @returns Promise resolving to public and wallet client pair
   * @throws Error if chain is not supported
   */
  private async getClients(chain: ChainId): Promise<ClientPair> {
    // Return cached clients if available
    const cached = this.clients.get(chain);
    if (cached) {
      return cached;
    }

    // Get viem chain configuration
    const viemChain = CHAIN_CONFIGS[chain];
    if (!viemChain) {
      throw new Error(
        `Unsupported chain: ${chain}. ` +
          `Supported chains: ${Object.keys(CHAIN_CONFIGS).join(", ")}`
      );
    }

    // Create transport with custom RPC if provided
    const rpcUrl = this.rpcUrls[chain];
    const transport = http(rpcUrl);

    // Create public client for reading chain state
    const publicClient = createPublicClient({
      chain: viemChain,
      transport,
    });

    // Create wallet client for signing and sending transactions
    const walletClient = createWalletClient({
      account: this.account,
      chain: viemChain,
      transport,
    });

    // Cache and return the client pair
    const clientPair: ClientPair = {
      public: publicClient,
      wallet: walletClient,
    };
    this.clients.set(chain, clientPair);

    return clientPair;
  }
}
