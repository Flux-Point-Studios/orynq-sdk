/**
 * @file tests/integration/x402-gateway.integration.test.ts
 * @summary End-to-end integration tests for the complete x402 payment flow.
 *
 * These tests verify:
 * - Gateway returns 402 with PAYMENT-REQUIRED header
 * - Gateway accepts valid EIP-3009 signatures
 * - Gateway calls facilitator for settlement
 * - Replay prevention (same signature cannot be used twice)
 * - Chain mismatch detection (signature chain must match invoice)
 *
 * This test creates mock servers for:
 * - Facilitator: Handles /settle endpoint for payment execution
 * - Backend: Simple mock backend that the gateway proxies to
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express, { type Express, type Request, type Response } from "express";
import type { Server } from "http";
import { X402_HEADERS, FLUX_HEADERS } from "@fluxpointstudios/orynq-sdk-core";
import { createGatewayServer, type GatewayServer } from "@fluxpointstudios/orynq-sdk-gateway";
import {
  serializeAuthorization,
  buildTypedData,
  generateNonce,
  type Eip3009Authorization,
} from "@fluxpointstudios/orynq-sdk-payer-evm-x402";
import { privateKeyToAccount } from "viem/accounts";

// ---------------------------------------------------------------------------
// Test Configuration
// ---------------------------------------------------------------------------

/** Test timeout for individual test cases */
const TEST_TIMEOUT = 30_000;

/** Test private key (DO NOT USE IN PRODUCTION - well-known test key) */
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

/** Expected test wallet address from the above private key */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/** Test payment recipient address */
const PAY_TO_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

/** USDC contract address on Base Sepolia */
const USDC_CONTRACT = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/** Test amount in USDC atomic units (0.01 USDC) */
const TEST_AMOUNT = "10000";

/** Base Sepolia chain ID (numeric) */
const BASE_SEPOLIA_CHAIN_ID = 84532;

/** Base Sepolia CAIP-2 chain identifier */
const BASE_SEPOLIA_CHAIN = "eip155:84532";

/** Default fetch timeout in ms */
const FETCH_TIMEOUT = 5_000;

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Fetch with timeout support.
 * Wraps native fetch with AbortController for timeout.
 */
async function testFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Find an available port for the test server.
 */
function getRandomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

/**
 * Start an Express server on a random port.
 */
function startServer(app: Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const port = getRandomPort();
    const server = app.listen(port, "127.0.0.1", () => {
      resolve({ server, port });
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Retry with a different port
        resolve(startServer(app));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Stop an Express server with timeout.
 */
function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    // Force close all connections after timeout
    const timeout = setTimeout(() => {
      resolve();
    }, 2000);

    server.close(() => {
      clearTimeout(timeout);
      resolve();
    });

    // Force close if server.close doesn't complete quickly
    server.closeAllConnections?.();
  });
}

/**
 * Create a mock EIP-3009 signature for testing.
 * Uses the actual signing functions from payer-evm-x402.
 */
async function createMockSignature(options: {
  payTo: string;
  amount: string;
  chainId?: number;
  validBefore?: number;
}): Promise<{ encoded: string; authorization: Eip3009Authorization }> {
  const { payTo, amount, chainId = BASE_SEPOLIA_CHAIN_ID, validBefore } = options;

  const account = privateKeyToAccount(TEST_PRIVATE_KEY);

  // Build typed data for EIP-3009
  const nonce = generateNonce();
  const now = Math.floor(Date.now() / 1000);
  const validBeforeTime = validBefore ?? now + 3600; // 1 hour from now

  const typedData = buildTypedData({
    tokenName: "USD Coin",
    version: "2",
    chainId: BigInt(chainId),
    tokenAddress: USDC_CONTRACT as `0x${string}`,
    from: account.address,
    to: payTo as `0x${string}`,
    value: BigInt(amount),
    validAfter: 0n,
    validBefore: BigInt(validBeforeTime),
    nonce,
  });

  // Sign the typed data
  const signature = await account.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  });

  // Create authorization object
  const authorization: Eip3009Authorization = {
    domain: typedData.domain,
    message: typedData.message,
    signature,
  };

  // Serialize for HTTP transport
  const serialized = serializeAuthorization(authorization);
  const encoded = Buffer.from(JSON.stringify(serialized)).toString("base64");

  return { encoded, authorization };
}

