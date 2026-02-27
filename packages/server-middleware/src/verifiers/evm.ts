/**
 * @summary EVM blockchain payment verifier using viem for transaction verification.
 *
 * This file implements the ChainVerifier interface for EVM-compatible chains
 * including Ethereum mainnet, Base, and their testnets. It uses viem for
 * blockchain interaction and supports verification of transaction hash proofs
 * and x402 signature proofs.
 *
 * Verification flow:
 * 1. Query transaction receipt via viem/RPC (eth_getTransactionReceipt)
 * 2. For direct transfers:
 *    - Verify Transfer event in logs
 *    - Check recipient and amount match
 * 3. For EIP-3009 (TransferWithAuthorization):
 *    - Verify TransferWithAuthorization event
 *    - Check from, to, value match
 * 4. Check block confirmations (eth_blockNumber)
 * 5. Return verification result
 *
 * Used by:
 * - Express middleware for verifying EVM payment proofs
 * - Fastify plugin for verifying EVM payment proofs
 */

import type { ChainId, PaymentProof } from "@fluxpointstudios/orynq-sdk-core";
import type { ChainVerifier, VerificationResult } from "./interface.js";

// ---------------------------------------------------------------------------
// Viem Imports (Dynamic)
// ---------------------------------------------------------------------------

// We import viem dynamically to make it an optional peer dependency.
// This allows the package to be used without viem if only Cardano verification is needed.

type PublicClient = {
  getTransactionReceipt: (args: { hash: `0x${string}` }) => Promise<TransactionReceipt>;
  getTransaction: (args: { hash: `0x${string}` }) => Promise<Transaction>;
  getBlockNumber: () => Promise<bigint>;
};

interface TransactionReceipt {
  transactionHash: `0x${string}`;
  blockNumber: bigint;
  blockHash: `0x${string}`;
  status: "success" | "reverted";
  logs: Array<{
    address: `0x${string}`;
    topics: readonly `0x${string}`[];
    data: `0x${string}`;
  }>;
}

interface Transaction {
  hash: `0x${string}`;
  blockNumber: bigint | null;
  to: `0x${string}` | null;
  value: bigint;
  input: `0x${string}`;
}

interface ViemChain {
  id: number;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: { default: { http: readonly string[] } };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration options for the EVM verifier.
 */
export interface EvmVerifierConfig {
  /**
   * Custom RPC URLs for each chain.
   * If not provided, default public RPC endpoints will be used.
   *
   * @example { "eip155:8453": "https://mainnet.base.org" }
   */
  rpcUrls?: Record<ChainId, string>;

  /**
   * Chains to support.
   * @default ["eip155:8453", "eip155:84532"] (Base mainnet and testnet)
   */
  chains?: ChainId[];

  /**
   * Request timeout in milliseconds.
   * @default 30000 (30 seconds)
   */
  timeout?: number;

  /**
   * Minimum confirmations required for verification.
   * @default 1
   */
  minConfirmations?: number;

  /**
   * Whether to trust x402 facilitator signatures without on-chain verification.
   * When true, x402-signature proofs are accepted without additional checks.
   * @default true
   */
  trustFacilitator?: boolean;

  /**
   * Number of retry attempts for RPC calls.
   * @default 3
   */
  retryAttempts?: number;

  /**
   * Base delay in milliseconds between retries (exponential backoff).
   * @default 1000
   */
  retryBaseDelayMs?: number;

