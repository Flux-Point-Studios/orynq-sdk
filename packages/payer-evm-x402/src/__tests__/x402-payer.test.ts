/**
 * @summary Unit tests for EvmX402Payer implementation.
 *
 * Tests cover:
 * - Constructor configuration
 * - supports() method for protocol/chain detection
 * - getAddress() returning signer address
 * - getBalance() querying native and ERC-20 balances
 * - pay() creating EIP-3009 signatures
 * - Error handling for unsupported protocols and insufficient balance
 */

import { describe, it, expect, vi, beforeEach, afterEach, Mock } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { PaymentRequest } from "@fluxpointstudios/poi-sdk-core";
import {
  InsufficientBalanceError,
  ChainNotSupportedError,
  PaymentFailedError,
} from "@fluxpointstudios/poi-sdk-core";
import { EvmX402Payer } from "../x402-payer.js";
import { ViemSigner } from "../signers/viem-signer.js";

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
  };
});

describe("EvmX402Payer", () => {
  let mockPublicClient: Record<string, Mock>;
  let signer: ViemSigner;

  beforeEach(async () => {
    // Reset mocks
    vi.clearAllMocks();

    // Create signer
    signer = new ViemSigner({ privateKey: TEST_PRIVATE_KEY });

    // Create mock public client
    mockPublicClient = {
      getBalance: vi.fn().mockResolvedValue(BigInt("1000000000000000000")), // 1 ETH
      readContract: vi.fn().mockResolvedValue(BigInt("10000000")), // 10 USDC
    };

    // Mock viem client creation
    const viem = await import("viem");
    (viem.createPublicClient as Mock).mockReturnValue(mockPublicClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Constructor Tests
  // ---------------------------------------------------------------------------

  describe("constructor", () => {
    it("should accept signer configuration", () => {
      const payer = new EvmX402Payer({ signer });
      expect(payer.supportedChains).toContain("eip155:8453");
    });

    it("should default to Base mainnet and Sepolia chains", () => {
      const payer = new EvmX402Payer({ signer });
      expect(payer.supportedChains).toContain("eip155:8453");
      expect(payer.supportedChains).toContain("eip155:84532");
    });

    it("should accept custom chains list", () => {
      const payer = new EvmX402Payer({
        signer,
        chains: ["eip155:1", "eip155:137"],
      });
      expect(payer.supportedChains).toContain("eip155:1");
      expect(payer.supportedChains).toContain("eip155:137");
    });

    it("should accept custom RPC URLs", () => {
      const payer = new EvmX402Payer({
        signer,
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
    it("should return true for x402 protocol on supported chains", () => {
      const payer = new EvmX402Payer({ signer });
      const request: PaymentRequest = {
        protocol: "x402",
        chain: "eip155:8453",
        asset: "USDC",
        amountUnits: "1000000",
        payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      };
      expect(payer.supports(request)).toBe(true);
    });

    it("should return false for non-x402 protocol", () => {
      const payer = new EvmX402Payer({ signer });
      const request: PaymentRequest = {
        protocol: "flux",
        chain: "eip155:8453",
        asset: "USDC",
        amountUnits: "1000000",
        payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      };
      expect(payer.supports(request)).toBe(false);
    });

    it("should return false for unsupported chains", () => {
      const payer = new EvmX402Payer({
        signer,
        chains: ["eip155:8453"],
      });
      const request: PaymentRequest = {
        protocol: "x402",
        chain: "eip155:1", // Not in supported list
        asset: "USDC",
        amountUnits: "1000000",
        payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      };
      expect(payer.supports(request)).toBe(false);
    });

    it("should return false for chains without config", () => {
      const payer = new EvmX402Payer({
        signer,
        chains: ["eip155:999999"], // Non-existent chain
      });
      const request: PaymentRequest = {
        protocol: "x402",
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
    it("should return signer address", async () => {
      const payer = new EvmX402Payer({ signer });
      const address = await payer.getAddress("eip155:8453");
      expect(address).toBe(TEST_ADDRESS);
    });

    it("should return same address for different chains", async () => {
      const payer = new EvmX402Payer({ signer });
      const address1 = await payer.getAddress("eip155:8453");
      const address2 = await payer.getAddress("eip155:84532");
      expect(address1).toBe(address2);
    });
  });

  // ---------------------------------------------------------------------------
  // getBalance() Tests
  // ---------------------------------------------------------------------------

  describe("getBalance", () => {
    it("should query native ETH balance", async () => {
      const payer = new EvmX402Payer({ signer });
      const balance = await payer.getBalance("eip155:8453", "ETH");
      expect(balance).toBe(BigInt("1000000000000000000"));
      expect(mockPublicClient.getBalance).toHaveBeenCalled();
    });

    it("should query native balance for 'native'", async () => {
      const payer = new EvmX402Payer({ signer });
      const balance = await payer.getBalance("eip155:8453", "native");
      expect(balance).toBe(BigInt("1000000000000000000"));
      expect(mockPublicClient.getBalance).toHaveBeenCalled();
    });

    it("should query ERC-20 balance for USDC", async () => {
      const payer = new EvmX402Payer({ signer });
      const balance = await payer.getBalance("eip155:8453", "USDC");
      expect(balance).toBe(BigInt("10000000"));
      expect(mockPublicClient.readContract).toHaveBeenCalled();
    });

    it("should throw ChainNotSupportedError for unsupported chain", async () => {
      const payer = new EvmX402Payer({ signer });
      await expect(payer.getBalance("eip155:999999", "USDC")).rejects.toThrow(
        ChainNotSupportedError
      );
    });
  });

  // ---------------------------------------------------------------------------
  // pay() Tests
  // ---------------------------------------------------------------------------

  describe("pay", () => {
    const baseRequest: PaymentRequest = {
      protocol: "x402",
      chain: "eip155:8453",
      asset: "USDC",
      amountUnits: "1000000",
      payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    };

    it("should throw for non-x402 protocol", async () => {
      const payer = new EvmX402Payer({ signer });
      const fluxRequest: PaymentRequest = {
        ...baseRequest,
        protocol: "flux",
      };

      await expect(payer.pay(fluxRequest)).rejects.toThrow(PaymentFailedError);
    });

    it("should throw ChainNotSupportedError for unsupported chain", async () => {
      const payer = new EvmX402Payer({ signer });
      const unsupportedRequest: PaymentRequest = {
        ...baseRequest,
        chain: "eip155:999999",
      };

      await expect(payer.pay(unsupportedRequest)).rejects.toThrow(
        ChainNotSupportedError
      );
    });

    it("should throw InsufficientBalanceError when balance too low", async () => {
      mockPublicClient.readContract.mockResolvedValue(BigInt("100")); // Very low balance

      const payer = new EvmX402Payer({ signer });

      await expect(payer.pay(baseRequest)).rejects.toThrow(
        InsufficientBalanceError
      );
    });

    it("should return x402-signature proof", async () => {
      const payer = new EvmX402Payer({ signer });
      const proof = await payer.pay(baseRequest);

      expect(proof.kind).toBe("x402-signature");
    });

    it("should include signature in proof", async () => {
      const payer = new EvmX402Payer({ signer });
      const proof = await payer.pay(baseRequest);

      expect(proof.kind).toBe("x402-signature");
      expect((proof as any).signature).toBeDefined();
      expect(typeof (proof as any).signature).toBe("string");
    });

    it("should include payload with request details", async () => {
      const payer = new EvmX402Payer({ signer });
      const proof = await payer.pay(baseRequest);

      expect((proof as any).payload).toBeDefined();
      const payload = JSON.parse((proof as any).payload);
      expect(payload.chain).toBe(baseRequest.chain);
      expect(payload.asset).toBe(baseRequest.asset);
      expect(payload.amount).toBe(baseRequest.amountUnits);
      expect(payload.payTo).toBe(baseRequest.payTo);
    });

    it("should create valid base64-encoded signature", async () => {
      const payer = new EvmX402Payer({ signer });
      const proof = await payer.pay(baseRequest);

      const signature = (proof as any).signature;
      // Base64 should only contain valid characters
      expect(signature).toMatch(/^[A-Za-z0-9+/=]+$/);

      // Should be decodable
      const decoded = Buffer.from(signature, "base64").toString("utf-8");
      const parsed = JSON.parse(decoded);

      expect(parsed.signature).toBeDefined();
      expect(parsed.from).toBe(TEST_ADDRESS);
      expect(parsed.to).toBe(baseRequest.payTo);
      expect(parsed.value).toBe(baseRequest.amountUnits);
    });

    it("should use request timeoutSeconds for validBefore", async () => {
      const payer = new EvmX402Payer({ signer });
      const requestWithTimeout: PaymentRequest = {
        ...baseRequest,
        timeoutSeconds: 7200, // 2 hours
      };

      const proof = await payer.pay(requestWithTimeout);

      const signature = (proof as any).signature;
      const decoded = Buffer.from(signature, "base64").toString("utf-8");
      const parsed = JSON.parse(decoded);

      const now = Math.floor(Date.now() / 1000);
      const validBefore = Number(parsed.validBefore);

      // Should be approximately 2 hours from now
      expect(validBefore).toBeGreaterThan(now + 7190);
      expect(validBefore).toBeLessThan(now + 7210);
    });

    it("should set validAfter to 0 (immediately valid)", async () => {
      const payer = new EvmX402Payer({ signer });
      const proof = await payer.pay(baseRequest);

      const signature = (proof as any).signature;
      const decoded = Buffer.from(signature, "base64").toString("utf-8");
      const parsed = JSON.parse(decoded);

      expect(parsed.validAfter).toBe("0");
    });

    it("should generate unique nonce for each payment", async () => {
      const payer = new EvmX402Payer({ signer });

      const proof1 = await payer.pay(baseRequest);
      const proof2 = await payer.pay(baseRequest);

      const decoded1 = Buffer.from(
        (proof1 as any).signature,
        "base64"
      ).toString("utf-8");
      const decoded2 = Buffer.from(
        (proof2 as any).signature,
        "base64"
      ).toString("utf-8");

      const parsed1 = JSON.parse(decoded1);
      const parsed2 = JSON.parse(decoded2);

      expect(parsed1.nonce).not.toBe(parsed2.nonce);
    });
  });
});
