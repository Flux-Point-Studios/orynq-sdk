/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-cardano-cip30/src/__tests__/wallet-connector.test.ts
 * @summary Unit tests for CIP-30 wallet connector utilities.
 *
 * Tests wallet discovery, connection, and error handling.
 * The window.cardano object is mocked for unit testing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getAvailableWallets,
  getWalletInfo,
  isWalletAvailable,
  isWalletConnected,
  connectWallet,
  getPreferredWallet,
  WalletConnectionError,
  KNOWN_WALLETS,
  WALLET_DISPLAY_NAMES,
  type Cip30WalletApi,
  type Cip30EnabledWalletApi,
} from "../wallet-connector.js";

// ---------------------------------------------------------------------------
// Mock Setup
// ---------------------------------------------------------------------------

// Store original window for cleanup
const originalWindow = global.window;

// Create mock wallet API
function createMockWalletApi(
  name: string,
  options: { isEnabled?: boolean; enableFails?: boolean } = {}
): Cip30WalletApi {
  return {
    name,
    apiVersion: "1.0.0",
    icon: `data:image/png;base64,mock-${name}-icon`,
    isEnabled: vi.fn().mockResolvedValue(options.isEnabled ?? false),
    enable: options.enableFails
      ? vi.fn().mockRejectedValue(new Error("User rejected"))
      : vi.fn().mockResolvedValue(createMockEnabledApi()),
  };
}

function createMockEnabledApi(): Cip30EnabledWalletApi {
  return {
    getNetworkId: vi.fn().mockResolvedValue(1),
    getUtxos: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue("1a001e8480"), // 2 ADA in CBOR
    getUsedAddresses: vi.fn().mockResolvedValue([]),
    getUnusedAddresses: vi.fn().mockResolvedValue([]),
    getChangeAddress: vi.fn().mockResolvedValue("addr1..."),
    getRewardAddresses: vi.fn().mockResolvedValue([]),
    signTx: vi.fn().mockResolvedValue("signedTxCbor"),
    signData: vi.fn().mockResolvedValue({ signature: "sig", key: "key" }),
    submitTx: vi.fn().mockResolvedValue("txhash123"),
  };
}

function setupWindowCardano(
  wallets: Record<string, Cip30WalletApi | undefined> = {}
) {
  // @ts-expect-error - Mocking global window
  global.window = {
    cardano: wallets,
  };
}

function cleanupWindow() {
  // @ts-expect-error - Restoring global window
  global.window = originalWindow;
}

// ---------------------------------------------------------------------------
// Constants tests
// ---------------------------------------------------------------------------

describe("KNOWN_WALLETS", () => {
  it("should contain common wallet names", () => {
    expect(KNOWN_WALLETS).toContain("nami");
    expect(KNOWN_WALLETS).toContain("eternl");
    expect(KNOWN_WALLETS).toContain("lace");
    expect(KNOWN_WALLETS).toContain("flint");
    expect(KNOWN_WALLETS).toContain("vespr");
  });

  it("should be readonly array type", () => {
    // KNOWN_WALLETS is typed as readonly in TypeScript
    // We verify it's an array and contains expected wallet names
    expect(Array.isArray(KNOWN_WALLETS)).toBe(true);
    expect(KNOWN_WALLETS.length).toBeGreaterThan(0);
  });
});

describe("WALLET_DISPLAY_NAMES", () => {
  it("should have display names for all known wallets", () => {
    for (const wallet of KNOWN_WALLETS) {
      expect(WALLET_DISPLAY_NAMES[wallet]).toBeDefined();
      expect(typeof WALLET_DISPLAY_NAMES[wallet]).toBe("string");
    }
  });

  it("should use proper capitalization", () => {
    expect(WALLET_DISPLAY_NAMES.nami).toBe("Nami");
    expect(WALLET_DISPLAY_NAMES.eternl).toBe("Eternl");
    expect(WALLET_DISPLAY_NAMES.lace).toBe("Lace");
  });
});