  /**
   * Token contract address to verify transfers for.
   * If provided, only Transfer events from this contract will be checked.
   * Useful when verifying stablecoin payments like USDC.
   */
  tokenAddress?: string;
}

// ---------------------------------------------------------------------------
// Chain Configuration
// ---------------------------------------------------------------------------

/**
 * Default supported chains with their CAIP-2 IDs and EVM chain IDs.
 */
const DEFAULT_CHAINS: Record<ChainId, { evmChainId: number; name: string }> = {
  "eip155:1": { evmChainId: 1, name: "Ethereum Mainnet" },
  "eip155:8453": { evmChainId: 8453, name: "Base Mainnet" },
  "eip155:84532": { evmChainId: 84532, name: "Base Sepolia" },
  "eip155:11155111": { evmChainId: 11155111, name: "Sepolia" },
};

/**
 * ERC-20 Transfer event topic (keccak256 of "Transfer(address,address,uint256)").
 */
const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * EIP-3009 TransferWithAuthorization event topic.
 * keccak256("TransferWithAuthorization(address,address,uint256,uint256,uint256,bytes32)")
 */
const EIP3009_TRANSFER_WITH_AUTHORIZATION_TOPIC =
  "0xe3034f62cd2b7c3c0c0e74e5e4b6c5c8e33d39a6dd9e7df4f7d6f79a0f0e5d9c";

/**
 * EIP-3009 ReceiveWithAuthorization event topic.
 * keccak256("ReceiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32)")
 * Note: This is an alternative event some contracts emit
 */
const EIP3009_RECEIVE_WITH_AUTHORIZATION_TOPIC =
  "0x1cdd46ff242716cdaa72d159d339a485b3438398348d68f09d7c8c0a59353d81";

// ---------------------------------------------------------------------------
// EVM Verifier Implementation
// ---------------------------------------------------------------------------

/**
 * Payment verifier for EVM-compatible blockchains.
 *
 * Supports verification of:
 * - Transaction hash proofs (evm-txhash) - verifies on-chain transactions
 * - x402 signature proofs (x402-signature) - trusts facilitator attestation
 *
 * Uses viem for blockchain interaction with support for custom RPC endpoints.
 *
 * @example
 * ```typescript
 * const verifier = new EvmVerifier({
 *   chains: ["eip155:8453", "eip155:84532"],
 *   rpcUrls: {
 *     "eip155:8453": "https://mainnet.base.org",
 *   },
 * });
 *
 * const result = await verifier.verify(
 *   { kind: "evm-txhash", txHash: "0x..." },
 *   BigInt("1000000"),
 *   "0x...",
 *   "eip155:8453"
 * );
 * ```
 */
export class EvmVerifier implements ChainVerifier {
  readonly supportedChains: ChainId[];

  private readonly config: Required<
    Pick<EvmVerifierConfig, "timeout" | "minConfirmations" | "trustFacilitator" | "retryAttempts" | "retryBaseDelayMs">
  > &
    EvmVerifierConfig;

  private clientCache: Map<ChainId, PublicClient> = new Map();
  private viemImport: Promise<typeof import("viem")> | null = null;
  private viemChainsImport: Promise<typeof import("viem/chains")> | null = null;

  /**
   * Create a new EVM verifier instance.
   *
   * @param config - Verifier configuration
   */
  constructor(config: EvmVerifierConfig = {}) {
    this.config = {
      timeout: 30000,
      minConfirmations: 1,
      trustFacilitator: true,
      retryAttempts: 3,
      retryBaseDelayMs: 1000,
      ...config,
    };

    // Set supported chains
    this.supportedChains = config.chains ?? ["eip155:8453", "eip155:84532"];
  }

