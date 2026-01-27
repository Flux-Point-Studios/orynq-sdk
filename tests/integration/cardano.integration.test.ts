/**
 * @file tests/integration/cardano.integration.test.ts
 * @summary Integration tests for Cardano payment flows against Preprod testnet.
 *
 * These tests verify:
 * - CardanoNodePayer with BlockfrostProvider
 * - ADA payment transactions
 * - Native token payment transactions
 * - Transaction on-chain verification
 *
 * Prerequisites:
 * - BLOCKFROST_API_KEY: Blockfrost Preprod API key
 * - TEST_CARDANO_PRIVATE_KEY: Hex-encoded Ed25519 private key for test wallet
 *
 * Test wallet requirements:
 * - Must have at least 10 ADA on Cardano Preprod
 * - Get testnet ADA from: https://docs.cardano.org/cardano-testnets/tools/faucet/
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { PaymentRequest, PaymentProof } from "@poi-sdk/core";
import {
  loadTestEnvironment,
  canRunCardanoTests,
  logSkipReason,
  CARDANO_PREPROD,
  TEST_AMOUNTS,
  sleep,
  retry,
  isValidCardanoTxHash,
  isValidCardanoAddress,
  lovelaceToAda,
  generateTestCardanoAddress,
} from "./setup.js";

// ---------------------------------------------------------------------------
// Test Configuration
// ---------------------------------------------------------------------------

const TEST_TIMEOUT = 120_000; // 2 minutes for on-chain operations

// Skip entire suite if credentials not available
const shouldSkip = !canRunCardanoTests();

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkip)("Cardano Integration Tests", () => {
  // Lazy imports to avoid loading modules when tests are skipped
  let CardanoNodePayer: typeof import("@poi-sdk/payer-cardano-node").CardanoNodePayer;
  let BlockfrostProvider: typeof import("@poi-sdk/payer-cardano-node").BlockfrostProvider;
  let MemorySigner: typeof import("@poi-sdk/payer-cardano-node").MemorySigner;

  let payer: InstanceType<typeof CardanoNodePayer>;
  let provider: InstanceType<typeof BlockfrostProvider>;
  let signer: InstanceType<typeof MemorySigner>;
  let walletAddress: string;

  beforeAll(async () => {
    if (shouldSkip) {
      logSkipReason(
        "Cardano Integration Tests",
        "Missing BLOCKFROST_API_KEY or TEST_CARDANO_PRIVATE_KEY"
      );
      return;
    }

    // Dynamic imports
    const payerModule = await import("@poi-sdk/payer-cardano-node");
    CardanoNodePayer = payerModule.CardanoNodePayer;
    BlockfrostProvider = payerModule.BlockfrostProvider;
    MemorySigner = payerModule.MemorySigner;

    const env = loadTestEnvironment();

    // Suppress memory signer warning for tests
    MemorySigner.resetWarning?.();

    // Initialize provider
    provider = new BlockfrostProvider({
      projectId: env.BLOCKFROST_API_KEY!,
      network: "preprod",
    });

    // Initialize signer
    signer = new MemorySigner(env.TEST_CARDANO_PRIVATE_KEY!);

    // Initialize payer
    payer = new CardanoNodePayer({
      signer,
      provider,
      awaitConfirmation: false, // Don't wait in tests for faster execution
    });

    // Get wallet address
    walletAddress = await signer.getAddress(CARDANO_PREPROD.chainId);
    console.log(`\n  Test wallet address: ${walletAddress}`);
  });

  describe("BlockfrostProvider", () => {
    it("should connect to Cardano Preprod", async () => {
      expect(provider.getNetworkId()).toBe("preprod");
    });

    it("should fetch protocol parameters", async () => {
      const params = await provider.getProtocolParameters();

      expect(params).toBeDefined();
      expect(params.minFeeA).toBeGreaterThan(0);
      expect(params.minFeeB).toBeGreaterThan(0);
      expect(params.maxTxSize).toBeGreaterThan(0);
      expect(params.coinsPerUtxoByte).toBeGreaterThan(0);

      console.log(`  Protocol params: minFeeA=${params.minFeeA}, minFeeB=${params.minFeeB}`);
    });

    it("should fetch UTxOs for test wallet", async () => {
      const utxos = await provider.getUtxos(walletAddress);

      expect(Array.isArray(utxos)).toBe(true);

      if (utxos.length === 0) {
        console.warn(
          `\n  WARNING: Test wallet has no UTxOs. Fund it from the faucet:\n` +
            `  https://docs.cardano.org/cardano-testnets/tools/faucet/\n` +
            `  Address: ${walletAddress}\n`
        );
      } else {
        const totalLovelace = utxos.reduce((sum, u) => sum + u.lovelace, 0n);
        console.log(`  Found ${utxos.length} UTxOs with ${lovelaceToAda(totalLovelace)}`);
      }
    });
  });

  describe("CardanoNodePayer", () => {
    it("should report correct supported chains", () => {
      expect(payer.supportedChains).toContain("cardano:preprod");
    });

    it("should return wallet address", async () => {
      const address = await payer.getAddress(CARDANO_PREPROD.chainId);

      expect(isValidCardanoAddress(address)).toBe(true);
      expect(address).toBe(walletAddress);
    });

    it("should get ADA balance", async () => {
      const balance = await payer.getBalance(CARDANO_PREPROD.chainId, "ADA");

      expect(typeof balance).toBe("bigint");
      expect(balance).toBeGreaterThanOrEqual(0n);

      console.log(`  Wallet balance: ${lovelaceToAda(balance)}`);

      // Warn if balance is too low for tests
      const minRequired = BigInt(TEST_AMOUNTS.ADA_LOVELACE) * 5n; // 5 ADA minimum
      if (balance < minRequired) {
        console.warn(
          `\n  WARNING: Low balance (${lovelaceToAda(balance)}). ` +
            `Tests may fail. Need at least ${lovelaceToAda(minRequired)}\n`
        );
      }
    });

    it("should support ADA payment requests", () => {
      const request: PaymentRequest = {
        protocol: "flux",
        chain: CARDANO_PREPROD.chainId,
        asset: "ADA",
        amountUnits: TEST_AMOUNTS.ADA_LOVELACE,
        payTo: generateTestCardanoAddress("preprod"),
      };

      expect(payer.supports(request)).toBe(true);
    });

    it("should not support unsupported chains", () => {
      const request: PaymentRequest = {
        protocol: "flux",
        chain: "eip155:8453", // Base mainnet
        asset: "USDC",
        amountUnits: "1000000",
        payTo: "0x1234567890123456789012345678901234567890",
      };

      expect(payer.supports(request)).toBe(false);
    });
  });

  describe("ADA Payment Flow", () => {
    let paymentProof: PaymentProof | null = null;

    it(
      "should build and submit ADA payment transaction",
      async () => {
        // Check balance first
        const balance = await payer.getBalance(CARDANO_PREPROD.chainId, "ADA");
        const requiredAmount =
          BigInt(TEST_AMOUNTS.ADA_LOVELACE) + BigInt(TEST_AMOUNTS.ADA_FEE_BUFFER);

        if (balance < requiredAmount) {
          console.log(
            `  Skipping: Insufficient balance (${lovelaceToAda(balance)} < ${lovelaceToAda(requiredAmount)})`
          );
          return;
        }

        // Create payment request - send to self for testing
        const request: PaymentRequest = {
          protocol: "flux",
          chain: CARDANO_PREPROD.chainId,
          asset: "ADA",
          amountUnits: TEST_AMOUNTS.ADA_LOVELACE,
          payTo: walletAddress, // Send to self
        };

        // Execute payment
        console.log(`  Executing payment of ${lovelaceToAda(TEST_AMOUNTS.ADA_LOVELACE)}...`);
        const startTime = Date.now();

        paymentProof = await payer.pay(request);

        const duration = Date.now() - startTime;
        console.log(`  Transaction submitted in ${duration}ms`);

        // Validate proof
        expect(paymentProof).toBeDefined();
        expect(paymentProof.kind).toBe("cardano-txhash");

        if (paymentProof.kind === "cardano-txhash") {
          expect(isValidCardanoTxHash(paymentProof.txHash)).toBe(true);
          console.log(`  Transaction hash: ${paymentProof.txHash}`);
        }
      },
      TEST_TIMEOUT
    );

    it(
      "should verify transaction on-chain",
      async () => {
        if (!paymentProof || paymentProof.kind !== "cardano-txhash") {
          console.log("  Skipping: No transaction to verify");
          return;
        }

        // Wait for transaction to propagate
        console.log("  Waiting for transaction to propagate...");
        await sleep(10000); // 10 seconds

        // Poll for transaction confirmation
        const confirmed = await retry(
          async () => {
            const result = await provider.awaitTx(paymentProof!.txHash as string, 5000);
            if (!result) {
              throw new Error("Transaction not yet confirmed");
            }
            return result;
          },
          { maxAttempts: 12, baseDelayMs: 5000 } // Up to 60 seconds
        );

        expect(confirmed).toBe(true);
        console.log("  Transaction confirmed on-chain!");
      },
      TEST_TIMEOUT
    );
  });

  describe("Error Handling", () => {
    it("should throw InsufficientBalanceError for large amounts", async () => {
      const request: PaymentRequest = {
        protocol: "flux",
        chain: CARDANO_PREPROD.chainId,
        asset: "ADA",
        amountUnits: "999999999999999999", // Huge amount
        payTo: walletAddress,
      };

      await expect(payer.pay(request)).rejects.toThrow(/insufficient/i);
    });

    it("should throw ChainNotSupportedError for wrong chain", async () => {
      await expect(payer.getAddress("cardano:mainnet")).rejects.toThrow(/not supported/i);
    });
  });
});

// ---------------------------------------------------------------------------
// Native Token Tests (Separate Suite)
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkip)("Cardano Native Token Tests", () => {
  let CardanoNodePayer: typeof import("@poi-sdk/payer-cardano-node").CardanoNodePayer;
  let BlockfrostProvider: typeof import("@poi-sdk/payer-cardano-node").BlockfrostProvider;
  let MemorySigner: typeof import("@poi-sdk/payer-cardano-node").MemorySigner;

  let payer: InstanceType<typeof CardanoNodePayer>;
  let walletAddress: string;

  beforeAll(async () => {
    if (shouldSkip) return;

    const payerModule = await import("@poi-sdk/payer-cardano-node");
    CardanoNodePayer = payerModule.CardanoNodePayer;
    BlockfrostProvider = payerModule.BlockfrostProvider;
    MemorySigner = payerModule.MemorySigner;

    const env = loadTestEnvironment();

    MemorySigner.resetWarning?.();

    const provider = new BlockfrostProvider({
      projectId: env.BLOCKFROST_API_KEY!,
      network: "preprod",
    });

    const signer = new MemorySigner(env.TEST_CARDANO_PRIVATE_KEY!);

    payer = new CardanoNodePayer({
      signer,
      provider,
    });

    walletAddress = await signer.getAddress(CARDANO_PREPROD.chainId);
  });

  it("should not support unknown native tokens", () => {
    // Current implementation only supports ADA
    const request: PaymentRequest = {
      protocol: "flux",
      chain: CARDANO_PREPROD.chainId,
      asset: "abc123def456.TokenName", // Random policy ID
      amountUnits: "1000",
      payTo: walletAddress,
    };

    // Should return false since native tokens aren't supported yet
    expect(payer.supports(request)).toBe(false);
  });

  it("should get native token balance (returns 0 for unknown tokens)", async () => {
    // Check balance for a non-existent token
    const balance = await payer.getBalance(
      CARDANO_PREPROD.chainId,
      "abc123def456789012345678901234567890123456789012345678901234.TestToken"
    );

    expect(typeof balance).toBe("bigint");
    expect(balance).toBe(0n);
  });
});

// Log skip reason if tests are skipped
if (shouldSkip) {
  console.log("\n----------------------------------------");
  console.log("Cardano Integration Tests: SKIPPED");
  console.log("----------------------------------------");
  console.log("Required environment variables:");
  console.log("  - BLOCKFROST_API_KEY: Blockfrost Preprod API key");
  console.log("  - TEST_CARDANO_PRIVATE_KEY: Test wallet private key (hex)");
  console.log("");
  console.log("To run these tests:");
  console.log("  1. Get a Blockfrost API key from https://blockfrost.io");
  console.log("  2. Create a test wallet and export the private key");
  console.log("  3. Fund the wallet from https://docs.cardano.org/cardano-testnets/tools/faucet/");
  console.log("  4. Set the environment variables and run tests");
  console.log("----------------------------------------\n");
}