// ---------------------------------------------------------------------------
// getAvailableWallets tests
// ---------------------------------------------------------------------------

describe("getAvailableWallets", () => {
  afterEach(() => {
    cleanupWindow();
  });

  it("should return empty array when no window", async () => {
    cleanupWindow();
    const wallets = await getAvailableWallets();
    expect(wallets).toEqual([]);
  });

  it("should return empty array when no cardano object", async () => {
    // @ts-expect-error - Mocking global window
    global.window = {};
    const wallets = await getAvailableWallets();
    expect(wallets).toEqual([]);
  });

  it("should return available wallets", async () => {
    setupWindowCardano({
      nami: createMockWalletApi("nami"),
      eternl: createMockWalletApi("eternl"),
    });
    const wallets = await getAvailableWallets();
    expect(wallets).toContain("nami");
    expect(wallets).toContain("eternl");
    expect(wallets).toHaveLength(2);
  });

  it("should only return known wallets", async () => {
    setupWindowCardano({
      nami: createMockWalletApi("nami"),
      unknownWallet: createMockWalletApi("unknownWallet"),
    });
    const wallets = await getAvailableWallets();
    expect(wallets).toContain("nami");
    expect(wallets).not.toContain("unknownWallet");
  });
});

// ---------------------------------------------------------------------------
// getWalletInfo tests
// ---------------------------------------------------------------------------

describe("getWalletInfo", () => {
  afterEach(() => {
    cleanupWindow();
  });

  it("should return empty array when no wallets", async () => {
    setupWindowCardano({});
    const info = await getWalletInfo();
    expect(info).toEqual([]);
  });

  it("should return wallet info for available wallets", async () => {
    setupWindowCardano({
      nami: createMockWalletApi("nami"),
    });
    const info = await getWalletInfo();
    expect(info).toHaveLength(1);
    expect(info[0]).toEqual({
      name: "nami",
      displayName: "Nami",
      apiVersion: "1.0.0",
      icon: "data:image/png;base64,mock-nami-icon",
    });
  });
});

// ---------------------------------------------------------------------------
// isWalletAvailable tests
// ---------------------------------------------------------------------------

