/**
 * @summary Unit tests for ViemPayer implementation.
 *
 * Tests cover:
 * - Constructor validation and configuration
 * - supports() method for chain/asset detection
 * - getAddress() returning correct checksummed addresses
 * - getBalance() querying native and ERC-20 balances
 * - pay() executing transfers and returning proofs
 * - Error handling for insufficient balance and RPC failures
 *
 * Uses mocked viem clients to avoid network dependencies.
 */

import { describe, it, expect, vi, beforeEach, afterEach, Mock } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { PaymentRequest } from "@fluxpointstudios/orynq-sdk-core";
import { InsufficientBalanceError } from "@fluxpointstudios/orynq-sdk-core";
import { ViemPayer } from "../viem-payer.js";

// Test private key (DO NOT USE IN PRODUCTION - this is a well-known test key)
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// Mock viem modules
vi.mock("viem", async () => {
  const actual = await vi.importActual("viem");
  return {
    ...actual,
    createPublicClient: vi.fn(),
    createWalletClient: vi.fn(),
  };
});

describe("ViemPayer", () => {
  let mockPublicClient: Record<string, Mock>;
  let mockWalletClient: Record<string, Mock>;

  beforeEach(async () => {
    // Reset mocks
    vi.clearAllMocks();

    // Create mock public client
    mockPublicClient = {
      getBalance: vi.fn().mockResolvedValue(BigInt("1000000000000000000")), // 1 ETH
      readContract: vi.fn().mockResolvedValue(BigInt("10000000")), // 10 USDC
      simulateContract: vi.fn().mockResolvedValue({
        request: {
          address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          abi: [],
          functionName: "transfer",
          args: ["0x70997970C51812dc3A010C7d01b50e0d17dc79C8", BigInt("1000000")],
        },
      }),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: "success",
        transactionHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      }),
      estimateGas: vi.fn().mockResolvedValue(BigInt(65000)),
    };

    // Create mock wallet client
    mockWalletClient = {
      account: privateKeyToAccount(TEST_PRIVATE_KEY),
      writeContract: vi.fn().mockResolvedValue(
        "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
      ),
      sendTransaction: vi.fn().mockResolvedValue(
        "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
      ),
    };

    // Mock viem client creation
    const viem = await import("viem");
    (viem.createPublicClient as Mock).mockReturnValue(mockPublicClient);
    (viem.createWalletClient as Mock).mockReturnValue(mockWalletClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Constructor Tests
  // ---------------------------------------------------------------------------

  describe("constructor", () => {
    it("should throw if neither privateKey nor account provided", () => {
      expect(() => new ViemPayer({} as any)).toThrow(
        "ViemPayer requires either privateKey or account"
      );
    });

    it("should accept privateKey and derive account", () => {
      const payer = new ViemPayer({ privateKey: TEST_PRIVATE_KEY });
      expect(payer.supportedChains).toContain("eip155:8453");
    });

    it("should accept pre-configured account", () => {
      const account = privateKeyToAccount(TEST_PRIVATE_KEY);
      const payer = new ViemPayer({ account });
      expect(payer.supportedChains).toContain("eip155:8453");
    });

    it("should default to Base mainnet and Sepolia chains", () => {
      const payer = new ViemPayer({ privateKey: TEST_PRIVATE_KEY });
      expect(payer.supportedChains).toContain("eip155:8453");
      expect(payer.supportedChains).toContain("eip155:84532");
    });

    it("should accept custom chains list", () => {
      const payer = new ViemPayer({
        privateKey: TEST_PRIVATE_KEY,
        chains: ["eip155:1", "eip155:137"],
      });
      expect(payer.supportedChains).toContain("eip155:1");
      expect(payer.supportedChains).toContain("eip155:137");
      expect(payer.supportedChains).not.toContain("eip155:8453");
    });

    it("should accept custom RPC URLs", () => {
      const payer = new ViemPayer({
        privateKey: TEST_PRIVATE_KEY,
        rpcUrls: {
          "eip155:8453": "https://custom-rpc.example.com",
        },
      });
      expect(payer).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // supports() Tests
  // ---------------------------------------------------------------------------

  describe("supports", () => {
    it("should return true for supported chains", () => {
      const payer = new ViemPayer({ privateKey: TEST_PRIVATE_KEY });
      const request: PaymentRequest = {
        protocol: "flux",
        chain: "eip155:8453",
        asset: "USDC",
        amountUnits: "1000000",
        payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      };
      expect(payer.supports(request)).toBe(true);
    });

    it("should return false for unsupported chains", () => {
      const payer = new ViemPayer({
        privateKey: TEST_PRIVATE_KEY,
        chains: ["eip155:8453"],
      });
      const request: PaymentRequest = {
        protocol: "flux",
        chain: "eip155:1", // Ethereum mainnet not in supported list
        asset: "USDC",
        amountUnits: "1000000",
        payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      };
      expect(payer.supports(request)).toBe(false);
    });

    it("should return false for chains not in CHAIN_CONFIGS", () => {
      const payer = new ViemPayer({
        privateKey: TEST_PRIVATE_KEY,
        chains: ["eip155:999999"], // Non-existent chain
      });
      const request: PaymentRequest = {
        protocol: "flux",
        chain: "eip155:999999",
        asset: "USDC",
        amountUnits: "1000000",
        payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      };
      expect(payer.supports(request)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // getAddress() Tests
  // ---------------------------------------------------------------------------

  describe("getAddress", () => {
    it("should return the same address for all chains", async () => {
      const payer = new ViemPayer({ privateKey: TEST_PRIVATE_KEY });
      const address1 = await payer.getAddress("eip155:8453");
      const address2 = await payer.getAddress("eip155:84532");
      expect(address1).toBe(address2);
    });

    it("should return checksummed address", async () => {
      const payer = new ViemPayer({ privateKey: TEST_PRIVATE_KEY });
      const address = await payer.getAddress("eip155:8453");
      expect(address).toBe(TEST_ADDRESS);
      // Checksummed addresses have mixed case
      expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });
  });

  // ---------------------------------------------------------------------------
  // getBalance() Tests
  // ---------------------------------------------------------------------------

  describe("getBalance", () => {
    it("should query native ETH balance for 'ETH'", async () => {
      const payer = new ViemPayer({ privateKey: TEST_PRIVATE_KEY });
      const balance = await payer.getBalance("eip155:8453", "ETH");
      expect(balance).toBe(BigInt("1000000000000000000"));
      expect(mockPublicClient.getBalance).toHaveBeenCalled();
    });

    it("should query native ETH balance for 'native'", async () => {
      const payer = new ViemPayer({ privateKey: TEST_PRIVATE_KEY });
      const balance = await payer.getBalance("eip155:8453", "native");
      expect(balance).toBe(BigInt("1000000000000000000"));
      expect(mockPublicClient.getBalance).toHaveBeenCalled();
    });

    it("should query ERC-20 balance for 'USDC'", async () => {
      const payer = new ViemPayer({ privateKey: TEST_PRIVATE_KEY });
      const balance = await payer.getBalance("eip155:8453", "USDC");
      expect(balance).toBe(BigInt("10000000"));
      expect(mockPublicClient.readContract).toHaveBeenCalled();
    });

    it("should query ERC-20 balance for custom contract address", async () => {
      const payer = new ViemPayer({ privateKey: TEST_PRIVATE_KEY });
      const customToken = "0x1234567890123456789012345678901234567890";
      const balance = await payer.getBalance("eip155:8453", customToken);
      expect(balance).toBe(BigInt("10000000"));
      expect(mockPublicClient.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: customToken,
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // pay() Tests
  // ---------------------------------------------------------------------------

  describe("pay", () => {
    const baseRequest: PaymentRequest = {
      protocol: "flux",
      chain: "eip155:8453",
      asset: "USDC",
      amountUnits: "1000000",
      payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    };

    it("should throw InsufficientBalanceError if balance too low", async () => {
      mockPublicClient.readContract.mockResolvedValue(BigInt("100")); // Very low balance

      const payer = new ViemPayer({ privateKey: TEST_PRIVATE_KEY });

      await expect(payer.pay(baseRequest)).rejects.toThrow(
        InsufficientBalanceError
      );
    });

    it("should execute ERC-20 transfer for USDC", async () => {
      const payer = new ViemPayer({ privateKey: TEST_PRIVATE_KEY });
      const proof = await payer.pay(baseRequest);

      expect(proof.kind).toBe("evm-txhash");
      expect((proof as any).txHash).toBeDefined();
      expect(mockWalletClient.writeContract).toHaveBeenCalled();
    });

    it("should execute native ETH transfer for ETH asset", async () => {
      const ethRequest: PaymentRequest = {
        ...baseRequest,
        asset: "ETH",
        amountUnits: "100000000000000000", // 0.1 ETH
      };

      const payer = new ViemPayer({ privateKey: TEST_PRIVATE_KEY });
      const proof = await payer.pay(ethRequest);

      expect(proof.kind).toBe("evm-txhash");
      expect(mockWalletClient.sendTransaction).toHaveBeenCalled();
    });

    it("should return evm-txhash proof type", async () => {
      const payer = new ViemPayer({ privateKey: TEST_PRIVATE_KEY });
      const proof = await payer.pay(baseRequest);

      expect(proof.kind).toBe("evm-txhash");
      expect((proof as any).txHash).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it("should calculate total amount including additional splits", async () => {
      const requestWithSplits: PaymentRequest = {
        ...baseRequest,
        splits: {
          mode: "additional",
          outputs: [
            {
              to: "0x1234567890123456789012345678901234567890",
              amountUnits: "500000",
            },
          ],
        },
      };

      // Set balance to just enough for main amount but not splits
      mockPublicClient.readContract.mockResolvedValue(BigInt("1200000"));

      const payer = new ViemPayer({ privateKey: TEST_PRIVATE_KEY });

      await expect(payer.pay(requestWithSplits)).rejects.toThrow(
        InsufficientBalanceError
      );
    });

    it("should wait for transaction confirmation", async () => {
      const payer = new ViemPayer({ privateKey: TEST_PRIVATE_KEY });
      await payer.pay(baseRequest);

      expect(mockPublicClient.waitForTransactionReceipt).toHaveBeenCalled();
    });
  });
});
