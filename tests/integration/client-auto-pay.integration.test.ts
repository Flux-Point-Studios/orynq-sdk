/**
 * @file tests/integration/client-auto-pay.integration.test.ts
 * @summary Integration tests for the PoiClient auto-pay flow.
 *
 * These tests verify:
 * - Client detects 402 Payment Required responses
 * - Client extracts payment requirements from headers
 * - Client executes payment via configured payer
 * - Client retries request with payment proof
 * - Full end-to-end payment flow
 *
 * This test suite uses a mock server to simulate 402 responses
 * and real payers to execute actual payments when credentials are available.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import type { PaymentRequest, PaymentProof, Payer } from "@fluxpointstudios/orynq-sdk-core";
import {
  loadTestEnvironment,
  canRunEvmTests,
  logSkipReason,
  BASE_SEPOLIA,
  TEST_AMOUNTS,
  generateTestEvmAddress,
} from "./setup.js";

// ---------------------------------------------------------------------------
// Test Configuration
// ---------------------------------------------------------------------------

const TEST_TIMEOUT = 60_000;
const MOCK_SERVER_PORT = 9876;

// ---------------------------------------------------------------------------
// Mock Server
// ---------------------------------------------------------------------------

interface MockServerState {
  paymentReceived: boolean;
  paymentProof: PaymentProof | null;
  invoiceId: string;
  requestCount: number;
}

/**
 * Create a mock server that returns 402 on first request,
 * then 200 when valid payment proof is provided.
 *
 * Uses Flux protocol header names:
 * - Request: X-Invoice-Id, X-Payment (lowercase in Node.js: x-invoice-id, x-payment)
 * - Response: X-Invoice-Id, X-Pay-To, X-Amount, X-Asset, X-Chain, X-Timeout
 */
function createMockServer(state: MockServerState): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    state.requestCount++;

    // Check for payment proof in headers (Node.js lowercases all headers)
    // Flux protocol uses X-Payment and X-Invoice-Id
    const paymentHeader = req.headers["x-payment"] as string | undefined;
    const invoiceIdHeader = req.headers["x-invoice-id"] as string | undefined;

    if (paymentHeader && invoiceIdHeader === state.invoiceId) {
      // Payment provided - return success
      state.paymentReceived = true;
      try {
        state.paymentProof = JSON.parse(paymentHeader);
      } catch {
        state.paymentProof = { kind: "evm-txhash", txHash: paymentHeader } as PaymentProof;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, message: "Payment accepted" }));
      return;
    }

    // No payment - return 402 with Flux format body
    // Flux parser expects: invoiceId, amount, currency, payTo, chain
    const payTo = generateTestEvmAddress();
    res.writeHead(402, {
      "Content-Type": "application/json",
      // Flux protocol response headers (without "Flux-" prefix)
      "X-Invoice-Id": state.invoiceId,
      "X-Pay-To": payTo,
      "X-Amount": TEST_AMOUNTS.USDC_UNITS,
      "X-Asset": "USDC",
      "X-Chain": BASE_SEPOLIA.chainId,
      "X-Timeout": "3600",
    });
    res.end(
      JSON.stringify({
        // Flux invoice format - required fields
        invoiceId: state.invoiceId,
        amount: TEST_AMOUNTS.USDC_UNITS,
        currency: "USDC",
        payTo: payTo,
        chain: BASE_SEPOLIA.chainId,
        // Optional fields
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      })
    );
  });
}

// ---------------------------------------------------------------------------
// Mock Payer
// ---------------------------------------------------------------------------

/**
 * Create a mock payer for testing without real credentials.
 */