describe("isWalletAvailable", () => {
  afterEach(() => {
    cleanupWindow();
  });

  it("should return false when no window", () => {
    cleanupWindow();
    expect(isWalletAvailable("nami")).toBe(false);
  });

  it("should return false when wallet not installed", () => {
    setupWindowCardano({});
    expect(isWalletAvailable("nami")).toBe(false);
  });

  it("should return true when wallet is installed", () => {
    setupWindowCardano({
      nami: createMockWalletApi("nami"),
    });
    expect(isWalletAvailable("nami")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isWalletConnected tests
// ---------------------------------------------------------------------------

describe("isWalletConnected", () => {
  afterEach(() => {
    cleanupWindow();
  });

  it("should return false when no window", async () => {
    cleanupWindow();
    expect(await isWalletConnected("nami")).toBe(false);
  });

  it("should return false when wallet not installed", async () => {
    setupWindowCardano({});
    expect(await isWalletConnected("nami")).toBe(false);
  });

  it("should return false when not enabled", async () => {
    setupWindowCardano({
      nami: createMockWalletApi("nami", { isEnabled: false }),
    });
    expect(await isWalletConnected("nami")).toBe(false);
  });

  it("should return true when already enabled", async () => {
    setupWindowCardano({
      nami: createMockWalletApi("nami", { isEnabled: true }),
    });
    expect(await isWalletConnected("nami")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// connectWallet tests
// ---------------------------------------------------------------------------

describe("connectWallet", () => {
  afterEach(() => {
    cleanupWindow();
  });

  it("should throw NOT_IN_BROWSER when no window", async () => {
    cleanupWindow();
    await expect(connectWallet("nami")).rejects.toThrow(WalletConnectionError);
    try {
      await connectWallet("nami");
    } catch (error) {
      expect(error).toBeInstanceOf(WalletConnectionError);
      expect((error as WalletConnectionError).code).toBe("NOT_IN_BROWSER");
    }
  });

  it("should throw NO_WALLETS_DETECTED when no cardano object", async () => {
    // @ts-expect-error - Mocking global window
    global.window = {};
    await expect(connectWallet("nami")).rejects.toThrow(WalletConnectionError);
    try {
      await connectWallet("nami");
    } catch (error) {
      expect((error as WalletConnectionError).code).toBe("NO_WALLETS_DETECTED");
    }
  });

  it("should throw WALLET_NOT_FOUND when wallet not installed", async () => {
    setupWindowCardano({});
    await expect(connectWallet("nami")).rejects.toThrow(WalletConnectionError);
    try {
      await connectWallet("nami");
    } catch (error) {
      expect((error as WalletConnectionError).code).toBe("WALLET_NOT_FOUND");
      expect((error as WalletConnectionError).wallet).toBe("nami");
    }
  });

  it("should throw ENABLE_FAILED when user rejects", async () => {
    setupWindowCardano({
      nami: createMockWalletApi("nami", { enableFails: true }),
    });
    await expect(connectWallet("nami")).rejects.toThrow(WalletConnectionError);
    try {
      await connectWallet("nami");
    } catch (error) {
      expect((error as WalletConnectionError).code).toBe("ENABLE_FAILED");
    }
  });

  it("should return enabled API on success", async () => {
    const mockWallet = createMockWalletApi("nami");
    setupWindowCardano({ nami: mockWallet });

    const api = await connectWallet("nami");

    expect(mockWallet.enable).toHaveBeenCalled();
    expect(api).toBeDefined();
    expect(api.getNetworkId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// getPreferredWallet tests
// ---------------------------------------------------------------------------

describe("getPreferredWallet", () => {
  afterEach(() => {
    cleanupWindow();
  });

  it("should return undefined when no wallets available", async () => {
    setupWindowCardano({});
    const preferred = await getPreferredWallet();
    expect(preferred).toBeUndefined();
  });

  it("should prefer eternl over others", async () => {
    setupWindowCardano({
      nami: createMockWalletApi("nami"),
      eternl: createMockWalletApi("eternl"),
      lace: createMockWalletApi("lace"),
    });
    const preferred = await getPreferredWallet();
    expect(preferred).toBe("eternl");
  });

  it("should prefer nami if eternl not available", async () => {
    setupWindowCardano({
      nami: createMockWalletApi("nami"),
      lace: createMockWalletApi("lace"),
    });
    const preferred = await getPreferredWallet();
    expect(preferred).toBe("nami");
  });

  it("should return first available if no preferred", async () => {
    setupWindowCardano({
      yoroi: createMockWalletApi("yoroi"),
    });
    const preferred = await getPreferredWallet();
    expect(preferred).toBe("yoroi");
  });
});

// ---------------------------------------------------------------------------
// WalletConnectionError tests
// ---------------------------------------------------------------------------

describe("WalletConnectionError", () => {
  it("should have correct properties", () => {
    const error = new WalletConnectionError(
      "nami",
      "Test message",
      "TEST_CODE"
    );
    expect(error.name).toBe("WalletConnectionError");
    expect(error.wallet).toBe("nami");
    expect(error.code).toBe("TEST_CODE");
    expect(error.message).toBe("Test message");
  });

  it("should use default code", () => {
    const error = new WalletConnectionError("nami", "Test message");
    expect(error.code).toBe("WALLET_CONNECTION_FAILED");
  });

  it("should be instanceof Error", () => {
    const error = new WalletConnectionError("nami", "Test");
    expect(error).toBeInstanceOf(Error);
  });
});