  /**
   * Verify an EVM payment proof.
   *
   * @param proof - Payment proof (txHash or x402 signature)
   * @param expectedAmount - Expected amount in wei/smallest units
   * @param expectedRecipient - Expected recipient address (0x prefixed)
   * @param chain - Chain to verify on
   * @returns Verification result
   */
  async verify(
    proof: PaymentProof,
    expectedAmount: bigint,
    expectedRecipient: string,
    chain: ChainId
  ): Promise<VerificationResult> {
    // Validate proof kind
    if (proof.kind !== "evm-txhash" && proof.kind !== "x402-signature") {
      return {
        verified: false,
        error: `Unsupported proof kind: ${proof.kind}. Expected evm-txhash or x402-signature.`,
      };
    }

    // Validate chain
    if (!this.supportedChains.includes(chain)) {
      return {
        verified: false,
        error: `Chain ${chain} is not supported. Supported: ${this.supportedChains.join(", ")}`,
      };
    }

    // Handle x402 signature proofs
    if (proof.kind === "x402-signature") {
      if (this.config.trustFacilitator) {
        // Trust the facilitator's attestation
        return {
          verified: true,
          // No txHash for signature-based proofs
        };
      }
      // If not trusting facilitator, we would need to verify the signature
      // This requires the facilitator's public key and signature verification
      return {
        verified: false,
        error: "x402 signature verification requires trustFacilitator=true or external verification",
      };
    }

    // Verify transaction hash proof
    try {
      const txHash = proof.txHash as `0x${string}`;

      // Validate tx hash format
      if (!this.isValidTxHash(txHash)) {
        return {
          verified: false,
          error: `Invalid transaction hash format: ${txHash}`,
        };
      }

      // Get viem client
      const client = await this.getClient(chain);
      if (!client) {
        return {
          verified: false,
          error: `Failed to create client for chain ${chain}`,
        };
      }

      // Get transaction receipt with retry
      const receiptResult = await this.getReceiptWithRetry(client, txHash);

      if (receiptResult.notFound) {
        return {
          verified: false,
          error: `Transaction not found: ${txHash}`,
        };
      }

      if (receiptResult.pending) {
        return {
          verified: false,
          txHash,
          confirmations: 0,
          error: "Transaction pending - not yet confirmed",
        };
      }

      const receipt = receiptResult.receipt!;

      // Check transaction status
      if (receipt.status !== "success") {
        return {
          verified: false,
          txHash,
          error: "Transaction failed/reverted",
        };
      }

      // Get current block number for confirmation count
      const currentBlock = await client.getBlockNumber();
      const confirmations = Number(currentBlock - receipt.blockNumber) + 1;

      // Check minimum confirmations
      if (confirmations < this.config.minConfirmations) {
        return {
          verified: false,
          txHash,
          confirmations,
          error: `Insufficient confirmations: ${confirmations} < ${this.config.minConfirmations}`,
        };
      }

      // Verify the transaction matches expected payment
      const isValid = await this.verifyTransactionDetails(
        client,
        txHash,
        receipt,
        expectedAmount,
        expectedRecipient
      );

      if (!isValid.verified) {
        const failResult: VerificationResult = {
          verified: false,
          txHash,
          confirmations,
          blockNumber: Number(receipt.blockNumber),
        };
        if (isValid.error !== undefined) {
          failResult.error = isValid.error;
        }
        return failResult;
      }

      return {
        verified: true,
        txHash,
        confirmations,
        blockNumber: Number(receipt.blockNumber),
      };
    } catch (err) {
      return {
        verified: false,
        error: `Verification failed: ${(err as Error).message}`,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Validate transaction hash format (0x + 64 hex characters).
   */
  private isValidTxHash(txHash: string): boolean {
    return /^0x[0-9a-fA-F]{64}$/.test(txHash);
  }

  /**
   * Sleep for specified milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get transaction receipt with retry logic.
   * Distinguishes between "not found" and "pending" states.
   */
  private async getReceiptWithRetry(
    client: PublicClient,
    txHash: `0x${string}`
  ): Promise<{
    receipt?: TransactionReceipt;
    pending?: boolean;
    notFound?: boolean;
  }> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.config.retryAttempts; attempt++) {
      try {
        const receipt = await client.getTransactionReceipt({ hash: txHash });
        return { receipt };
      } catch (err) {
        lastError = err as Error;
        const errorMessage = lastError.message.toLowerCase();

        // Check if transaction exists but is not yet mined
        if (
          errorMessage.includes("transaction not found") ||
          errorMessage.includes("could not find")
        ) {
          // Try to get the transaction to check if it exists in mempool
          try {
            const tx = await client.getTransaction({ hash: txHash });
            if (tx && tx.blockNumber === null) {
              // Transaction exists but is pending
              return { pending: true };
            }
          } catch {
            // Transaction truly not found
          }
        }

        // Retry on network errors
        if (attempt < this.config.retryAttempts - 1) {
          await this.sleep(this.config.retryBaseDelayMs * Math.pow(2, attempt));
        }
      }
    }

    // After all retries, check one more time for pending tx
    try {
      const tx = await client.getTransaction({ hash: txHash });
      if (tx && tx.blockNumber === null) {
        return { pending: true };
      }
    } catch {
      // Transaction not found
    }

    return { notFound: true };
  }

  /**
   * Dynamically import viem.
   */
  private async getViem(): Promise<typeof import("viem")> {
    if (!this.viemImport) {
      this.viemImport = import("viem");
    }
    return this.viemImport;
  }

  /**
   * Dynamically import viem/chains.
   */
  private async getViemChains(): Promise<typeof import("viem/chains")> {
    if (!this.viemChainsImport) {
      this.viemChainsImport = import("viem/chains");
    }
    return this.viemChainsImport;
  }

  /**
   * Get or create a viem public client for the given chain.
   */
  private async getClient(chain: ChainId): Promise<PublicClient | null> {
    // Check cache
    const cached = this.clientCache.get(chain);
    if (cached) return cached;

    try {
      const viem = await this.getViem();
      const viemChains = await this.getViemChains();

      // Get chain configuration
      const chainConfig = DEFAULT_CHAINS[chain];
      if (!chainConfig) {
        return null;
      }

      // Get viem chain object
      let viemChain: ViemChain | undefined;
      switch (chainConfig.evmChainId) {
        case 1:
          viemChain = viemChains.mainnet as ViemChain;
          break;
        case 8453:
          viemChain = viemChains.base as ViemChain;
          break;
        case 84532:
          viemChain = viemChains.baseSepolia as ViemChain;
          break;
        case 11155111:
          viemChain = viemChains.sepolia as ViemChain;
          break;
      }

      if (!viemChain) {
        return null;
      }

      // Get RPC URL
      const rpcUrl = this.config.rpcUrls?.[chain];

      // Create client
      const client = viem.createPublicClient({
        chain: viemChain,
        transport: viem.http(rpcUrl),
      }) as unknown as PublicClient;

      // Cache client
      this.clientCache.set(chain, client);

      return client;
    } catch {
      return null;
    }
  }

  /**
   * Verify that transaction details match expected payment.
   * Supports:
   * - Native ETH transfers
   * - ERC-20 Transfer events
   * - EIP-3009 TransferWithAuthorization events
   */
  private async verifyTransactionDetails(
    client: PublicClient,
    txHash: `0x${string}`,
    receipt: TransactionReceipt,
    expectedAmount: bigint,
    expectedRecipient: string
  ): Promise<{ verified: boolean; error?: string }> {
    const normalizedRecipient = expectedRecipient.toLowerCase();
    const tokenAddress = this.config.tokenAddress?.toLowerCase();

    // 1. Check for EIP-3009 TransferWithAuthorization events
    const eip3009Result = this.verifyEIP3009Transfer(
      receipt.logs,
      normalizedRecipient,
      expectedAmount,
      tokenAddress
    );
    if (eip3009Result.verified) {
      return { verified: true };
    }

    // 2. Check for ERC-20 Transfer events
    const erc20Result = this.verifyERC20Transfer(
      receipt.logs,
      normalizedRecipient,
      expectedAmount,
      tokenAddress
    );
    if (erc20Result.verified) {
      return { verified: true };
    }

    // 3. Check for native transfer (only if no token address specified)
    if (!tokenAddress) {
      try {
        const tx = await client.getTransaction({ hash: txHash });

        if (
          tx.to?.toLowerCase() === normalizedRecipient &&
          tx.value >= expectedAmount
        ) {
          return { verified: true };
        }
      } catch {
        // Continue to return error below
      }
    }

    // Build detailed error message
    const transferType = tokenAddress ? "token" : "native or token";
    return {
      verified: false,
      error: `Amount mismatch: No ${transferType} transfer found with ${expectedAmount} to ${expectedRecipient}`,
    };
  }

  /**
   * Verify ERC-20 Transfer event in logs.
   */
  private verifyERC20Transfer(
    logs: TransactionReceipt["logs"],
    normalizedRecipient: string,
    expectedAmount: bigint,
    tokenAddress?: string
  ): { verified: boolean } {
    const transferLogs = logs.filter(
      (log) => log.topics[0] === ERC20_TRANSFER_TOPIC
    );

    for (const log of transferLogs) {
      // If token address specified, only check logs from that contract
      if (tokenAddress && log.address.toLowerCase() !== tokenAddress) {
        continue;
      }

      // topics[2] is the 'to' address (padded to 32 bytes)
      const toAddress = log.topics[2];
      if (!toAddress) continue;

      // Extract address from padded topic (remove 0x and leading zeros)
      const toAddressHex = "0x" + toAddress.slice(26).toLowerCase();

      if (toAddressHex === normalizedRecipient) {
        // Decode amount from data
        const amount = BigInt(log.data);
        if (amount >= expectedAmount) {
          return { verified: true };
        }
      }
    }

    return { verified: false };
  }

  /**
   * Verify EIP-3009 TransferWithAuthorization or ReceiveWithAuthorization event in logs.
   *
   * EIP-3009 event signature:
   * TransferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
   *
   * The event encodes:
   * - topics[0]: event signature hash
   * - topics[1]: from address (indexed)
   * - topics[2]: to address (indexed)
   * - data: abi.encode(value, validAfter, validBefore, nonce)
   */
  private verifyEIP3009Transfer(
    logs: TransactionReceipt["logs"],
    normalizedRecipient: string,
    expectedAmount: bigint,
    tokenAddress?: string
  ): { verified: boolean } {
    // Check both TransferWithAuthorization and ReceiveWithAuthorization events
    const eip3009Logs = logs.filter(
      (log) =>
        log.topics[0] === EIP3009_TRANSFER_WITH_AUTHORIZATION_TOPIC ||
        log.topics[0] === EIP3009_RECEIVE_WITH_AUTHORIZATION_TOPIC
    );

    for (const log of eip3009Logs) {
      // If token address specified, only check logs from that contract
      if (tokenAddress && log.address.toLowerCase() !== tokenAddress) {
        continue;
      }

      // topics[2] is the 'to' address (indexed, padded to 32 bytes)
      const toAddress = log.topics[2];
      if (!toAddress) continue;

      // Extract address from padded topic
      const toAddressHex = "0x" + toAddress.slice(26).toLowerCase();

      if (toAddressHex === normalizedRecipient) {
        // Decode value from data (first 32 bytes)
        // Data layout: value (32) | validAfter (32) | validBefore (32) | nonce (32)
        const valueHex = log.data.slice(0, 66); // "0x" + 64 hex chars
        const amount = BigInt(valueHex);
        if (amount >= expectedAmount) {
          return { verified: true };
        }
      }
    }

    return { verified: false };
  }
}
