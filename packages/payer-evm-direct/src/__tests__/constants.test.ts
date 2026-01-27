/**
 * @summary Unit tests for constants and ERC-20 ABI definitions.
 *
 * Tests cover:
 * - USDC contract addresses for all supported chains
 * - ERC20_ABI structure and function definitions
 * - Type guard functions for USDC support
 */

import { describe, it, expect } from "vitest";
import {
  USDC_ADDRESSES,
  ERC20_ABI,
  hasUsdcSupport,
  getUsdcAddress,
  type SupportedUsdcChain,
} from "../constants.js";

// ---------------------------------------------------------------------------
// USDC_ADDRESSES Tests
// ---------------------------------------------------------------------------

describe("USDC_ADDRESSES", () => {
  it("should be a record with string keys and hex addresses", () => {
    expect(typeof USDC_ADDRESSES).toBe("object");
    for (const [key, value] of Object.entries(USDC_ADDRESSES)) {
      expect(typeof key).toBe("string");
      expect(value).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("should have Ethereum Mainnet USDC (official Circle address)", () => {
    // Official Circle USDC on Ethereum
    expect(USDC_ADDRESSES["eip155:1"]).toBe(
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
    );
  });

  it("should have Base Mainnet USDC (official Circle address)", () => {
    // Official Circle USDC on Base
    expect(USDC_ADDRESSES["eip155:8453"]).toBe(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    );
  });

  it("should have Base Sepolia USDC (testnet)", () => {
    expect(USDC_ADDRESSES["eip155:84532"]).toBe(
      "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
    );
  });

  it("should have Polygon Mainnet USDC (official Circle native)", () => {
    // Official Circle native USDC on Polygon (not bridged)
    expect(USDC_ADDRESSES["eip155:137"]).toBe(
      "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"
    );
  });

  it("should have Arbitrum One USDC (official Circle native)", () => {
    // Official Circle native USDC on Arbitrum
    expect(USDC_ADDRESSES["eip155:42161"]).toBe(
      "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
    );
  });
});

// ---------------------------------------------------------------------------
// ERC20_ABI Tests
// ---------------------------------------------------------------------------

describe("ERC20_ABI", () => {
  it("should be an array", () => {
    expect(Array.isArray(ERC20_ABI)).toBe(true);
  });

  it("should contain transfer function", () => {
    const transferFn = ERC20_ABI.find((item) => item.name === "transfer");
    expect(transferFn).toBeDefined();
    expect(transferFn?.type).toBe("function");
    expect(transferFn?.inputs).toHaveLength(2);
    expect(transferFn?.inputs[0].type).toBe("address");
    expect(transferFn?.inputs[1].type).toBe("uint256");
  });

  it("should contain balanceOf function", () => {
    const balanceOfFn = ERC20_ABI.find((item) => item.name === "balanceOf");
    expect(balanceOfFn).toBeDefined();
    expect(balanceOfFn?.type).toBe("function");
    expect(balanceOfFn?.inputs).toHaveLength(1);
    expect(balanceOfFn?.inputs[0].type).toBe("address");
    expect(balanceOfFn?.outputs?.[0].type).toBe("uint256");
  });

  it("should contain decimals function", () => {
    const decimalsFn = ERC20_ABI.find((item) => item.name === "decimals");
    expect(decimalsFn).toBeDefined();
    expect(decimalsFn?.type).toBe("function");
    expect(decimalsFn?.outputs?.[0].type).toBe("uint8");
  });

  it("should have correct constant flags", () => {
    const transferFn = ERC20_ABI.find((item) => item.name === "transfer");
    const balanceOfFn = ERC20_ABI.find((item) => item.name === "balanceOf");
    const decimalsFn = ERC20_ABI.find((item) => item.name === "decimals");

    // transfer is not constant (modifies state)
    expect(transferFn?.constant).toBe(false);
    // balanceOf is constant (view function)
    expect(balanceOfFn?.constant).toBe(true);
    // decimals is constant (view function)
    expect(decimalsFn?.constant).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasUsdcSupport Tests
// ---------------------------------------------------------------------------

describe("hasUsdcSupport", () => {
  it("should return true for chains with USDC", () => {
    expect(hasUsdcSupport("eip155:1")).toBe(true);
    expect(hasUsdcSupport("eip155:8453")).toBe(true);
    expect(hasUsdcSupport("eip155:84532")).toBe(true);
    expect(hasUsdcSupport("eip155:137")).toBe(true);
    expect(hasUsdcSupport("eip155:42161")).toBe(true);
  });

  it("should return false for chains without USDC", () => {
    expect(hasUsdcSupport("eip155:999")).toBe(false);
    expect(hasUsdcSupport("cardano:mainnet")).toBe(false);
    expect(hasUsdcSupport("solana:mainnet")).toBe(false);
  });

  it("should work as type guard", () => {
    const chainId = "eip155:8453";
    if (hasUsdcSupport(chainId)) {
      // TypeScript should know chainId is SupportedUsdcChain here
      const address = USDC_ADDRESSES[chainId];
      expect(address).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// getUsdcAddress Tests
// ---------------------------------------------------------------------------

describe("getUsdcAddress", () => {
  it("should return address for supported chains", () => {
    expect(getUsdcAddress("eip155:8453")).toBe(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    );
    expect(getUsdcAddress("eip155:1")).toBe(
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
    );
  });

  it("should return undefined for unsupported chains", () => {
    expect(getUsdcAddress("eip155:999")).toBeUndefined();
    expect(getUsdcAddress("cardano:mainnet")).toBeUndefined();
  });

  it("should return checksummed addresses", () => {
    const address = getUsdcAddress("eip155:8453");
    expect(address).toBeDefined();
    // Checksummed addresses have mixed case
    expect(address).not.toBe(address?.toLowerCase());
  });
});
