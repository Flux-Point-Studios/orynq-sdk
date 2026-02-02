/**
 * @summary Unit tests for EVM payment verifier.
 *
 * Tests cover:
 * - Transaction hash validation
 * - Native ETH transfer verification
 * - ERC-20 Transfer event verification
 * - EIP-3009 TransferWithAuthorization verification
 * - Confirmation depth checking
 * - x402 signature proof handling
 * - Error handling scenarios
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EvmVerifier } from "../evm.js";
import type { EvmTxHashProof, X402SignatureProof } from "@fluxpointstudios/orynq-sdk-core";

// Mock viem module
vi.mock("viem", () => ({
  createPublicClient: vi.fn(),
  http: vi.fn(() => "http-transport"),
}));

vi.mock("viem/chains", () => ({
  mainnet: { id: 1, name: "Ethereum" },
  base: { id: 8453, name: "Base" },
  baseSepolia: { id: 84532, name: "Base Sepolia" },
  sepolia: { id: 11155111, name: "Sepolia" },
}));

// Test constants
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const EIP3009_TRANSFER_TOPIC = "0xe3034f62cd2b7c3c0c0e74e5e4b6c5c8e33d39a6dd9e7df4f7d6f79a0f0e5d9c";

describe("EvmVerifier", () => {
  let mockClient: {
    getTransactionReceipt: ReturnType<typeof vi.fn>;
    getTransaction: ReturnType<typeof vi.fn>;
    getBlockNumber: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    // Reset mocks
    mockClient = {
      getTransactionReceipt: vi.fn(),
      getTransaction: vi.fn(),
      getBlockNumber: vi.fn(),
    };

    // Setup viem mock to return our mock client
    const viem = await import("viem");
    (viem.createPublicClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("should create verifier with default config", () => {
      const verifier = new EvmVerifier();

      expect(verifier.supportedChains).toEqual(["eip155:8453", "eip155:84532"]);
    });

    it("should support custom chains", () => {
      const verifier = new EvmVerifier({
        chains: ["eip155:1", "eip155:8453"],
      });

      expect(verifier.supportedChains).toEqual(["eip155:1", "eip155:8453"]);
    });

    it("should accept custom RPC URLs", () => {
      const verifier = new EvmVerifier({
        rpcUrls: {
          "eip155:8453": "https://custom-rpc.example.com",
        },
      });

      expect(verifier.supportedChains).toContain("eip155:8453");
    });
  });

  describe("verify - proof validation", () => {
    it("should reject unsupported proof kind", async () => {
      const verifier = new EvmVerifier();

      const result = await verifier.verify(
        { kind: "cardano-txhash", txHash: "abc" } as any,
        BigInt("1000000"),
        "0x1234",
        "eip155:8453"
      );

      expect(result.verified).toBe(false);
      expect(result.error).toContain("Unsupported proof kind");
    });

    it("should reject unsupported chain", async () => {
      const verifier = new EvmVerifier({
        chains: ["eip155:8453"],
      });

      const result = await verifier.verify(
        { kind: "evm-txhash", txHash: "0x" + "a".repeat(64) },
        BigInt("1000000"),
        "0x1234",
        "eip155:1" // Not in supported chains
      );

      expect(result.verified).toBe(false);
      expect(result.error).toContain("not supported");
    });

    it("should reject invalid transaction hash format", async () => {
      const verifier = new EvmVerifier();

      const result = await verifier.verify(
        { kind: "evm-txhash", txHash: "invalid-hash" },
        BigInt("1000000"),
        "0x1234",
        "eip155:8453"
      );

      expect(result.verified).toBe(false);
      expect(result.error).toContain("Invalid transaction hash format");
    });

    it("should reject hash without 0x prefix", async () => {
      const verifier = new EvmVerifier();

      const result = await verifier.verify(
        { kind: "evm-txhash", txHash: "a".repeat(64) }, // Missing 0x
        BigInt("1000000"),
        "0x1234",
        "eip155:8453"
      );

      expect(result.verified).toBe(false);
      expect(result.error).toContain("Invalid transaction hash format");
    });
  });

  describe("verify - x402 signature proof", () => {
    it("should accept x402 signature when trustFacilitator is true", async () => {
      const verifier = new EvmVerifier({
        trustFacilitator: true,
      });

      const proof: X402SignatureProof = {
        kind: "x402-signature",
        signature: "0x1234...",
      };

      const result = await verifier.verify(
        proof,
        BigInt("1000000"),
        "0x1234567890123456789012345678901234567890",
        "eip155:8453"
      );

      expect(result.verified).toBe(true);
    });

    it("should reject x402 signature when trustFacilitator is false", async () => {
      const verifier = new EvmVerifier({
        trustFacilitator: false,
      });

      const proof: X402SignatureProof = {
        kind: "x402-signature",
        signature: "0x1234...",
      };

      const result = await verifier.verify(
        proof,
        BigInt("1000000"),
        "0x1234567890123456789012345678901234567890",
        "eip155:8453"
      );

      expect(result.verified).toBe(false);
      expect(result.error).toContain("trustFacilitator=true");
    });
  });

  describe("verify - transaction receipt", () => {
    const validTxHash = "0x" + "a".repeat(64);
    const validRecipient = "0x1234567890123456789012345678901234567890";

    it("should return not found for missing transaction", async () => {
      const verifier = new EvmVerifier({
        retryAttempts: 1,
      });

      mockClient.getTransactionReceipt.mockRejectedValue(
        new Error("Transaction not found")
      );
      mockClient.getTransaction.mockRejectedValue(
        new Error("Transaction not found")
      );

      const result = await verifier.verify(
        { kind: "evm-txhash", txHash: validTxHash },
        BigInt("1000000"),
        validRecipient,
        "eip155:8453"
      );

      expect(result.verified).toBe(false);
      expect(result.error).toContain("Transaction not found");
    });

    it("should detect pending transaction", async () => {
      const verifier = new EvmVerifier({
        retryAttempts: 1,
      });

      mockClient.getTransactionReceipt.mockRejectedValue(
        new Error("Transaction not found")
      );
      mockClient.getTransaction.mockResolvedValue({
        hash: validTxHash,
        blockNumber: null, // Pending
        to: validRecipient,
        value: BigInt("1000000"),
      });

      const result = await verifier.verify(
        { kind: "evm-txhash", txHash: validTxHash },
        BigInt("1000000"),
        validRecipient,
        "eip155:8453"
      );

      expect(result.verified).toBe(false);
      expect(result.confirmations).toBe(0);
      expect(result.error).toContain("pending");
    });

    it("should detect reverted transaction", async () => {
      const verifier = new EvmVerifier();

      mockClient.getTransactionReceipt.mockResolvedValue({
        transactionHash: validTxHash,
        blockNumber: BigInt(100),
        status: "reverted",
        logs: [],
      });

      const result = await verifier.verify(
        { kind: "evm-txhash", txHash: validTxHash },
        BigInt("1000000"),
        validRecipient,
        "eip155:8453"
      );

      expect(result.verified).toBe(false);
      expect(result.error).toContain("failed/reverted");
    });

    it("should detect insufficient confirmations", async () => {
      const verifier = new EvmVerifier({
        minConfirmations: 10,
      });

      mockClient.getTransactionReceipt.mockResolvedValue({
        transactionHash: validTxHash,
        blockNumber: BigInt(100),
        status: "success",
        logs: [],
      });
      mockClient.getBlockNumber.mockResolvedValue(BigInt(105));
      mockClient.getTransaction.mockResolvedValue({
        hash: validTxHash,
        blockNumber: BigInt(100),
        to: validRecipient,
        value: BigInt("1000000"),
      });

      const result = await verifier.verify(
        { kind: "evm-txhash", txHash: validTxHash },
        BigInt("1000000"),
        validRecipient,
        "eip155:8453"
      );

      expect(result.verified).toBe(false);
      expect(result.confirmations).toBe(6); // 105 - 100 + 1
      expect(result.error).toContain("Insufficient confirmations");
    });
  });

  describe("verify - native ETH transfer", () => {
    const validTxHash = "0x" + "a".repeat(64);
    const validRecipient = "0x1234567890123456789012345678901234567890";

    it("should verify native ETH transfer", async () => {
      const verifier = new EvmVerifier({
        minConfirmations: 1,
      });

      mockClient.getTransactionReceipt.mockResolvedValue({
        transactionHash: validTxHash,
        blockNumber: BigInt(100),
        status: "success",
        logs: [], // No ERC-20 logs
      });
      mockClient.getBlockNumber.mockResolvedValue(BigInt(105));
      mockClient.getTransaction.mockResolvedValue({
        hash: validTxHash,
        blockNumber: BigInt(100),
        to: validRecipient,
        value: BigInt("1000000000000000000"), // 1 ETH
      });

      const result = await verifier.verify(
        { kind: "evm-txhash", txHash: validTxHash },
        BigInt("1000000000000000000"),
        validRecipient,
        "eip155:8453"
      );

      expect(result.verified).toBe(true);
      expect(result.confirmations).toBe(6);
      expect(result.blockNumber).toBe(100);
    });

    it("should accept overpayment for native ETH", async () => {
      const verifier = new EvmVerifier({
        minConfirmations: 1,
      });

      mockClient.getTransactionReceipt.mockResolvedValue({
        transactionHash: validTxHash,
        blockNumber: BigInt(100),
        status: "success",
        logs: [],
      });
      mockClient.getBlockNumber.mockResolvedValue(BigInt(105));
      mockClient.getTransaction.mockResolvedValue({
        hash: validTxHash,
        blockNumber: BigInt(100),
        to: validRecipient,
        value: BigInt("2000000000000000000"), // 2 ETH
      });

      const result = await verifier.verify(
        { kind: "evm-txhash", txHash: validTxHash },
        BigInt("1000000000000000000"), // Expected 1 ETH
        validRecipient,
        "eip155:8453"
      );

      expect(result.verified).toBe(true);
    });

    it("should detect amount mismatch for native ETH", async () => {
      const verifier = new EvmVerifier({
        minConfirmations: 1,
      });

      mockClient.getTransactionReceipt.mockResolvedValue({
        transactionHash: validTxHash,
        blockNumber: BigInt(100),
        status: "success",
        logs: [],
      });
      mockClient.getBlockNumber.mockResolvedValue(BigInt(105));
      mockClient.getTransaction.mockResolvedValue({
        hash: validTxHash,
        blockNumber: BigInt(100),
        to: validRecipient,
        value: BigInt("500000000000000000"), // 0.5 ETH
      });

      const result = await verifier.verify(
        { kind: "evm-txhash", txHash: validTxHash },
        BigInt("1000000000000000000"), // Expected 1 ETH
        validRecipient,
        "eip155:8453"
      );

      expect(result.verified).toBe(false);
      expect(result.error).toContain("Amount mismatch");
    });
  });

  describe("verify - ERC-20 Transfer", () => {
    const validTxHash = "0x" + "a".repeat(64);
    const validRecipient = "0x1234567890123456789012345678901234567890";
    const tokenAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // USDC

    it("should verify ERC-20 transfer", async () => {
      const verifier = new EvmVerifier({
        minConfirmations: 1,
      });

      // Pad recipient address to 32 bytes for topics
      const paddedRecipient = "0x" + "0".repeat(24) + validRecipient.slice(2);

      mockClient.getTransactionReceipt.mockResolvedValue({
        transactionHash: validTxHash,
        blockNumber: BigInt(100),
        status: "success",
        logs: [
          {
            address: tokenAddress as `0x${string}`,
            topics: [
              ERC20_TRANSFER_TOPIC as `0x${string}`,
              "0x" + "0".repeat(64) as `0x${string}`, // from
              paddedRecipient as `0x${string}`, // to
            ],
            data: "0x" + BigInt("1000000").toString(16).padStart(64, "0") as `0x${string}`, // 1 USDC
          },
        ],
      });
      mockClient.getBlockNumber.mockResolvedValue(BigInt(105));

      const result = await verifier.verify(
        { kind: "evm-txhash", txHash: validTxHash },
        BigInt("1000000"),
        validRecipient,
        "eip155:8453"
      );

      expect(result.verified).toBe(true);
    });

    it("should verify ERC-20 transfer with specific token address", async () => {
      const verifier = new EvmVerifier({
        minConfirmations: 1,
        tokenAddress: tokenAddress,
      });

      const paddedRecipient = "0x" + "0".repeat(24) + validRecipient.slice(2);

      mockClient.getTransactionReceipt.mockResolvedValue({
        transactionHash: validTxHash,
        blockNumber: BigInt(100),
        status: "success",
        logs: [
          // Other token transfer (should be ignored)
          {
            address: "0x0000000000000000000000000000000000000001" as `0x${string}`,
            topics: [
              ERC20_TRANSFER_TOPIC as `0x${string}`,
              "0x" + "0".repeat(64) as `0x${string}`,
              paddedRecipient as `0x${string}`,
            ],
            data: "0x" + BigInt("9999999").toString(16).padStart(64, "0") as `0x${string}`,
          },
          // USDC transfer
          {
            address: tokenAddress as `0x${string}`,
            topics: [
              ERC20_TRANSFER_TOPIC as `0x${string}`,
              "0x" + "0".repeat(64) as `0x${string}`,
              paddedRecipient as `0x${string}`,
            ],
            data: "0x" + BigInt("1000000").toString(16).padStart(64, "0") as `0x${string}`,
          },
        ],
      });
      mockClient.getBlockNumber.mockResolvedValue(BigInt(105));

      const result = await verifier.verify(
        { kind: "evm-txhash", txHash: validTxHash },
        BigInt("1000000"),
        validRecipient,
        "eip155:8453"
      );

      expect(result.verified).toBe(true);
    });

    it("should detect ERC-20 amount mismatch", async () => {
      const verifier = new EvmVerifier({
        minConfirmations: 1,
      });

      const paddedRecipient = "0x" + "0".repeat(24) + validRecipient.slice(2);

      mockClient.getTransactionReceipt.mockResolvedValue({
        transactionHash: validTxHash,
        blockNumber: BigInt(100),
        status: "success",
        logs: [
          {
            address: tokenAddress as `0x${string}`,
            topics: [
              ERC20_TRANSFER_TOPIC as `0x${string}`,
              "0x" + "0".repeat(64) as `0x${string}`,
              paddedRecipient as `0x${string}`,
            ],
            data: "0x" + BigInt("500000").toString(16).padStart(64, "0") as `0x${string}`, // 0.5 USDC
          },
        ],
      });
      mockClient.getBlockNumber.mockResolvedValue(BigInt(105));
      mockClient.getTransaction.mockResolvedValue({
        hash: validTxHash,
        blockNumber: BigInt(100),
        to: tokenAddress,
        value: BigInt(0),
      });

      const result = await verifier.verify(
        { kind: "evm-txhash", txHash: validTxHash },
        BigInt("1000000"), // Expected 1 USDC
        validRecipient,
        "eip155:8453"
      );

      expect(result.verified).toBe(false);
      expect(result.error).toContain("Amount mismatch");
    });
  });

  describe("verify - EIP-3009 TransferWithAuthorization", () => {
    const validTxHash = "0x" + "a".repeat(64);
    const validRecipient = "0x1234567890123456789012345678901234567890";
    const tokenAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

    it("should verify EIP-3009 TransferWithAuthorization", async () => {
      const verifier = new EvmVerifier({
        minConfirmations: 1,
      });

      const paddedFrom = "0x" + "0".repeat(24) + "abcdef1234567890abcdef1234567890abcdef12";
      const paddedRecipient = "0x" + "0".repeat(24) + validRecipient.slice(2);

      // Data: value (32) | validAfter (32) | validBefore (32) | nonce (32)
      const value = BigInt("1000000").toString(16).padStart(64, "0");
      const validAfter = "0".repeat(64);
      const validBefore = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
      const nonce = "a".repeat(64);
      const data = "0x" + value + validAfter + validBefore + nonce;

      mockClient.getTransactionReceipt.mockResolvedValue({
        transactionHash: validTxHash,
        blockNumber: BigInt(100),
        status: "success",
        logs: [
          {
            address: tokenAddress as `0x${string}`,
            topics: [
              EIP3009_TRANSFER_TOPIC as `0x${string}`,
              paddedFrom as `0x${string}`,
              paddedRecipient as `0x${string}`,
            ],
            data: data as `0x${string}`,
          },
        ],
      });
      mockClient.getBlockNumber.mockResolvedValue(BigInt(105));

      const result = await verifier.verify(
        { kind: "evm-txhash", txHash: validTxHash },
        BigInt("1000000"),
        validRecipient,
        "eip155:8453"
      );

      expect(result.verified).toBe(true);
    });
  });

  describe("error handling", () => {
    const validTxHash = "0x" + "a".repeat(64);
    const validRecipient = "0x1234567890123456789012345678901234567890";

    it("should handle RPC errors gracefully", async () => {
      const verifier = new EvmVerifier({
        retryAttempts: 1,
      });

      mockClient.getTransactionReceipt.mockRejectedValue(new Error("RPC error"));
      mockClient.getTransaction.mockRejectedValue(new Error("RPC error"));

      const result = await verifier.verify(
        { kind: "evm-txhash", txHash: validTxHash },
        BigInt("1000000"),
        validRecipient,
        "eip155:8453"
      );

      expect(result.verified).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should handle viem client creation failure", async () => {
      const viem = await import("viem");
      (viem.createPublicClient as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("Failed to create client");
      });

      const verifier = new EvmVerifier({
        chains: ["eip155:999999"], // Unknown chain
      });

      const result = await verifier.verify(
        { kind: "evm-txhash", txHash: validTxHash },
        BigInt("1000000"),
        validRecipient,
        "eip155:999999"
      );

      expect(result.verified).toBe(false);
      expect(result.error).toContain("Failed to create client");
    });
  });

  describe("retry logic", () => {
    const validTxHash = "0x" + "a".repeat(64);
    const validRecipient = "0x1234567890123456789012345678901234567890";

    it("should retry on transient failures", async () => {
      const verifier = new EvmVerifier({
        retryAttempts: 3,
        retryBaseDelayMs: 10, // Fast retries for testing
        minConfirmations: 1,
      });

      // First two calls fail, third succeeds
      mockClient.getTransactionReceipt
        .mockRejectedValueOnce(new Error("Network error"))
        .mockRejectedValueOnce(new Error("Timeout"))
        .mockResolvedValueOnce({
          transactionHash: validTxHash,
          blockNumber: BigInt(100),
          status: "success",
          logs: [],
        });
      mockClient.getBlockNumber.mockResolvedValue(BigInt(105));
      mockClient.getTransaction.mockResolvedValue({
        hash: validTxHash,
        blockNumber: BigInt(100),
        to: validRecipient,
        value: BigInt("1000000"),
      });

      const result = await verifier.verify(
        { kind: "evm-txhash", txHash: validTxHash },
        BigInt("1000000"),
        validRecipient,
        "eip155:8453"
      );

      expect(result.verified).toBe(true);
      expect(mockClient.getTransactionReceipt).toHaveBeenCalledTimes(3);
    });
  });
});