function createMockPayer(): Payer {
  return {
    supportedChains: [BASE_SEPOLIA.chainId] as const,

    supports(request: PaymentRequest): boolean {
      return request.chain === BASE_SEPOLIA.chainId && request.asset === "USDC";
    },

    async getAddress(_chain: string): Promise<string> {
      return "0x1234567890123456789012345678901234567890";
    },

    async getBalance(_chain: string, _asset: string): Promise<bigint> {
      return BigInt("1000000000"); // 1000 USDC
    },

    async pay(request: PaymentRequest): Promise<PaymentProof> {
      // Simulate payment execution
      return {
        kind: "evm-txhash",
        txHash: `0x${"a".repeat(64)}`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Test Suite: Mock Server Flow
// ---------------------------------------------------------------------------

describe("Client Auto-Pay Flow (Mock Server)", () => {
  let PoiClient: typeof import("@fluxpointstudios/orynq-sdk-client").PoiClient;

  let server: Server;
  let serverState: MockServerState;

  beforeAll(async () => {
    const clientModule = await import("@fluxpointstudios/orynq-sdk-client");
    PoiClient = clientModule.PoiClient;
  });

  beforeEach(() => {
    serverState = {
      paymentReceived: false,
      paymentProof: null,
      invoiceId: `invoice-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      requestCount: 0,
    };
  });

  afterAll(() => {
    if (server) {
      server.close();
    }
  });

  it("should detect 402 and extract payment requirements", async () => {
    server = createMockServer(serverState);
    await new Promise<void>((resolve) => server.listen(MOCK_SERVER_PORT, resolve));

    try {
      const client = new PoiClient({
        baseUrl: `http://localhost:${MOCK_SERVER_PORT}`,
        payer: createMockPayer(),
      });

      // Get payment request without paying
      const paymentRequest = await client.getPaymentRequest("/api/test");

      expect(paymentRequest).not.toBeNull();
      expect(paymentRequest?.chain).toBe(BASE_SEPOLIA.chainId);
      expect(paymentRequest?.asset).toBe("USDC");
      expect(paymentRequest?.amountUnits).toBe(TEST_AMOUNTS.USDC_UNITS);
      expect(paymentRequest?.invoiceId).toBe(serverState.invoiceId);

      console.log("  Payment requirements extracted:", {
        chain: paymentRequest?.chain,
        asset: paymentRequest?.asset,
        amount: paymentRequest?.amountUnits,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it(
    "should complete full auto-pay flow with mock payer",
    async () => {
      server = createMockServer(serverState);
      await new Promise<void>((resolve) => server.listen(MOCK_SERVER_PORT, resolve));

      try {
        const mockPayer = createMockPayer();
        let paymentMade = false;
        let paymentAmount: string | null = null;

        const client = new PoiClient({
          baseUrl: `http://localhost:${MOCK_SERVER_PORT}`,
          payer: mockPayer,
          // Use fast retry options for tests
          retryOptions: {
            maxWaitMs: 5000,
            pollIntervalMs: 500,
            maxRetries: 2,
          },
          onPaymentRequired: (request) => {
            console.log(`  Payment required: ${request.amountUnits} ${request.asset}`);
            paymentAmount = request.amountUnits;
            return true; // Approve payment
          },
          onPaymentConfirmed: (request, proof) => {
            console.log(`  Payment confirmed: ${proof.kind}`);
            paymentMade = true;
          },
        });

        // Make request - should auto-pay
        const response = await client.request<{ success: boolean; message: string }>("/api/test");

        expect(response).toBeDefined();
        expect(response.success).toBe(true);
        expect(response.message).toBe("Payment accepted");

        // Verify callbacks were called
        expect(paymentMade).toBe(true);
        expect(paymentAmount).toBe(TEST_AMOUNTS.USDC_UNITS);

        // Verify server received payment
        expect(serverState.paymentReceived).toBe(true);
        expect(serverState.paymentProof).not.toBeNull();
        expect(serverState.requestCount).toBeGreaterThanOrEqual(2); // Initial + retry

        console.log("  Full auto-pay flow completed successfully");
      } finally {
        // Wait a small delay to allow pending connections to complete before closing
        await new Promise((resolve) => setTimeout(resolve, 100));
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    { timeout: TEST_TIMEOUT, retry: 2 }
  );

  it("should respect onPaymentRequired cancellation", async () => {
    server = createMockServer(serverState);
    await new Promise<void>((resolve) => server.listen(MOCK_SERVER_PORT, resolve));

    try {
      const client = new PoiClient({
        baseUrl: `http://localhost:${MOCK_SERVER_PORT}`,
        payer: createMockPayer(),
        onPaymentRequired: () => {
          console.log("  Payment required but cancelled by callback");
          return false; // Cancel payment
        },
      });

      // Should throw because payment was cancelled
      await expect(client.request("/api/test")).rejects.toThrow(/cancelled/i);

      // Server should not have received payment
      expect(serverState.paymentReceived).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("should skip payment when skipPayment option is set", async () => {
    server = createMockServer(serverState);
    await new Promise<void>((resolve) => server.listen(MOCK_SERVER_PORT, resolve));

    try {
      const client = new PoiClient({
        baseUrl: `http://localhost:${MOCK_SERVER_PORT}`,
        payer: createMockPayer(),
      });

      // Make request with skipPayment - should get 402 error
      await expect(
        client.request("/api/test", { skipPayment: true })
      ).rejects.toThrow(/402|Payment Required/i);

      // Server should not have received payment
      expect(serverState.paymentReceived).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// Test Suite: Real EVM Payer (requires credentials)
// ---------------------------------------------------------------------------

const shouldSkipRealTests = !canRunEvmTests();

describe.skipIf(shouldSkipRealTests)("Client Auto-Pay Flow (Real EVM Payer)", () => {
  let PoiClient: typeof import("@fluxpointstudios/orynq-sdk-client").PoiClient;
  let ViemPayer: typeof import("@fluxpointstudios/orynq-sdk-payer-evm-direct").ViemPayer;

  let server: Server;
  let serverState: MockServerState;
  let realPayer: InstanceType<typeof ViemPayer>;

  beforeAll(async () => {
    if (shouldSkipRealTests) {
      logSkipReason("Real EVM Payer Tests", "Missing TEST_EVM_PRIVATE_KEY");
      return;
    }

    const [clientModule, payerModule] = await Promise.all([
      import("@fluxpointstudios/orynq-sdk-client"),
      import("@fluxpointstudios/orynq-sdk-payer-evm-direct"),
    ]);

    PoiClient = clientModule.PoiClient;
    ViemPayer = payerModule.ViemPayer;

    const env = loadTestEnvironment();

    realPayer = new ViemPayer({
      privateKey: env.TEST_EVM_PRIVATE_KEY as `0x${string}`,
      chains: [BASE_SEPOLIA.chainId],
      rpcUrls: {
        [BASE_SEPOLIA.chainId]: env.BASE_SEPOLIA_RPC_URL || BASE_SEPOLIA.rpcUrl,
      },
    });

    const address = await realPayer.getAddress(BASE_SEPOLIA.chainId);
    console.log(`\n  Real payer address: ${address}`);
  });

  beforeEach(() => {
    serverState = {
      paymentReceived: false,
      paymentProof: null,
      invoiceId: `invoice-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      requestCount: 0,
    };
  });

  afterAll(() => {
    if (server) {
      server.close();
    }
  });

  it("should verify payer is properly configured", async () => {
    expect(realPayer.supportedChains).toContain(BASE_SEPOLIA.chainId);

    const balance = await realPayer.getBalance(BASE_SEPOLIA.chainId, "USDC");
    console.log(`  USDC balance: ${Number(balance) / 1e6} USDC`);
  });

  it("should integrate with real payer (balance check only)", async () => {
    // This test verifies the client can work with a real payer
    // but doesn't execute actual payments to avoid spending testnet funds

    server = createMockServer(serverState);
    await new Promise<void>((resolve) => server.listen(MOCK_SERVER_PORT, resolve));

    try {
      const client = new PoiClient({
        baseUrl: `http://localhost:${MOCK_SERVER_PORT}`,
        payer: realPayer,
        onPaymentRequired: (request) => {
          console.log(`  Would pay: ${request.amountUnits} ${request.asset}`);
          // Return false to prevent actual payment
          return false;
        },
      });

      // Attempt request - will be cancelled at payment step
      await expect(client.request("/api/test")).rejects.toThrow(/cancelled/i);

      console.log("  Integration with real payer verified (payment cancelled)");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// Test Suite: Budget Enforcement
// ---------------------------------------------------------------------------

describe("Client Budget Enforcement", () => {
  let PoiClient: typeof import("@fluxpointstudios/orynq-sdk-client").PoiClient;

  let server: Server;
  let serverState: MockServerState;

  beforeAll(async () => {
    const clientModule = await import("@fluxpointstudios/orynq-sdk-client");
    PoiClient = clientModule.PoiClient;
  });

  beforeEach(() => {
    serverState = {
      paymentReceived: false,
      paymentProof: null,
      invoiceId: `invoice-${Date.now()}`,
      requestCount: 0,
    };
  });

  afterAll(() => {
    if (server) {
      server.close();
    }
  });

  it("should enforce per-request budget limit", async () => {
    server = createMockServer(serverState);
    await new Promise<void>((resolve) => server.listen(MOCK_SERVER_PORT, resolve));

    try {
      const client = new PoiClient({
        baseUrl: `http://localhost:${MOCK_SERVER_PORT}`,
        payer: createMockPayer(),
        budget: {
          maxPerRequest: "5000", // 0.005 USDC - less than test amount
        },
      });

      // Should fail budget check
      await expect(client.request("/api/test")).rejects.toThrow(/budget|exceed/i);

      console.log("  Per-request budget limit enforced");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("should allow payment within budget", async () => {
    server = createMockServer(serverState);
    await new Promise<void>((resolve) => server.listen(MOCK_SERVER_PORT, resolve));

    try {
      const client = new PoiClient({
        baseUrl: `http://localhost:${MOCK_SERVER_PORT}`,
        payer: createMockPayer(),
        budget: {
          maxPerRequest: "100000", // 0.1 USDC - more than test amount
          maxPerDay: "1000000", // 1 USDC daily
        },
        // Use fast retry options for tests
        retryOptions: {
          maxWaitMs: 5000,
          pollIntervalMs: 500,
          maxRetries: 2,
        },
      });

      const response = await client.request<{ success: boolean }>("/api/test");

      expect(response.success).toBe(true);
      expect(serverState.paymentReceived).toBe(true);

      console.log("  Payment within budget completed");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("should track remaining budget", async () => {
    server = createMockServer(serverState);
    await new Promise<void>((resolve) => server.listen(MOCK_SERVER_PORT, resolve));

    try {
      const client = new PoiClient({
        baseUrl: `http://localhost:${MOCK_SERVER_PORT}`,
        payer: createMockPayer(),
        budget: {
          maxPerRequest: "100000",
          maxPerDay: "1000000",
        },
        // Use fast retry options for tests
        retryOptions: {
          maxWaitMs: 5000,
          pollIntervalMs: 500,
          maxRetries: 2,
        },
      });

      // Check initial budget
      const initialBudget = await client.getRemainingBudget(BASE_SEPOLIA.chainId, "USDC");
      expect(initialBudget).toBe(BigInt("1000000"));

      // Make a payment
      await client.request("/api/test");

      // Check remaining budget
      const remainingBudget = await client.getRemainingBudget(BASE_SEPOLIA.chainId, "USDC");
      expect(remainingBudget).toBe(BigInt("1000000") - BigInt(TEST_AMOUNTS.USDC_UNITS));

      console.log(`  Budget tracking: ${initialBudget} -> ${remainingBudget}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// Log information about the test suite
console.log("\n----------------------------------------");
console.log("Client Auto-Pay Integration Tests");
console.log("----------------------------------------");
console.log("These tests verify the PoiClient auto-pay flow:");
console.log("  - Mock server tests always run");
console.log("  - Real EVM payer tests require TEST_EVM_PRIVATE_KEY");
console.log("----------------------------------------\n");
