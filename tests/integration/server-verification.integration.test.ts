/**
 * @file tests/integration/server-verification.integration.test.ts
 * @summary Integration tests for server-side payment verification.
 *
 * These tests verify:
 * - CardanoVerifier with real Blockfrost API
 * - EvmVerifier with real Base Sepolia RPC
 * - Transaction hash verification
 * - x402 signature verification (trust facilitator mode)
 * - Error handling for invalid proofs
 *
 * Prerequisites:
 * - BLOCKFROST_API_KEY: For Cardano verification tests
 * - BASE_SEPOLIA_RPC_URL (optional): For EVM verification tests
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { PaymentProof } from "@fluxpointstudios/orynq-sdk-core";
import {
  loadTestEnvironment,
  canRunCardanoTests,
  canRunEvmTests,
  logSkipReason,
  CARDANO_PREPROD,
  BASE_SEPOLIA,
  isValidCardanoTxHash,
  isValidEvmTxHash,
} from "./setup.js";

// ---------------------------------------------------------------------------
// Test Configuration
// ---------------------------------------------------------------------------

const TEST_TIMEOUT = 60_000;

// Known testnet transactions for verification tests
// These should be real confirmed transactions on the testnets
const KNOWN_TRANSACTIONS = {
  cardano: {
    // Example preprod transaction - replace with a real one for actual testing
    // You can find transactions on: https://preprod.cardanoscan.io/
    txHash: "0000000000000000000000000000000000000000000000000000000000000000", // Placeholder
    recipient: "addr_test1qz...", // Placeholder
    amount: "1000000", // 1 ADA
  },
  evm: {
    // Example Base Sepolia transaction - replace with a real one for actual testing
    // You can find transactions on: https://sepolia.basescan.org/
    txHash: "0x0000000000000000000000000000000000000000000000000000000000000000", // Placeholder
    recipient: "0x0000000000000000000000000000000000000000", // Placeholder
    amount: "10000", // 0.01 USDC
  },
};

// ---------------------------------------------------------------------------
// Cardano Verifier Tests
// ---------------------------------------------------------------------------

const shouldSkipCardano = !canRunCardanoTests();

describe.skipIf(shouldSkipCardano)("Cardano Payment Verification", () => {
  let CardanoVerifier: typeof import("@fluxpointstudios/orynq-sdk-server-middleware").CardanoVerifier;
  let verifier: InstanceType<typeof CardanoVerifier>;

  beforeAll(async () => {
    if (shouldSkipCardano) {
      logSkipReason("Cardano Verification Tests", "Missing BLOCKFROST_API_KEY");
      return;
    }

    const middlewareModule = await import("@fluxpointstudios/orynq-sdk-server-middleware");
    CardanoVerifier = middlewareModule.CardanoVerifier;

    const env = loadTestEnvironment();

    verifier = new CardanoVerifier({
      blockfrostProjectId: env.BLOCKFROST_API_KEY!,
      network: "preprod",
      minConfirmations: 1,
    });

    console.log("\n  Cardano verifier initialized for preprod network");
  });

  describe("Verifier Configuration", () => {
    it("should report correct supported chains", () => {
      expect(verifier.supportedChains).toContain(CARDANO_PREPROD.chainId);
    });
  });

  describe("Transaction Hash Verification", () => {
    it("should reject invalid transaction hash format", async () => {
      const invalidProof: PaymentProof = {
        kind: "cardano-txhash",
        txHash: "invalid-hash",
      };

      const result = await verifier.verify(
        invalidProof,
        BigInt("1000000"),
        "addr_test1...",
        CARDANO_PREPROD.chainId
      );

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/invalid|format/i);

      console.log("  Invalid hash format rejected");
    });

    it("should reject non-existent transaction", async () => {
      const nonExistentProof: PaymentProof = {
        kind: "cardano-txhash",
        // Valid format but doesn't exist
        txHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      };

      const result = await verifier.verify(
        nonExistentProof,
        BigInt("1000000"),
        "addr_test1...",
        CARDANO_PREPROD.chainId
      );

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/not found/i);

      console.log("  Non-existent transaction rejected");
    });

    it("should reject unsupported proof kinds", async () => {
      const invalidProof = {
        kind: "unknown-kind",
        data: "test",
      } as unknown as PaymentProof;

      const result = await verifier.verify(
        invalidProof,
        BigInt("1000000"),
        "addr_test1...",
        CARDANO_PREPROD.chainId
      );

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/unsupported|kind/i);

      console.log("  Unsupported proof kind rejected");
    });

    it("should reject unsupported chains", async () => {
      const proof: PaymentProof = {
        kind: "cardano-txhash",
        txHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      };

      const result = await verifier.verify(
        proof,
        BigInt("1000000"),
        "addr1...",
        "cardano:mainnet" // Wrong network
      );

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/not supported/i);

      console.log("  Unsupported chain rejected");
    });

    // This test requires a real confirmed transaction
    it.skip("should verify real confirmed transaction", async () => {
      // Replace KNOWN_TRANSACTIONS.cardano with a real transaction
      const proof: PaymentProof = {
        kind: "cardano-txhash",
        txHash: KNOWN_TRANSACTIONS.cardano.txHash,
      };

      const result = await verifier.verify(
        proof,
        BigInt(KNOWN_TRANSACTIONS.cardano.amount),
        KNOWN_TRANSACTIONS.cardano.recipient,
        CARDANO_PREPROD.chainId
      );

      expect(result.verified).toBe(true);
      expect(result.txHash).toBe(KNOWN_TRANSACTIONS.cardano.txHash);
      expect(result.confirmations).toBeGreaterThan(0);

      console.log(`  Transaction verified with ${result.confirmations} confirmations`);
    });
  });

  describe("Amount Verification", () => {
    // This test requires a real transaction
    it.skip("should reject if amount is insufficient", async () => {
      const proof: PaymentProof = {
        kind: "cardano-txhash",
        txHash: KNOWN_TRANSACTIONS.cardano.txHash,
      };

      // Request more than the transaction contains
      const result = await verifier.verify(
        proof,
        BigInt("999999999999"), // Much more than expected
        KNOWN_TRANSACTIONS.cardano.recipient,
        CARDANO_PREPROD.chainId
      );

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/amount|mismatch/i);

      console.log("  Insufficient amount rejected");
    });
  });
});

// ---------------------------------------------------------------------------
// EVM Verifier Tests
// ---------------------------------------------------------------------------

describe("EVM Payment Verification", () => {
  let EvmVerifier: typeof import("@fluxpointstudios/orynq-sdk-server-middleware").EvmVerifier;
  let verifier: InstanceType<typeof EvmVerifier>;

  beforeAll(async () => {
    const middlewareModule = await import("@fluxpointstudios/orynq-sdk-server-middleware");
    EvmVerifier = middlewareModule.EvmVerifier;

    const env = loadTestEnvironment();

    verifier = new EvmVerifier({
      chains: [BASE_SEPOLIA.chainId],
      rpcUrls: {
        [BASE_SEPOLIA.chainId]: env.BASE_SEPOLIA_RPC_URL || BASE_SEPOLIA.rpcUrl,
      },
      minConfirmations: 1,
      trustFacilitator: true, // Trust x402 signatures
    });

    console.log("\n  EVM verifier initialized for Base Sepolia");
  });

  describe("Verifier Configuration", () => {
    it("should report correct supported chains", () => {
      expect(verifier.supportedChains).toContain(BASE_SEPOLIA.chainId);
    });
  });

  describe("Transaction Hash Verification", () => {
    it("should reject invalid transaction hash format", async () => {
      const invalidProof: PaymentProof = {
        kind: "evm-txhash",
        txHash: "invalid-hash",
      };

      const result = await verifier.verify(
        invalidProof,
        BigInt("10000"),
        "0x1234567890123456789012345678901234567890",
        BASE_SEPOLIA.chainId
      );

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/invalid|format/i);

      console.log("  Invalid hash format rejected");
    });

    it("should reject non-existent transaction", async () => {
      const nonExistentProof: PaymentProof = {
        kind: "evm-txhash",
        // Valid format but doesn't exist
        txHash: `0x${"a".repeat(64)}`,
      };

      const result = await verifier.verify(
        nonExistentProof,
        BigInt("10000"),
        "0x1234567890123456789012345678901234567890",
        BASE_SEPOLIA.chainId
      );

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/not found/i);

      console.log("  Non-existent transaction rejected");
    });

    it("should reject unsupported proof kinds", async () => {
      const invalidProof = {
        kind: "cardano-txhash", // Wrong kind for EVM
        txHash: "abc123",
      } as unknown as PaymentProof;

      const result = await verifier.verify(
        invalidProof,
        BigInt("10000"),
        "0x1234567890123456789012345678901234567890",
        BASE_SEPOLIA.chainId
      );

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/unsupported|kind/i);

      console.log("  Wrong proof kind rejected");
    });

    it("should reject unsupported chains", async () => {
      const proof: PaymentProof = {
        kind: "evm-txhash",
        txHash: `0x${"a".repeat(64)}`,
      };

      const result = await verifier.verify(
        proof,
        BigInt("10000"),
        "0x...",
        "eip155:1" // Ethereum mainnet - not in supported chains
      );

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/not supported/i);

      console.log("  Unsupported chain rejected");
    });

    // This test requires a real confirmed transaction
    it.skip("should verify real confirmed transaction", async () => {
      // Replace KNOWN_TRANSACTIONS.evm with a real transaction
      const proof: PaymentProof = {
        kind: "evm-txhash",
        txHash: KNOWN_TRANSACTIONS.evm.txHash,
      };

      const result = await verifier.verify(
        proof,
        BigInt(KNOWN_TRANSACTIONS.evm.amount),
        KNOWN_TRANSACTIONS.evm.recipient,
        BASE_SEPOLIA.chainId
      );

      expect(result.verified).toBe(true);
      expect(result.txHash).toBe(KNOWN_TRANSACTIONS.evm.txHash);
      expect(result.confirmations).toBeGreaterThan(0);

      console.log(`  Transaction verified with ${result.confirmations} confirmations`);
    });
  });

  describe("x402 Signature Verification", () => {
    it("should accept x402 signature proof in trust mode", async () => {
      // In trust facilitator mode, x402 signatures are accepted without verification
      const signatureProof: PaymentProof = {
        kind: "x402-signature",
        signature: "test-signature",
        payload: JSON.stringify({ test: true }),
      };

      const result = await verifier.verify(
        signatureProof,
        BigInt("10000"),
        "0x1234567890123456789012345678901234567890",
        BASE_SEPOLIA.chainId
      );

      expect(result.verified).toBe(true);

      console.log("  x402 signature accepted in trust mode");
    });

    it("should reject x402 signature when trust mode is disabled", async () => {
      // Create verifier without trust mode
      const middlewareModule = await import("@fluxpointstudios/orynq-sdk-server-middleware");
      const strictVerifier = new middlewareModule.EvmVerifier({
        chains: [BASE_SEPOLIA.chainId],
        trustFacilitator: false,
      });

      const signatureProof: PaymentProof = {
        kind: "x402-signature",
        signature: "test-signature",
      };

      const result = await strictVerifier.verify(
        signatureProof,
        BigInt("10000"),
        "0x1234567890123456789012345678901234567890",
        BASE_SEPOLIA.chainId
      );

      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/trust|verification/i);

      console.log("  x402 signature rejected when trust mode disabled");
    });
  });
});

// ---------------------------------------------------------------------------
// Express Middleware Tests
// ---------------------------------------------------------------------------

describe("Express Middleware Integration", () => {
  let requirePayment: typeof import("@fluxpointstudios/orynq-sdk-server-middleware").requirePayment;
  let MemoryInvoiceStore: typeof import("@fluxpointstudios/orynq-sdk-server-middleware").MemoryInvoiceStore;
  let EvmVerifier: typeof import("@fluxpointstudios/orynq-sdk-server-middleware").EvmVerifier;

  beforeAll(async () => {
    const middlewareModule = await import("@fluxpointstudios/orynq-sdk-server-middleware");
    requirePayment = middlewareModule.requirePayment;
    MemoryInvoiceStore = middlewareModule.MemoryInvoiceStore;
    EvmVerifier = middlewareModule.EvmVerifier;
  });

  it("should create middleware with valid configuration", () => {
    const store = new MemoryInvoiceStore();
    const verifier = new EvmVerifier({
      chains: [BASE_SEPOLIA.chainId],
      trustFacilitator: true,
    });

    const middleware = requirePayment({
      price: () => ({
        chain: BASE_SEPOLIA.chainId,
        asset: "USDC",
        amountUnits: "10000",
      }),
      payTo: "0x1234567890123456789012345678901234567890",
      storage: store,
      verifiers: [verifier],
    });

    expect(typeof middleware).toBe("function");
    expect(middleware.length).toBe(3); // Express middleware signature

    console.log("  Middleware created successfully");
  });

  it("should create invoice in memory store", async () => {
    const store = new MemoryInvoiceStore();

    const invoice = await store.create({
      chain: BASE_SEPOLIA.chainId,
      asset: "USDC",
      amountUnits: "10000",
      payTo: "0x1234567890123456789012345678901234567890",
      expiresInSeconds: 300,
    });

    expect(invoice).toBeDefined();
    expect(invoice.id).toBeDefined();
    expect(invoice.chain).toBe(BASE_SEPOLIA.chainId);
    expect(invoice.asset).toBe("USDC");
    expect(invoice.amountUnits).toBe("10000");
    expect(invoice.status).toBe("pending");

    // Retrieve invoice
    const retrieved = await store.get(invoice.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(invoice.id);

    console.log(`  Invoice created: ${invoice.id}`);
  });

  it("should update invoice status", async () => {
    const store = new MemoryInvoiceStore();

    const invoice = await store.create({
      chain: BASE_SEPOLIA.chainId,
      asset: "USDC",
      amountUnits: "10000",
      payTo: "0x...",
      expiresInSeconds: 300,
    });

    // Update to confirmed
    await store.updateStatus(invoice.id, "confirmed", `0x${"a".repeat(64)}`);

    const updated = await store.get(invoice.id);
    expect(updated?.status).toBe("confirmed");
    expect(updated?.txHash).toBe(`0x${"a".repeat(64)}`);

    // Mark as consumed
    await store.markConsumed(invoice.id);

    const consumed = await store.get(invoice.id);
    expect(consumed?.status).toBe("consumed");

    console.log("  Invoice status transitions verified");
  });

  it("should handle idempotency key deduplication", async () => {
    const store = new MemoryInvoiceStore();

    const idempotencyKey = "test-key-123";

    const invoice1 = await store.create({
      chain: BASE_SEPOLIA.chainId,
      asset: "USDC",
      amountUnits: "10000",
      payTo: "0x...",
      expiresInSeconds: 300,
      idempotencyKey,
    });

    // Try to create another invoice with same key - should return existing
    const existing = await store.findByIdempotencyKey(idempotencyKey);
    expect(existing).toBeDefined();
    expect(existing?.id).toBe(invoice1.id);

    console.log("  Idempotency deduplication verified");
  });
});

// ---------------------------------------------------------------------------
// Log test suite information
// ---------------------------------------------------------------------------

console.log("\n----------------------------------------");
console.log("Server Verification Integration Tests");
console.log("----------------------------------------");
console.log("Tests run against real testnets:");
console.log("  - Cardano Preprod (requires BLOCKFROST_API_KEY)");
console.log("  - Base Sepolia (uses public RPC by default)");
console.log("");
console.log("Note: Some tests are skipped unless you have real");
console.log("confirmed transactions to test against.");
console.log("----------------------------------------\n");