/**
 * Parse x402 payment requirements from PAYMENT-REQUIRED header.
 */
function parsePaymentRequired(header: string): {
  version: string;
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
} {
  const json = Buffer.from(header, "base64").toString("utf-8");
  return JSON.parse(json);
}

// ---------------------------------------------------------------------------
// Mock Server Factories
// ---------------------------------------------------------------------------

interface FacilitatorCallLog {
  payload: unknown;
  timestamp: number;
}

/**
 * Create a mock facilitator server.
 */
function createMockFacilitator(): {
  app: Express;
  getCalls: () => FacilitatorCallLog[];
  clearCalls: () => void;
  setResponse: (response: { success: boolean; txHash?: string; error?: string }) => void;
} {
  const app = express();
  app.use(express.json());

  const calls: FacilitatorCallLog[] = [];
  let mockResponse = { success: true, txHash: "0xmock123456789abcdef" };

  app.post("/settle", (req: Request, res: Response) => {
    calls.push({
      payload: req.body,
      timestamp: Date.now(),
    });

    if (mockResponse.success) {
      res.json({
        success: true,
        txHash: mockResponse.txHash || `0xmock${Date.now().toString(16)}`,
      });
    } else {
      res.status(400).json({
        success: false,
        error: mockResponse.error || "Settlement failed",
      });
    }
  });

  return {
    app,
    getCalls: () => [...calls],
    clearCalls: () => {
      calls.length = 0;
    },
    setResponse: (response) => {
      mockResponse = response;
    },
  };
}

/**
 * Create a mock backend server.
 */
