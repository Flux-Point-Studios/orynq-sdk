/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/server-middleware/src/verifiers/evm.ts
 * @summary EVM blockchain payment verifier using viem for transaction verification.
 *
 * This file implements the ChainVerifier interface for EVM-compatible chains
 * including Ethereum mainnet, Base, and their testnets. It uses viem for
 * blockchain interaction and supports verification of transaction hash proofs
 * and x402 signature proofs.
 *
 * Used by:
 * - Express middleware for verifying EVM payment proofs
 * - Fastify plugin for verifying EVM payment proofs
 */

import type { ChainId, PaymentProof } from "@poi-sdk/core";
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
    Pick<EvmVerifierConfig, "timeout" | "minConfirmations" | "trustFacilitator">
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

      // Get transaction receipt
      let receipt: TransactionReceipt;
      try {
        receipt = await client.getTransactionReceipt({ hash: txHash });
      } catch {
        return {
          verified: false,
          error: `Transaction not found or not yet confirmed: ${txHash}`,
        };
      }

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
   */
  private async verifyTransactionDetails(
    client: PublicClient,
    txHash: `0x${string}`,
    receipt: TransactionReceipt,
    expectedAmount: bigint,
    expectedRecipient: string
  ): Promise<{ verified: boolean; error?: string }> {
    const normalizedRecipient = expectedRecipient.toLowerCase();

    // Check for ERC-20 Transfer events
    const transferLogs = receipt.logs.filter(
      (log) => log.topics[0] === ERC20_TRANSFER_TOPIC
    );

    if (transferLogs.length > 0) {
      // ERC-20 transfer
      for (const log of transferLogs) {
        // topics[2] is the 'to' address (padded to 32 bytes)
        const toAddress = log.topics[2];
        if (!toAddress) continue;

        // Extract address from padded topic
        const toAddressHex = "0x" + toAddress.slice(26).toLowerCase();

        if (toAddressHex === normalizedRecipient) {
          // Decode amount from data
          const amount = BigInt(log.data);
          if (amount >= expectedAmount) {
            return { verified: true };
          }
        }
      }

      return {
        verified: false,
        error: `ERC-20 transfer does not match expected payment. Expected ${expectedAmount} to ${expectedRecipient}`,
      };
    }

    // Check for native transfer
    try {
      const tx = await client.getTransaction({ hash: txHash });

      if (
        tx.to?.toLowerCase() === normalizedRecipient &&
        tx.value >= expectedAmount
      ) {
        return { verified: true };
      }

      return {
        verified: false,
        error: `Native transfer does not match expected payment. Expected ${expectedAmount} to ${expectedRecipient}`,
      };
    } catch {
      return {
        verified: false,
        error: "Failed to fetch transaction details",
      };
    }
  }
}
