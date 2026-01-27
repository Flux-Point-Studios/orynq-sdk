/**
 * @summary Unit tests for CIP-30 Payer implementation.
 *
 * Tests the Cip30Payer class including supports(), getAddress(), getBalance(),
 * and pay() methods. MeshJS BrowserWallet is mocked for unit testing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Cip30Payer } from "../cip30-payer.js";
import {
  ChainNotSupportedError,
  InsufficientBalanceError,
  PaymentFailedError,
} from "@fluxpointstudios/poi-sdk-core";
import type { PaymentRequest } from "@fluxpointstudios/poi-sdk-core";

// ---------------------------------------------------------------------------
// Mock Setup
// ---------------------------------------------------------------------------

// Mock the @meshsdk/core module with Transaction class
vi.mock("@meshsdk/core", () => {
  const mockTx = {
    sendAssets: vi.fn().mockReturnThis(),
    build: vi.fn().mockResolvedValue("unsignedTxCbor"),
  };
  return {
    BrowserWallet: {
      enable: vi.fn(),
      getInstalledWallets: vi.fn().mockReturnValue([]),
    },
    Transaction: vi.fn(() => mockTx),
  };
});

// Create mock BrowserWallet instance
function createMockBrowserWallet(options: {
  networkId?: number;
  lovelace?: string;
  balance?: Array<{ unit: string; quantity: string }>;
  usedAddresses?: string[];
  changeAddress?: string;
  signTxFails?: boolean;
  submitTxFails?: boolean;
  userRejects?: boolean;
} = {}) {
  return {
    getNetworkId: vi.fn().mockResolvedValue(options.networkId ?? 1),
    getLovelace: vi.fn().mockResolvedValue(options.lovelace ?? "10000000"),
    getBalance: vi.fn().mockResolvedValue(
      options.balance ?? [{ unit: "lovelace", quantity: "10000000" }]
    ),
    getUsedAddresses: vi.fn().mockResolvedValue(
      options.usedAddresses ?? ["addr1qx..."]
    ),
    getChangeAddress: vi.fn().mockResolvedValue(
      options.changeAddress ?? "addr1qy..."
    ),
    getUtxos: vi.fn().mockResolvedValue([]),
    getCollateral: vi.fn().mockResolvedValue([]),
    sendAssets: vi.fn().mockResolvedValue("unsignedTxCbor"),
    signTx: options.userRejects
      ? vi.fn().mockRejectedValue(new Error("User declined to sign"))
      : options.signTxFails
        ? vi.fn().mockRejectedValue(new Error("Signing failed"))
        : vi.fn().mockResolvedValue("signedTxCbor"),
    submitTx: options.submitTxFails
      ? vi.fn().mockRejectedValue(new Error("Submission failed"))
      : vi.fn().mockResolvedValue("txhash123456789"),
  };
}

// Helper to create test payment requests
function createPaymentRequest(
  overrides: Partial<PaymentRequest> = {}
): PaymentRequest {
  return {
    protocol: "flux",
    chain: "cardano:mainnet",
    asset: "ADA",
    amountUnits: "5000000",
    payTo: "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constructor tests
// ---------------------------------------------------------------------------

describe("Cip30Payer constructor", () => {
  it("should create payer with default network", () => {
    const mockWallet = createMockBrowserWallet();
    const payer = new Cip30Payer({ wallet: mockWallet as any });

    expect(payer.supportedChains).toContain("cardano:mainnet");
  });

  it("should create payer with specified network", () => {
    const mockWallet = createMockBrowserWallet();
    const payer = new Cip30Payer({
      wallet: mockWallet as any,
      network: "preprod",
    });

    expect(payer.supportedChains).toContain("cardano:preprod");
    expect(payer.supportedChains).not.toContain("cardano:mainnet");
  });

  it("should mark wallet as connected when provided", () => {
    const mockWallet = createMockBrowserWallet();
    const payer = new Cip30Payer({ wallet: mockWallet as any });

    expect(payer.isConnected()).toBe(true);
  });

  it("should not be connected when only walletName provided", () => {
    const payer = new Cip30Payer({ walletName: "nami" });

    expect(payer.isConnected()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// supports() tests
// ---------------------------------------------------------------------------

describe("Cip30Payer.supports", () => {
  let payer: Cip30Payer;

  beforeEach(() => {
    const mockWallet = createMockBrowserWallet();
    payer = new Cip30Payer({ wallet: mockWallet as any, network: "mainnet" });
  });

  it("should return true for matching chain", () => {
    const request = createPaymentRequest({ chain: "cardano:mainnet" });
    expect(payer.supports(request)).toBe(true);
  });

  it("should return false for different network", () => {
    const request = createPaymentRequest({ chain: "cardano:preprod" });
    expect(payer.supports(request)).toBe(false);
  });

  it("should return false for non-Cardano chain", () => {
    const request = createPaymentRequest({ chain: "eip155:1" });
    expect(payer.supports(request)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAddress() tests
// ---------------------------------------------------------------------------

describe("Cip30Payer.getAddress", () => {
  it("should return used address when available", async () => {
    const mockWallet = createMockBrowserWallet({
      usedAddresses: ["addr1_used_address"],
    });
    const payer = new Cip30Payer({
      wallet: mockWallet as any,
      validateNetwork: false,
    });

    const address = await payer.getAddress("cardano:mainnet");
    expect(address).toBe("addr1_used_address");
  });

  it("should return change address when no used addresses", async () => {
    const mockWallet = createMockBrowserWallet({
      usedAddresses: [],
      changeAddress: "addr1_change_address",
    });
    const payer = new Cip30Payer({
      wallet: mockWallet as any,
      validateNetwork: false,
    });

    const address = await payer.getAddress("cardano:mainnet");
    expect(address).toBe("addr1_change_address");
  });

  it("should throw ChainNotSupportedError for invalid chain", async () => {
    const mockWallet = createMockBrowserWallet();
    const payer = new Cip30Payer({ wallet: mockWallet as any });

    await expect(payer.getAddress("cardano:preprod")).rejects.toThrow(
      ChainNotSupportedError
    );
  });
});

// ---------------------------------------------------------------------------
// getBalance() tests
// ---------------------------------------------------------------------------

describe("Cip30Payer.getBalance", () => {
  it("should return ADA balance", async () => {
    const mockWallet = createMockBrowserWallet({
      lovelace: "50000000", // 50 ADA
    });
    const payer = new Cip30Payer({
      wallet: mockWallet as any,
      validateNetwork: false,
    });

    const balance = await payer.getBalance("cardano:mainnet", "ADA");
    expect(balance).toBe(50000000n);
  });

  it("should handle lovelace asset identifier", async () => {
    const mockWallet = createMockBrowserWallet({
      lovelace: "25000000",
    });
    const payer = new Cip30Payer({
      wallet: mockWallet as any,
      validateNetwork: false,
    });

    const balance = await payer.getBalance("cardano:mainnet", "lovelace");
    expect(balance).toBe(25000000n);
  });

  it("should return native token balance", async () => {
    const tokenUnit = "a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235484f534b59";
    const mockWallet = createMockBrowserWallet({
      balance: [
        { unit: "lovelace", quantity: "10000000" },
        { unit: tokenUnit, quantity: "1000" },
      ],
    });
    const payer = new Cip30Payer({
      wallet: mockWallet as any,
      validateNetwork: false,
    });

    const balance = await payer.getBalance("cardano:mainnet", tokenUnit);
    expect(balance).toBe(1000n);
  });

  it("should return 0 for token not in wallet", async () => {
    const mockWallet = createMockBrowserWallet({
      balance: [{ unit: "lovelace", quantity: "10000000" }],
    });
    const payer = new Cip30Payer({
      wallet: mockWallet as any,
      validateNetwork: false,
    });

    const unknownToken = "1234567890123456789012345678901234567890123456789012345678";
    const balance = await payer.getBalance("cardano:mainnet", unknownToken);
    expect(balance).toBe(0n);
  });

  it("should throw ChainNotSupportedError for invalid chain", async () => {
    const mockWallet = createMockBrowserWallet();
    const payer = new Cip30Payer({ wallet: mockWallet as any });

    await expect(
      payer.getBalance("eip155:1", "ETH")
    ).rejects.toThrow(ChainNotSupportedError);
  });
});

// ---------------------------------------------------------------------------
// pay() tests
// ---------------------------------------------------------------------------

describe("Cip30Payer.pay", () => {
  it("should execute simple payment successfully", async () => {
    const mockWallet = createMockBrowserWallet({
      lovelace: "100000000", // 100 ADA
    });
    const payer = new Cip30Payer({
      wallet: mockWallet as any,
      validateNetwork: false,
    });

    const request = createPaymentRequest({
      amountUnits: "5000000", // 5 ADA
    });

    const proof = await payer.pay(request);

    expect(proof.kind).toBe("cardano-txhash");
    expect(proof.txHash).toBe("txhash123456789");
    // Transaction building uses MeshJS Transaction class, not wallet.sendAssets directly
    expect(mockWallet.signTx).toHaveBeenCalledWith("unsignedTxCbor");
    expect(mockWallet.submitTx).toHaveBeenCalledWith("signedTxCbor");
  });

  it("should throw InsufficientBalanceError when balance too low", async () => {
    const mockWallet = createMockBrowserWallet({
      lovelace: "1000000", // 1 ADA
    });
    const payer = new Cip30Payer({
      wallet: mockWallet as any,
      validateNetwork: false,
    });

    const request = createPaymentRequest({
      amountUnits: "10000000", // 10 ADA
    });

    await expect(payer.pay(request)).rejects.toThrow(InsufficientBalanceError);
  });

  it("should include fee buffer in balance check for ADA", async () => {
    const mockWallet = createMockBrowserWallet({
      lovelace: "5000000", // Exactly 5 ADA
    });
    const payer = new Cip30Payer({
      wallet: mockWallet as any,
      validateNetwork: false,
    });

    const request = createPaymentRequest({
      amountUnits: "5000000", // 5 ADA - needs extra for fees
    });

    // Should fail because we need fee buffer
    await expect(payer.pay(request)).rejects.toThrow(InsufficientBalanceError);
  });

  it("should handle user rejection with specific message", async () => {
    const mockWallet = createMockBrowserWallet({
      lovelace: "100000000",
      userRejects: true,
    });
    const payer = new Cip30Payer({
      wallet: mockWallet as any,
      validateNetwork: false,
    });

    const request = createPaymentRequest();

    try {
      await payer.pay(request);
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PaymentFailedError);
      expect((error as PaymentFailedError).message).toContain("cancelled");
    }
  });

  it("should wrap signing errors in PaymentFailedError", async () => {
    const mockWallet = createMockBrowserWallet({
      lovelace: "100000000",
      signTxFails: true,
    });
    const payer = new Cip30Payer({
      wallet: mockWallet as any,
      validateNetwork: false,
    });

    const request = createPaymentRequest();

    await expect(payer.pay(request)).rejects.toThrow(PaymentFailedError);
  });

  it("should wrap submission errors in PaymentFailedError", async () => {
    const mockWallet = createMockBrowserWallet({
      lovelace: "100000000",
      submitTxFails: true,
    });
    const payer = new Cip30Payer({
      wallet: mockWallet as any,
      validateNetwork: false,
    });

    const request = createPaymentRequest();

    await expect(payer.pay(request)).rejects.toThrow(PaymentFailedError);
  });

  it("should check balance for split outputs with different assets", async () => {
    const tokenUnit = "a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235484f534b59";
    const mockWallet = createMockBrowserWallet({
      lovelace: "100000000",
      balance: [
        { unit: "lovelace", quantity: "100000000" },
        { unit: tokenUnit, quantity: "50" }, // Not enough tokens
      ],
    });
    const payer = new Cip30Payer({
      wallet: mockWallet as any,
      validateNetwork: false,
    });

    const request = createPaymentRequest({
      amountUnits: "5000000",
      splits: {
        mode: "additional",
        outputs: [
          { to: "addr1...", asset: tokenUnit, amountUnits: "100" }, // Need 100, have 50
        ],
      },
    });

    await expect(payer.pay(request)).rejects.toThrow(InsufficientBalanceError);
  });
});

// ---------------------------------------------------------------------------
// Network validation tests
// ---------------------------------------------------------------------------

describe("Cip30Payer network validation", () => {
  it("should fail on network mismatch", async () => {
    const mockWallet = createMockBrowserWallet({
      networkId: 0, // Testnet
    });
    const payer = new Cip30Payer({
      wallet: mockWallet as any,
      network: "mainnet", // Expecting mainnet
      validateNetwork: true,
    });

    await expect(payer.getAddress("cardano:mainnet")).rejects.toThrow(
      "Network mismatch"
    );
  });

  it("should pass when networks match", async () => {
    const mockWallet = createMockBrowserWallet({
      networkId: 1, // Mainnet
    });
    const payer = new Cip30Payer({
      wallet: mockWallet as any,
      network: "mainnet",
      validateNetwork: true,
    });

    // Should not throw
    const address = await payer.getAddress("cardano:mainnet");
    expect(address).toBeDefined();
  });

  it("should skip validation when disabled", async () => {
    const mockWallet = createMockBrowserWallet({
      networkId: 0, // Testnet
    });
    const payer = new Cip30Payer({
      wallet: mockWallet as any,
      network: "mainnet",
      validateNetwork: false, // Disabled
    });

    // Should not throw despite mismatch
    const address = await payer.getAddress("cardano:mainnet");
    expect(address).toBeDefined();
  });

  it("should only validate network once", async () => {
    const mockWallet = createMockBrowserWallet({
      networkId: 1,
    });
    const payer = new Cip30Payer({
      wallet: mockWallet as any,
      network: "mainnet",
      validateNetwork: true,
    });

    // First call validates
    await payer.getAddress("cardano:mainnet");
    expect(mockWallet.getNetworkId).toHaveBeenCalledTimes(1);

    // Second call should skip validation
    await payer.getAddress("cardano:mainnet");
    expect(mockWallet.getNetworkId).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Helper method tests
// ---------------------------------------------------------------------------

describe("Cip30Payer helper methods", () => {
  it("should expose getNetwork()", () => {
    const mockWallet = createMockBrowserWallet();
    const payer = new Cip30Payer({
      wallet: mockWallet as any,
      network: "preprod",
    });

    expect(payer.getNetwork()).toBe("preprod");
  });

  it("should expose getUtxos()", async () => {
    const mockWallet = createMockBrowserWallet();
    const payer = new Cip30Payer({ wallet: mockWallet as any });

    const utxos = await payer.getUtxos();
    expect(Array.isArray(utxos)).toBe(true);
    expect(mockWallet.getUtxos).toHaveBeenCalled();
  });

  it("should expose getCollateral()", async () => {
    const mockWallet = createMockBrowserWallet();
    const payer = new Cip30Payer({ wallet: mockWallet as any });

    const collateral = await payer.getCollateral();
    expect(Array.isArray(collateral)).toBe(true);
  });

  it("should expose getBrowserWallet()", async () => {
    const mockWallet = createMockBrowserWallet();
    const payer = new Cip30Payer({ wallet: mockWallet as any });

    const wallet = await payer.getBrowserWallet();
    expect(wallet).toBe(mockWallet);
  });
});