function createMockBackend(): Express {
  const app = express();
  app.use(express.json());

  // Test endpoint that returns different responses based on verified header
  app.all("/api/test", (req: Request, res: Response) => {
    const verified = req.headers["x-paid-verified"];
    if (verified === "1") {
      res.json({
        success: true,
        message: "Payment verified, request processed",
        receivedHeaders: {
          paidVerified: verified,
        },
      });
    } else {
      res.status(402).json({
        error: "Payment required",
        message: "X-Paid-Verified header not set",
      });
    }
  });

  // Health endpoint
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "mock-backend" });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("x402 Gateway End-to-End Integration", () => {
  // Server instances
  let facilitatorServer: Server;
  let facilitatorPort: number;
  let facilitatorMock: ReturnType<typeof createMockFacilitator>;

  let backendServer: Server;
  let backendPort: number;

  let gateway: GatewayServer;
  let gatewayServer: Server;
  let gatewayPort: number;

  // Enable trust mode for testing
  const originalEnv = process.env;

  beforeAll(async () => {
    // Set environment to allow trust mode if needed
    process.env = { ...originalEnv, ALLOW_INSECURE_TRUST_MODE: "true" };

    // Start mock facilitator
    facilitatorMock = createMockFacilitator();
    const facilitatorResult = await startServer(facilitatorMock.app);
    facilitatorServer = facilitatorResult.server;
    facilitatorPort = facilitatorResult.port;
    console.log(`  Mock facilitator running on port ${facilitatorPort}`);

    // Start mock backend
    const backendApp = createMockBackend();
    const backendResult = await startServer(backendApp);
    backendServer = backendResult.server;
    backendPort = backendResult.port;
    console.log(`  Mock backend running on port ${backendPort}`);

    // Create and start gateway
    gateway = createGatewayServer({
      backendUrl: `http://127.0.0.1:${backendPort}`,
      payTo: PAY_TO_ADDRESS,
      chains: [BASE_SEPOLIA_CHAIN],
      pricing: async () => ({
        chain: BASE_SEPOLIA_CHAIN,
        asset: "USDC",
        amountUnits: TEST_AMOUNT,
      }),
      x402: {
        mode: "strict",
        facilitatorUrl: `http://127.0.0.1:${facilitatorPort}`,
        timeout: 5000,
      },
      debug: false,
    });

    const gatewayResult = await startServer(gateway.app);
    gatewayServer = gatewayResult.server;
    gatewayPort = gatewayResult.port;
    console.log(`  Gateway running on port ${gatewayPort}`);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    // Restore environment
    process.env = originalEnv;

    // Stop all servers - do in parallel for speed
    await Promise.all([
      gatewayServer ? stopServer(gatewayServer) : Promise.resolve(),
      backendServer ? stopServer(backendServer) : Promise.resolve(),
      facilitatorServer ? stopServer(facilitatorServer) : Promise.resolve(),
    ]);
  }, 60_000);

  beforeEach(() => {
    // Clear facilitator call log before each test
    facilitatorMock.clearCalls();
    facilitatorMock.setResponse({ success: true, txHash: "0xmock123456789abcdef" });
  });

  // ---------------------------------------------------------------------------
  // Test Case: Complete x402 Flow
  // ---------------------------------------------------------------------------

  describe("Complete x402 Flow", () => {
    let invoiceId: string;
    let paymentRequirements: ReturnType<typeof parsePaymentRequired>;

    it("should return 402 with PAYMENT-REQUIRED header on initial request", async () => {
      const response = await testFetch(`http://127.0.0.1:${gatewayPort}/api/test`, {
        method: "GET",
      });

      expect(response.status).toBe(402);

      // Check for PAYMENT-REQUIRED header
      const paymentRequiredHeader = response.headers.get(X402_HEADERS.PAYMENT_REQUIRED);
      expect(paymentRequiredHeader).toBeDefined();
      expect(paymentRequiredHeader).not.toBeNull();

      // Parse payment requirements
      paymentRequirements = parsePaymentRequired(paymentRequiredHeader!);
      expect(paymentRequirements.version).toBe("1");
      expect(paymentRequirements.network).toBe(BASE_SEPOLIA_CHAIN);
      expect(paymentRequirements.maxAmountRequired).toBe(TEST_AMOUNT);
      expect(paymentRequirements.payTo).toBe(PAY_TO_ADDRESS);
      expect(paymentRequirements.asset).toBe("USDC");
      expect(paymentRequirements.maxTimeoutSeconds).toBeGreaterThan(0);

      // Get invoice ID from response body
      const body = await response.json();
      expect(body.invoiceId).toBeDefined();
      invoiceId = body.invoiceId;
      expect(body.protocol).toBe("x402");
    });

    it("should accept valid payment signature and forward to backend", async () => {
      // Create a valid signature matching the invoice requirements
      const { encoded } = await createMockSignature({
        payTo: PAY_TO_ADDRESS,
        amount: TEST_AMOUNT,
        chainId: BASE_SEPOLIA_CHAIN_ID,
      });

      // Retry request with payment signature
      const response = await testFetch(`http://127.0.0.1:${gatewayPort}/api/test`, {
        method: "GET",
        headers: {
          [X402_HEADERS.PAYMENT_SIGNATURE]: encoded,
          [FLUX_HEADERS.INVOICE_ID]: invoiceId,
        },
      });

      // Should get 200 OK (or backend response)
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.message).toContain("Payment verified");

      // Verify facilitator was called
      const calls = facilitatorMock.getCalls();
      expect(calls.length).toBe(1);
      expect(calls[0].payload).toBeDefined();

      // Verify call payload structure
      const callPayload = calls[0].payload as Record<string, unknown>;
      expect(callPayload.signature).toBeDefined();
      expect(callPayload.payload).toBeDefined();
      expect(callPayload.chainId).toBe(BASE_SEPOLIA_CHAIN_ID);
    });
  });

  // ---------------------------------------------------------------------------
  // Test Case: Replay Prevention
  // ---------------------------------------------------------------------------

  describe("Replay Prevention", () => {
    let firstInvoiceId: string;
    let paymentSignature: string;

    it("should accept first use of signature", async () => {
      // Get initial 402 to create invoice with unique idempotency key
      const idempotencyKey = `replay-prevention-${Date.now()}`;
      const initialResponse = await testFetch(`http://127.0.0.1:${gatewayPort}/api/test`, {
        method: "GET",
        headers: {
          "X-Idempotency-Key": idempotencyKey,
        },
      });

      expect(initialResponse.status).toBe(402);
      const initialBody = await initialResponse.json();
      firstInvoiceId = initialBody.invoiceId;

      // Create signature
      const { encoded } = await createMockSignature({
        payTo: PAY_TO_ADDRESS,
        amount: TEST_AMOUNT,
        chainId: BASE_SEPOLIA_CHAIN_ID,
      });
      paymentSignature = encoded;

      // First use should succeed
      const response = await testFetch(`http://127.0.0.1:${gatewayPort}/api/test`, {
        method: "GET",
        headers: {
          [X402_HEADERS.PAYMENT_SIGNATURE]: paymentSignature,
          [FLUX_HEADERS.INVOICE_ID]: firstInvoiceId,
          "X-Idempotency-Key": idempotencyKey,
        },
      });

      expect(response.status).toBe(200);
    });

    it("should reject replay of same signature", async () => {
      // Try to use the same signature again with the same invoice
      const response = await testFetch(`http://127.0.0.1:${gatewayPort}/api/test`, {
        method: "GET",
        headers: {
          [X402_HEADERS.PAYMENT_SIGNATURE]: paymentSignature,
          [FLUX_HEADERS.INVOICE_ID]: firstInvoiceId,
        },
      });

      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain("already used");
    });
  });

  // ---------------------------------------------------------------------------
  // Test Case: Chain Mismatch Detection
  // ---------------------------------------------------------------------------

  describe("Chain Mismatch Detection", () => {
    it("should reject signature with wrong chain ID", async () => {
      // Get 402 for Base Sepolia
      const initialResponse = await testFetch(`http://127.0.0.1:${gatewayPort}/api/test`, {
        method: "GET",
        headers: {
          "X-Idempotency-Key": `chain-mismatch-${Date.now()}`,
        },
      });

      expect(initialResponse.status).toBe(402);
      const body = await initialResponse.json();
      const invoiceId = body.invoiceId;

      // Create signature with Ethereum mainnet chain ID (1) instead of Base Sepolia (84532)
      const { encoded } = await createMockSignature({
        payTo: PAY_TO_ADDRESS,
        amount: TEST_AMOUNT,
        chainId: 1, // Mainnet instead of Base Sepolia
      });

      // Submit with wrong chain signature
      const response = await testFetch(`http://127.0.0.1:${gatewayPort}/api/test`, {
        method: "GET",
        headers: {
          [X402_HEADERS.PAYMENT_SIGNATURE]: encoded,
          [FLUX_HEADERS.INVOICE_ID]: invoiceId,
          "X-Idempotency-Key": `chain-mismatch-${Date.now()}`,
        },
      });

      // Should fail settlement due to chain mismatch at facilitator level
      // or return 402 if signature verification fails pre-settlement
      expect([400, 402, 502]).toContain(response.status);
    });
  });

  // ---------------------------------------------------------------------------
  // Test Case: Amount Mismatch Detection
  // ---------------------------------------------------------------------------

  describe("Amount Mismatch Detection", () => {
    it("should reject signature with wrong amount", async () => {
      // Get 402 to create invoice
      const idempotencyKey = `amount-mismatch-${Date.now()}`;
      const initialResponse = await testFetch(`http://127.0.0.1:${gatewayPort}/api/test`, {
        method: "GET",
        headers: {
          "X-Idempotency-Key": idempotencyKey,
        },
      });

      expect(initialResponse.status).toBe(402);
      const body = await initialResponse.json();
      const invoiceId = body.invoiceId;

      // Create signature with different amount
      const { encoded } = await createMockSignature({
        payTo: PAY_TO_ADDRESS,
        amount: "5000", // Half the required amount
        chainId: BASE_SEPOLIA_CHAIN_ID,
      });

      // Submit with wrong amount
      const response = await testFetch(`http://127.0.0.1:${gatewayPort}/api/test`, {
        method: "GET",
        headers: {
          [X402_HEADERS.PAYMENT_SIGNATURE]: encoded,
          [FLUX_HEADERS.INVOICE_ID]: invoiceId,
          "X-Idempotency-Key": idempotencyKey,
        },
      });

      // Should be rejected due to amount mismatch
      // Gateway pre-validates amount before calling facilitator
      expect([400, 402]).toContain(response.status);

      const responseBody = await response.json();
      expect(responseBody.error).toBeDefined();
      expect(
        responseBody.error.toLowerCase().includes("mismatch") ||
        responseBody.message?.toLowerCase().includes("mismatch") ||
        responseBody.error.toLowerCase().includes("amount")
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Test Case: Recipient Mismatch Detection
  // ---------------------------------------------------------------------------

  describe("Recipient Mismatch Detection", () => {
    it("should reject signature with wrong recipient", async () => {
      // Get 402 to create invoice
      const idempotencyKey = `recipient-mismatch-${Date.now()}`;
      const initialResponse = await testFetch(`http://127.0.0.1:${gatewayPort}/api/test`, {
        method: "GET",
        headers: {
          "X-Idempotency-Key": idempotencyKey,
        },
      });

      expect(initialResponse.status).toBe(402);
      const body = await initialResponse.json();
      const invoiceId = body.invoiceId;

      // Create signature with different recipient
      const wrongRecipient = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
      const { encoded } = await createMockSignature({
        payTo: wrongRecipient, // Wrong recipient
        amount: TEST_AMOUNT,
        chainId: BASE_SEPOLIA_CHAIN_ID,
      });

      // Submit with wrong recipient
      const response = await testFetch(`http://127.0.0.1:${gatewayPort}/api/test`, {
        method: "GET",
        headers: {
          [X402_HEADERS.PAYMENT_SIGNATURE]: encoded,
          [FLUX_HEADERS.INVOICE_ID]: invoiceId,
          "X-Idempotency-Key": idempotencyKey,
        },
      });

      // Should be rejected due to recipient mismatch
      expect([400, 402]).toContain(response.status);

      const responseBody = await response.json();
      expect(responseBody.error).toBeDefined();
      expect(
        responseBody.error.toLowerCase().includes("mismatch") ||
        responseBody.message?.toLowerCase().includes("mismatch") ||
        responseBody.error.toLowerCase().includes("recipient")
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Test Case: Facilitator Error Handling
  // ---------------------------------------------------------------------------

  describe("Facilitator Error Handling", () => {
    it("should handle facilitator settlement failure gracefully", async () => {
      // Configure facilitator to fail
      facilitatorMock.setResponse({
        success: false,
        error: "Insufficient balance for settlement",
      });

      // Get 402 to create invoice
      const idempotencyKey = `facilitator-error-${Date.now()}`;
      const initialResponse = await testFetch(`http://127.0.0.1:${gatewayPort}/api/test`, {
        method: "GET",
        headers: {
          "X-Idempotency-Key": idempotencyKey,
        },
      });

      expect(initialResponse.status).toBe(402);
      const body = await initialResponse.json();
      const invoiceId = body.invoiceId;

      // Create valid signature
      const { encoded } = await createMockSignature({
        payTo: PAY_TO_ADDRESS,
        amount: TEST_AMOUNT,
        chainId: BASE_SEPOLIA_CHAIN_ID,
      });

      // Submit payment
      const response = await testFetch(`http://127.0.0.1:${gatewayPort}/api/test`, {
        method: "GET",
        headers: {
          [X402_HEADERS.PAYMENT_SIGNATURE]: encoded,
          [FLUX_HEADERS.INVOICE_ID]: invoiceId,
          "X-Idempotency-Key": idempotencyKey,
        },
      });

      // Should return appropriate error status
      expect([402, 502]).toContain(response.status);

      const responseBody = await response.json();
      expect(responseBody.error).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Test Case: Idempotency Key Handling
  // ---------------------------------------------------------------------------

  describe("Idempotency Key Handling", () => {
    it("should return same invoice for same idempotency key", async () => {
      const idempotencyKey = `idem-test-${Date.now()}`;

      // First request
      const response1 = await testFetch(`http://127.0.0.1:${gatewayPort}/api/test`, {
        method: "GET",
        headers: {
          "X-Idempotency-Key": idempotencyKey,
        },
      });

      expect(response1.status).toBe(402);
      const body1 = await response1.json();
      const invoiceId1 = body1.invoiceId;

      // Second request with same key
      const response2 = await testFetch(`http://127.0.0.1:${gatewayPort}/api/test`, {
        method: "GET",
        headers: {
          "X-Idempotency-Key": idempotencyKey,
        },
      });

      expect(response2.status).toBe(402);
      const body2 = await response2.json();
      const invoiceId2 = body2.invoiceId;

      // Should get same invoice ID
      expect(invoiceId1).toBe(invoiceId2);
    });

    it("should return different invoices for different idempotency keys", async () => {
      const key1 = `idem-different-1-${Date.now()}`;
      const key2 = `idem-different-2-${Date.now()}`;

      // First request
      const response1 = await testFetch(`http://127.0.0.1:${gatewayPort}/api/test`, {
        method: "GET",
        headers: {
          "X-Idempotency-Key": key1,
        },
      });

      expect(response1.status).toBe(402);
      const body1 = await response1.json();

      // Second request with different key
      const response2 = await testFetch(`http://127.0.0.1:${gatewayPort}/api/test`, {
        method: "GET",
        headers: {
          "X-Idempotency-Key": key2,
        },
      });

      expect(response2.status).toBe(402);
      const body2 = await response2.json();

      // Should get different invoice IDs
      expect(body1.invoiceId).not.toBe(body2.invoiceId);
    });
  });

  // ---------------------------------------------------------------------------
  // Test Case: Expired Signature Detection
  // ---------------------------------------------------------------------------

  describe("Expired Signature Detection", () => {
    it("should reject expired signatures", async () => {
      // Get 402 to create invoice
      const idempotencyKey = `expired-sig-${Date.now()}`;
      const initialResponse = await testFetch(`http://127.0.0.1:${gatewayPort}/api/test`, {
        method: "GET",
        headers: {
          "X-Idempotency-Key": idempotencyKey,
        },
      });

      expect(initialResponse.status).toBe(402);
      const body = await initialResponse.json();
      const invoiceId = body.invoiceId;

      // Create signature with validBefore in the past
      const pastTime = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      const { encoded } = await createMockSignature({
        payTo: PAY_TO_ADDRESS,
        amount: TEST_AMOUNT,
        chainId: BASE_SEPOLIA_CHAIN_ID,
        validBefore: pastTime,
      });

      // Submit expired signature
      const response = await testFetch(`http://127.0.0.1:${gatewayPort}/api/test`, {
        method: "GET",
        headers: {
          [X402_HEADERS.PAYMENT_SIGNATURE]: encoded,
          [FLUX_HEADERS.INVOICE_ID]: invoiceId,
          "X-Idempotency-Key": idempotencyKey,
        },
      });

      // Should be rejected due to expiration
      expect([400, 402]).toContain(response.status);

      const responseBody = await response.json();
      expect(responseBody.error).toBeDefined();
      expect(
        responseBody.error.toLowerCase().includes("expired") ||
        responseBody.message?.toLowerCase().includes("expired") ||
        responseBody.error.toLowerCase().includes("mismatch")
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Test Case: Health Endpoint
  // ---------------------------------------------------------------------------

  describe("Gateway Health Check", () => {
    it("should return healthy status without payment", async () => {
      const response = await testFetch(`http://127.0.0.1:${gatewayPort}/health`);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe("ok");
      expect(body.gateway).toBe("x402");
    });
  });

  // ---------------------------------------------------------------------------
  // Test Case: Missing Invoice Detection
  // ---------------------------------------------------------------------------

  describe("Missing Invoice Detection", () => {
    it("should reject signature without prior 402 response", async () => {
      // Create a signature directly without getting a 402 first
      const { encoded } = await createMockSignature({
        payTo: PAY_TO_ADDRESS,
        amount: TEST_AMOUNT,
        chainId: BASE_SEPOLIA_CHAIN_ID,
      });

      // Try to submit payment without an invoice
      const response = await testFetch(`http://127.0.0.1:${gatewayPort}/api/test`, {
        method: "GET",
        headers: {
          [X402_HEADERS.PAYMENT_SIGNATURE]: encoded,
          [FLUX_HEADERS.INVOICE_ID]: "nonexistent-invoice-id",
        },
      });

      // Should be rejected due to no matching invoice
      expect([400, 402]).toContain(response.status);

      const body = await response.json();
      expect(body.error).toBeDefined();
    });
  });
});
