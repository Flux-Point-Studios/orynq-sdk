/**
 * @file tests/integration/setup.ts
 * @summary Shared test utilities and environment configuration for integration tests.
 *
 * This module provides:
 * - Environment variable validation
 * - Test wallet configuration
 * - Helper functions for all integration tests
 * - Constants for test networks
 */

// ---------------------------------------------------------------------------
// Environment Variables
// ---------------------------------------------------------------------------

/**
 * Environment configuration for integration tests.
 */
export interface TestEnvironment {
  /** Blockfrost API key for Cardano Preprod */
  BLOCKFROST_API_KEY?: string;
  /** Base Sepolia RPC URL */
  BASE_SEPOLIA_RPC_URL?: string;
  /** Cardano test wallet private key (hex) */
  TEST_CARDANO_PRIVATE_KEY?: string;
  /** EVM test wallet private key (hex with 0x prefix) */
  TEST_EVM_PRIVATE_KEY?: string;
}

/**
 * Load environment variables for integration tests.
 */
export function loadTestEnvironment(): TestEnvironment {
  return {
    BLOCKFROST_API_KEY: process.env.BLOCKFROST_API_KEY,
    BASE_SEPOLIA_RPC_URL: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
    TEST_CARDANO_PRIVATE_KEY: process.env.TEST_CARDANO_PRIVATE_KEY,
    TEST_EVM_PRIVATE_KEY: process.env.TEST_EVM_PRIVATE_KEY,
  };
}

/**
 * Check if Cardano integration tests can run.
 */
export function canRunCardanoTests(): boolean {
  const env = loadTestEnvironment();
  return !!(env.BLOCKFROST_API_KEY && env.TEST_CARDANO_PRIVATE_KEY);
}

/**
 * Check if EVM integration tests can run.
 */
export function canRunEvmTests(): boolean {
  const env = loadTestEnvironment();
  return !!(env.TEST_EVM_PRIVATE_KEY);
}

// ---------------------------------------------------------------------------
// Network Constants
// ---------------------------------------------------------------------------

/**
 * Cardano Preprod network configuration.
 */
export const CARDANO_PREPROD = {
  /** CAIP-2 chain identifier */
  chainId: "cardano:preprod" as const,
  /** Network magic number */
  networkMagic: 1,
  /** Blockfrost API base URL */
  blockfrostUrl: "https://cardano-preprod.blockfrost.io/api/v0",
};

/**
 * Base Sepolia network configuration.
 */
export const BASE_SEPOLIA = {
  /** CAIP-2 chain identifier */
  chainId: "eip155:84532" as const,
  /** EVM chain ID */
  evmChainId: 84532,
  /** Default RPC URL */
  rpcUrl: "https://sepolia.base.org",
  /** USDC contract address on Base Sepolia */
  usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`,
};

// ---------------------------------------------------------------------------
// Test Amounts
// ---------------------------------------------------------------------------

/**
 * Test payment amounts (small values for testnet).
 */
export const TEST_AMOUNTS = {
  /** 1 ADA in lovelace (smallest useful amount) */
  ADA_LOVELACE: "1000000",
  /** 0.5 ADA for fees buffer */
  ADA_FEE_BUFFER: "500000",
  /** 0.01 USDC (10000 units, 6 decimals) */
  USDC_UNITS: "10000",
  /** 0.001 ETH in wei */
  ETH_WEI: "1000000000000000",
};

// ---------------------------------------------------------------------------
// Test Utilities
// ---------------------------------------------------------------------------

/**
 * Wait for a specified duration.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    baseDelayMs?: number;
    shouldRetry?: (error: Error) => boolean;
  } = {}
): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 1000, shouldRetry = () => true } = options;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (!shouldRetry(lastError) || attempt === maxAttempts - 1) {
        throw lastError;
      }
      await sleep(baseDelayMs * Math.pow(2, attempt));
    }
  }

  throw lastError ?? new Error("Retry failed");
}

/**
 * Generate a random test recipient address for Cardano (uses a valid but unused address format).
 * Note: In real tests, you should use a dedicated test wallet address.
 */
export function generateTestCardanoAddress(network: "mainnet" | "preprod" = "preprod"): string {
  // These are example addresses for testing - in production tests, use actual test wallets
  if (network === "mainnet") {
    // Mainnet enterprise address format (placeholder - not a real spendable address)
    return "addr1v9ux8dwy800s5pnq327g9uzh8f2fw98ldytxqaxumh3e8kqumfr6d";
  }
  // Preprod enterprise address format (placeholder - not a real spendable address)
  return "addr_test1vp8s8zu6mr73nvlsjf935k0a38n8xvp3fptkyz2vl8pserqkcx5yz";
}

/**
 * Generate a random EVM address for testing.
 * Note: In real tests, you should use a dedicated test wallet address.
 */
export function generateTestEvmAddress(): `0x${string}` {
  // Generate a random address (not a real wallet, just for testing recipient)
  const bytes = new Uint8Array(20);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 20; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `0x${hex}` as `0x${string}`;
}

/**
 * Format lovelace to ADA for display.
 */
export function lovelaceToAda(lovelace: string | bigint): string {
  const amount = typeof lovelace === "string" ? BigInt(lovelace) : lovelace;
  const ada = Number(amount) / 1_000_000;
  return `${ada.toFixed(6)} ADA`;
}

/**
 * Format USDC units to USDC for display.
 */
export function usdcUnitsToUsdc(units: string | bigint): string {
  const amount = typeof units === "string" ? BigInt(units) : units;
  const usdc = Number(amount) / 1_000_000;
  return `${usdc.toFixed(6)} USDC`;
}

// ---------------------------------------------------------------------------
// Test Skip Helpers
// ---------------------------------------------------------------------------

/**
 * Get skip condition for Cardano tests.
 */
export function skipIfNoCardanoCredentials(): boolean {
  return !canRunCardanoTests();
}

/**
 * Get skip condition for EVM tests.
 */
export function skipIfNoEvmCredentials(): boolean {
  return !canRunEvmTests();
}

/**
 * Log test skip reason.
 */
export function logSkipReason(testName: string, reason: string): void {
  console.log(`\n  [SKIPPED] ${testName}`);
  console.log(`  Reason: ${reason}`);
  console.log("  Set the required environment variables to run this test.\n");
}

// ---------------------------------------------------------------------------
// Type Guards and Validators
// ---------------------------------------------------------------------------

/**
 * Validate Cardano transaction hash format (64 hex characters).
 */
export function isValidCardanoTxHash(hash: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(hash);
}

/**
 * Validate EVM transaction hash format (66 characters with 0x prefix).
 */
export function isValidEvmTxHash(hash: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(hash);
}

/**
 * Validate Cardano address format.
 */
export function isValidCardanoAddress(address: string): boolean {
  return address.startsWith("addr1") || address.startsWith("addr_test1");
}

/**
 * Validate EVM address format.
 */
export function isValidEvmAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/i.test(address);
}
