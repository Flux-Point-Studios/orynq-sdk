/**
 * @file tests/integration/evm.integration.test.ts
 * @summary Integration tests for EVM payment flows against Base Sepolia testnet.
 *
 * These tests verify:
 * - ViemPayer for direct ERC-20 transfers
 * - EvmX402Payer for EIP-3009 gasless signatures
 * - USDC transfers on Base Sepolia
 * - Transaction verification
 *
 * Prerequisites:
 * - TEST_EVM_PRIVATE_KEY: Hex-encoded private key (with 0x prefix) for test wallet
 * - BASE_SEPOLIA_RPC_URL (optional): Custom RPC URL
 *
 * Test wallet requirements:
 * - Must have ETH for gas on Base Sepolia
 * - Must have USDC on Base Sepolia (get from faucet or bridge)
 * - Get testnet ETH from: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { PaymentRequest, PaymentProof } from "@poi-sdk/core";
import {
  loadTestEnvironment,
  canRunEvmTests,
  logSkipReason,
  BASE_SEPOLIA,
  TEST_AMOUNTS,
  sleep,
  isValidEvmTxHash,
  isValidEvmAddress,
  usdcUnitsToUsdc,
  generateTestEvmAddress,
} from "./setup.js";

// ---------------------------------------------------------------------------
// Test Configuration
// ---------------------------------------------------------------------------

const TEST_TIMEOUT = 120_000; // 2 minutes for on-chain operations

// Skip entire suite if credentials not available
const shouldSkip = !canRunEvmTests();

// ---------------------------------------------------------------------------
// Direct Transfer Tests (payer-evm-direct)
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkip)("EVM Direct Transfer Tests", () => {
  // Lazy imports
  let ViemPayer: typeof import("@poi-sdk/payer-evm-direct").ViemPayer;

  let payer: InstanceType<typeof ViemPayer>;
  let walletAddress: string;

  beforeAll(async () => {
    if (shouldSkip) {
      logSkipReason("EVM Direct Transfer Tests", "Missing TEST_EVM_PRIVATE_KEY");
      return;
    }

    const payerModule = await import("@poi-sdk/payer-evm-direct");
    ViemPayer = payerModule.ViemPayer;

    const env = loadTestEnvironment();

    // Initialize payer
    payer = new ViemPayer({
      privateKey: env.TEST_EVM_PRIVATE_KEY as `0x${string}`,
      chains: [BASE_SEPOLIA.chainId],
      rpcUrls: {
        [BASE_SEPOLIA.chainId]: env.BASE_SEPOLIA_RPC_URL || BASE_SEPOLIA.rpcUrl,
      },
    });

    walletAddress = await payer.getAddress(BASE_SEPOLIA.chainId);
    console.log(`\n  Test wallet address: ${walletAddress}`);
  });

  describe("ViemPayer Configuration", () => {
    it("should report correct supported chains", () => {
      expect(payer.supportedChains).toContain(BASE_SEPOLIA.chainId);
    });

    it("should return wallet address", async () => {
      const address = await payer.getAddress(BASE_SEPOLIA.chainId);

      expect(isValidEvmAddress(address)).toBe(true);
      expect(address.toLowerCase()).toBe(walletAddress.toLowerCase());
    });

    it("should get ETH balance", async () => {
      const balance = await payer.getBalance(BASE_SEPOLIA.chainId, "ETH");

      expect(typeof balance).toBe("bigint");
      expect(balance).toBeGreaterThanOrEqual(0n);

      const ethValue = Number(balance) / 1e18;
      console.log(`  ETH balance: ${ethValue.toFixed(6)} ETH`);

      if (balance < BigInt(TEST_AMOUNTS.ETH_WEI)) {
        console.warn(
          `\n  WARNING: Low ETH balance. Get testnet ETH from:\n` +
            `  https://www.coinbase.com/faucets/base-ethereum-goerli-faucet\n`
        );
      }
    });

    it("should get USDC balance", async () => {
      const balance = await payer.getBalance(BASE_SEPOLIA.chainId, "USDC");

      expect(typeof balance).toBe("bigint");
      expect(balance).toBeGreaterThanOrEqual(0n);

      console.log(`  USDC balance: ${usdcUnitsToUsdc(balance)}`);

      if (balance < BigInt(TEST_AMOUNTS.USDC_UNITS) * 10n) {
        console.warn(
          `\n  WARNING: Low USDC balance (${usdcUnitsToUsdc(balance)}). ` +
            `Need USDC on Base Sepolia for transfer tests.\n`
        );
      }
    });
  });

  describe("Payment Support", () => {
    it("should support USDC payment requests on Base Sepolia", () => {
      const request: PaymentRequest = {
        protocol: "flux",
        chain: BASE_SEPOLIA.chainId,
        asset: "USDC",
        amountUnits: TEST_AMOUNTS.USDC_UNITS,
        payTo: generateTestEvmAddress(),
      };

      expect(payer.supports(request)).toBe(true);
    });

    it("should support ETH payment requests", () => {
      const request: PaymentRequest = {
        protocol: "flux",
        chain: BASE_SEPOLIA.chainId,
        asset: "ETH",
        amountUnits: TEST_AMOUNTS.ETH_WEI,
        payTo: generateTestEvmAddress(),
      };

      expect(payer.supports(request)).toBe(true);
    });

    it("should not support unsupported chains", () => {
      const request: PaymentRequest = {
        protocol: "flux",
        chain: "cardano:mainnet",
        asset: "ADA",
        amountUnits: "1000000",
        payTo: "addr1...",
      };

      expect(payer.supports(request)).toBe(false);
    });
  });

  describe("ERC-20 USDC Transfer", () => {
    let paymentProof: PaymentProof | null = null;

    it(
      "should execute USDC transfer",
      async () => {
        // Check USDC balance first
        const usdcBalance = await payer.getBalance(BASE_SEPOLIA.chainId, "USDC");

        if (usdcBalance < BigInt(TEST_AMOUNTS.USDC_UNITS)) {
          console.log(
            `  Skipping: Insufficient USDC balance (${usdcUnitsToUsdc(usdcBalance)} < ${usdcUnitsToUsdc(TEST_AMOUNTS.USDC_UNITS)})`
          );
          return;
        }

        // Check ETH for gas
        const ethBalance = await payer.getBalance(BASE_SEPOLIA.chainId, "ETH");
        if (ethBalance < BigInt("100000000000000")) {
          // 0.0001 ETH minimum
          console.log("  Skipping: Insufficient ETH for gas");
          return;
        }

        // Create payment request - send to self for testing
        const request: PaymentRequest = {
          protocol: "flux",
          chain: BASE_SEPOLIA.chainId,
          asset: "USDC",
          amountUnits: TEST_AMOUNTS.USDC_UNITS,
          payTo: walletAddress as `0x${string}`, // Send to self
        };

        console.log(`  Executing USDC transfer of ${usdcUnitsToUsdc(TEST_AMOUNTS.USDC_UNITS)}...`);
        const startTime = Date.now();

        paymentProof = await payer.pay(request);

        const duration = Date.now() - startTime;
        console.log(`  Transaction completed in ${duration}ms`);

        // Validate proof
        expect(paymentProof).toBeDefined();
        expect(paymentProof.kind).toBe("evm-txhash");

        if (paymentProof.kind === "evm-txhash") {
          expect(isValidEvmTxHash(paymentProof.txHash)).toBe(true);
          console.log(`  Transaction hash: ${paymentProof.txHash}`);
        }
      },
      TEST_TIMEOUT
    );

    it("should have valid transaction hash in proof", () => {
      if (!paymentProof) {
        console.log("  Skipping: No transaction proof available");
        return;
      }

      expect(paymentProof.kind).toBe("evm-txhash");
      if (paymentProof.kind === "evm-txhash") {
        expect(paymentProof.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
      }
    });
  });

  describe("Error Handling", () => {
    it("should throw InsufficientBalanceError for large USDC amounts", async () => {
      const request: PaymentRequest = {
        protocol: "flux",
        chain: BASE_SEPOLIA.chainId,
        asset: "USDC",
        amountUnits: "999999999999999999", // Huge amount
        payTo: walletAddress as `0x${string}`,
      };

      await expect(payer.pay(request)).rejects.toThrow(/insufficient/i);
    });
  });
});

// ---------------------------------------------------------------------------
// EIP-3009 Gasless Signature Tests (payer-evm-x402)
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkip)("EVM x402 Gasless Signature Tests", () => {
  let EvmX402Payer: typeof import("@poi-sdk/payer-evm-x402").EvmX402Payer;
  let ViemSigner: typeof import("@poi-sdk/payer-evm-x402").ViemSigner;
  let decodeAuthorizationFromBase64: typeof import("@poi-sdk/payer-evm-x402").decodeAuthorizationFromBase64;
  let isAuthorizationValid: typeof import("@poi-sdk/payer-evm-x402").isAuthorizationValid;

  let payer: InstanceType<typeof EvmX402Payer>;
  let walletAddress: string;

  beforeAll(async () => {
    if (shouldSkip) {
      logSkipReason("EVM x402 Tests", "Missing TEST_EVM_PRIVATE_KEY");
      return;
    }

    const x402Module = await import("@poi-sdk/payer-evm-x402");
    EvmX402Payer = x402Module.EvmX402Payer;
    ViemSigner = x402Module.ViemSigner;
    decodeAuthorizationFromBase64 = x402Module.decodeAuthorizationFromBase64;
    isAuthorizationValid = x402Module.isAuthorizationValid;

    const env = loadTestEnvironment();

    // Create signer
    const signer = new ViemSigner({
      privateKey: env.TEST_EVM_PRIVATE_KEY as `0x${string}`,
    });

    // Initialize x402 payer
    payer = new EvmX402Payer({
      signer,
      chains: [BASE_SEPOLIA.chainId],
      rpcUrls: {
        [BASE_SEPOLIA.chainId]: env.BASE_SEPOLIA_RPC_URL || BASE_SEPOLIA.rpcUrl,
      },
    });

    walletAddress = await payer.getAddress(BASE_SEPOLIA.chainId);
    console.log(`\n  Test wallet address: ${walletAddress}`);
  });

  describe("EvmX402Payer Configuration", () => {
    it("should report correct supported chains", () => {
      expect(payer.supportedChains).toContain(BASE_SEPOLIA.chainId);
    });

    it("should return wallet address", async () => {
      const address = await payer.getAddress(BASE_SEPOLIA.chainId);

      expect(isValidEvmAddress(address)).toBe(true);
    });

    it("should get USDC balance", async () => {
      const balance = await payer.getBalance(BASE_SEPOLIA.chainId, "USDC");

      expect(typeof balance).toBe("bigint");
      expect(balance).toBeGreaterThanOrEqual(0n);

      console.log(`  USDC balance: ${usdcUnitsToUsdc(balance)}`);
    });
  });

  describe("x402 Payment Support", () => {
    it("should support x402 USDC payment requests", () => {
      const request: PaymentRequest = {
        protocol: "x402",
        chain: BASE_SEPOLIA.chainId,
        asset: "USDC",
        amountUnits: TEST_AMOUNTS.USDC_UNITS,
        payTo: generateTestEvmAddress(),
      };

      expect(payer.supports(request)).toBe(true);
    });

    it("should not support non-x402 protocols", () => {
      const request: PaymentRequest = {
        protocol: "flux",
        chain: BASE_SEPOLIA.chainId,
        asset: "USDC",
        amountUnits: TEST_AMOUNTS.USDC_UNITS,
        payTo: generateTestEvmAddress(),
      };

      expect(payer.supports(request)).toBe(false);
    });
  });

  describe("EIP-3009 Signature Generation", () => {
    let signatureProof: PaymentProof | null = null;

    it("should create valid EIP-3009 TransferWithAuthorization signature", async () => {
      // Check balance first (need some USDC even though we're just signing)
      const balance = await payer.getBalance(BASE_SEPOLIA.chainId, "USDC");

      if (balance < BigInt(TEST_AMOUNTS.USDC_UNITS)) {
        console.log(
          `  Note: Low USDC balance, but signature creation should still work`
        );
      }

      // Create x402 payment request
      const request: PaymentRequest = {
        protocol: "x402",
        chain: BASE_SEPOLIA.chainId,
        asset: "USDC",
        amountUnits: TEST_AMOUNTS.USDC_UNITS,
        payTo: generateTestEvmAddress(),
        timeoutSeconds: 3600, // 1 hour validity
      };

      // Skip if insufficient balance
      if (balance < BigInt(request.amountUnits)) {
        console.log("  Skipping signature test: insufficient USDC balance");
        return;
      }

      console.log(`  Creating EIP-3009 signature for ${usdcUnitsToUsdc(TEST_AMOUNTS.USDC_UNITS)}...`);

      signatureProof = await payer.pay(request);

      // Validate proof structure
      expect(signatureProof).toBeDefined();
      expect(signatureProof.kind).toBe("x402-signature");

      if (signatureProof.kind === "x402-signature") {
        expect(signatureProof.signature).toBeDefined();
        expect(signatureProof.signature.length).toBeGreaterThan(0);
        console.log(`  Signature created (${signatureProof.signature.length} chars)`);
      }
    });

    it("should produce valid authorization that can be decoded", async () => {
      if (!signatureProof || signatureProof.kind !== "x402-signature") {
        console.log("  Skipping: No signature proof available");
        return;
      }

      // Decode the base64-encoded authorization
      const authorization = decodeAuthorizationFromBase64(signatureProof.signature);

      expect(authorization).toBeDefined();
      expect(authorization.domain).toBeDefined();
      expect(authorization.message).toBeDefined();
      expect(authorization.signature).toBeDefined();

      // Verify authorization structure
      expect(authorization.domain.name).toBe("USD Coin");
      expect(authorization.domain.chainId).toBe(BigInt(BASE_SEPOLIA.evmChainId));
      expect(authorization.message.from.toLowerCase()).toBe(walletAddress.toLowerCase());
      expect(authorization.message.value).toBe(BigInt(TEST_AMOUNTS.USDC_UNITS));

      console.log(`  Authorization decoded successfully`);
      console.log(`  - From: ${authorization.message.from}`);
      console.log(`  - To: ${authorization.message.to}`);
      console.log(`  - Value: ${authorization.message.value}`);
    });

    it("should produce time-valid authorization", async () => {
      if (!signatureProof || signatureProof.kind !== "x402-signature") {
        console.log("  Skipping: No signature proof available");
        return;
      }

      const authorization = decodeAuthorizationFromBase64(signatureProof.signature);
      const { isValid, reason } = isAuthorizationValid(authorization);

      expect(isValid).toBe(true);
      if (!isValid) {
        console.error(`  Authorization invalid: ${reason}`);
      } else {
        console.log(`  Authorization is time-valid`);
        console.log(`  - Valid after: ${authorization.message.validAfter}`);
        console.log(`  - Valid before: ${authorization.message.validBefore}`);
      }
    });
  });

  describe("Error Handling", () => {
    it("should throw for non-x402 protocol", async () => {
      const request: PaymentRequest = {
        protocol: "flux",
        chain: BASE_SEPOLIA.chainId,
        asset: "USDC",
        amountUnits: TEST_AMOUNTS.USDC_UNITS,
        payTo: generateTestEvmAddress(),
      };

      await expect(payer.pay(request)).rejects.toThrow(/x402/i);
    });

    it("should throw InsufficientBalanceError for amounts exceeding balance", async () => {
      const request: PaymentRequest = {
        protocol: "x402",
        chain: BASE_SEPOLIA.chainId,
        asset: "USDC",
        amountUnits: "999999999999999999",
        payTo: generateTestEvmAddress(),
      };

      await expect(payer.pay(request)).rejects.toThrow(/insufficient/i);
    });
  });
});

// Log skip reason if tests are skipped
if (shouldSkip) {
  console.log("\n----------------------------------------");
  console.log("EVM Integration Tests: SKIPPED");
  console.log("----------------------------------------");
  console.log("Required environment variables:");
  console.log("  - TEST_EVM_PRIVATE_KEY: Test wallet private key (0x prefixed)");
  console.log("");
  console.log("Optional environment variables:");
  console.log("  - BASE_SEPOLIA_RPC_URL: Custom RPC URL for Base Sepolia");
  console.log("");
  console.log("To run these tests:");
  console.log("  1. Create a test wallet (e.g., using MetaMask)");
  console.log("  2. Export the private key (with 0x prefix)");
  console.log("  3. Get testnet ETH from https://www.coinbase.com/faucets/base-ethereum-goerli-faucet");
  console.log("  4. Get testnet USDC (bridge or faucet if available)");
  console.log("  5. Set TEST_EVM_PRIVATE_KEY and run tests");
  console.log("----------------------------------------\n");
}
