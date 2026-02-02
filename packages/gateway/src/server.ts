/**
 * @summary Express server implementation for the x402 gateway.
 *
 * This file creates an Express application that acts as an x402 gateway,
 * intercepting requests, checking for payment, and forwarding verified
 * requests to the backend. It supports both x402 and Flux payment protocols.
 *
 * Architecture:
 * ```
 * Browser/Client
 *      |
 *      v (x402 protocol)
 * +------------------+
 * |  x402 Gateway    |  <-- This server
 * |  (Node/Express)  |
 * +--------+---------+
 *          | (internal: X-Paid-Verified: 1)
 *          v
 * +------------------+
 * |   T-Backend      |  <-- Existing backend (unchanged)
 * +------------------+
 * ```
 *
 * Used by:
 * - index.ts for the main entry point
 * - cli.ts for command-line operation
 */

import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { X402_HEADERS, FLUX_HEADERS } from "@fluxpointstudios/orynq-sdk-core";
import { MemoryInvoiceStore, cors402 } from "@fluxpointstudios/orynq-sdk-server-middleware";
import type { GatewayConfig } from "./config.js";
import { mergeConfig, validateConfig } from "./config.js";
import { createForwardMiddleware, type GatewayRequest } from "./forward.js";
import { generateInvoiceId, generateInvoiceIdSync } from "./invoice-bridge.js";
import { MemoryX402SettlementStore, type X402SettlementStore } from "./x402-settlement-store.js";
import {
  settleX402Payment,
  validateTrustMode,
  PaymentMismatchError,
  SettlementError,
  TrustModeError,
} from "./x402-settler.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Gateway server instance with additional metadata.
 */
export interface GatewayServer {
  /**
   * Express application instance.
   */
  app: Express;

  /**
   * Invoice store used by the gateway (Flux protocol).
   */
  invoiceStore: MemoryInvoiceStore;

  /**
   * x402 settlement store for tracking payment state.
   */
  x402SettlementStore: X402SettlementStore;
}

// ---------------------------------------------------------------------------
// Server Factory
// ---------------------------------------------------------------------------

/**
 * Create an x402 gateway Express server.
 *
 * The server handles:
 * - CORS configuration for x402 headers
 * - Health check endpoint
 * - Payment verification for protected routes
 * - x402 402 response generation
 * - Request forwarding to backend
 *
 * @param config - Gateway configuration
 * @returns Express application configured as x402 gateway
 *
 * @example
 * ```typescript
 * const config: GatewayConfig = {
 *   backendUrl: "http://localhost:8000",
 *   payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f9fEDb",
 *   chains: ["eip155:8453"],
 *   pricing: async (req) => ({
 *     chain: "eip155:8453",
 *     asset: "USDC",
 *     amountUnits: "1000000",
 *   }),
 * };
 *
 * const { app } = createGatewayServer(config);
 * app.listen(3402, () => console.log("Gateway running"));
 * ```
 */
export function createGatewayServer(config: GatewayConfig): GatewayServer {
  // Validate configuration
  validateConfig(config);
  const mergedConfig = mergeConfig(config);

  // Validate trust mode safety (throws if trust mode is used incorrectly)
  if (mergedConfig.x402?.mode) {
    validateTrustMode(mergedConfig.x402.mode);
  }

  const app = express();
  const debug = mergedConfig.debug;

  // ---------------------------------------------------------------------------
  // CORS Configuration
  // ---------------------------------------------------------------------------

  const corsConfig = cors402();
  const corsOptions: cors.CorsOptions = {
    origin: mergedConfig.corsOrigins.length > 0 ? mergedConfig.corsOrigins : "*",
    exposedHeaders: corsConfig.exposedHeaders,
    allowedHeaders: [
      ...corsConfig.allowedHeaders,
      "X-Idempotency-Key",
      "X-Wallet-Address",
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    credentials: true,
  };

  app.use(cors(corsOptions));

  // ---------------------------------------------------------------------------
  // Body Parsing
  // ---------------------------------------------------------------------------

  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  // ---------------------------------------------------------------------------
  // Health Check
  // ---------------------------------------------------------------------------

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      gateway: "x402",
      version: "0.0.0",
      timestamp: new Date().toISOString(),
    });
  });

  // ---------------------------------------------------------------------------
  // Invoice Storage
  // ---------------------------------------------------------------------------

  const invoiceStore = new MemoryInvoiceStore();

  // ---------------------------------------------------------------------------
  // x402 Settlement Storage
  // ---------------------------------------------------------------------------

  const x402SettlementStore: X402SettlementStore = new MemoryX402SettlementStore();

  // ---------------------------------------------------------------------------
  // Forward Middleware
  // ---------------------------------------------------------------------------

  const forwardMiddleware = createForwardMiddleware(
    mergedConfig,
    debug
      ? {
          onBeforeForward: (_req, invoiceId) => {
            console.log(`[Gateway] Forwarding request ${invoiceId} to backend`);
          },
        }
      : undefined
  );

  // ---------------------------------------------------------------------------
  // Payment Gate Middleware
  // ---------------------------------------------------------------------------

  /**
   * Middleware that checks for payment and gates access to the API.
   */
  const paymentGateMiddleware = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const gatewayReq = req as GatewayRequest;

      // Check for x402 payment signature
      const x402Signature = req.headers[X402_HEADERS.PAYMENT_SIGNATURE.toLowerCase()];

      if (x402Signature) {
        // x402 payment provided - MUST verify and settle before granting access
        const idempotencyKey = req.headers["x-idempotency-key"] as string | undefined;
        const invoiceId = req.headers[FLUX_HEADERS.INVOICE_ID.toLowerCase()] as string | undefined;

        if (debug) {
          console.log("[Gateway] x402 payment signature received, verifying...");
        }

        // Find the invoice to settle against
        let storedInvoice = null;

        // First try by invoice ID
        if (invoiceId) {
          storedInvoice = await x402SettlementStore.get(invoiceId);
        }

        // Fall back to idempotency key
        if (!storedInvoice && idempotencyKey) {
          storedInvoice = await x402SettlementStore.findByIdempotencyKey(idempotencyKey);
        }

        // Fall back to request hash
        if (!storedInvoice) {
          const requestHash = generateInvoiceIdSync(req.method, req.originalUrl, idempotencyKey);
          storedInvoice = await x402SettlementStore.findByRequestHash(requestHash);
        }

        if (!storedInvoice) {
          // No invoice found - client must first receive a 402 to get an invoice
          if (debug) {
            console.log("[Gateway] No invoice found for x402 payment");
          }
          res.status(400).json({
            error: "No invoice found",
            message: "Request a resource first to receive an invoice before submitting payment",
          });
          return;
        }

        // Check if invoice was already consumed (replay protection)
        if (storedInvoice.status === "consumed") {
          if (debug) {
            console.log(`[Gateway] Invoice ${storedInvoice.invoiceId} already consumed (replay attempt)`);
          }
          res.status(400).json({
            error: "Payment already used",
            message: "This payment signature has already been used. Request a new invoice.",
            invoiceId: storedInvoice.invoiceId,
          });
          return;
        }

        // Check if invoice expired
        if (storedInvoice.status === "expired") {
          if (debug) {
            console.log(`[Gateway] Invoice ${storedInvoice.invoiceId} expired`);
          }
          res.status(400).json({
            error: "Invoice expired",
            message: "This invoice has expired. Request a new one.",
            invoiceId: storedInvoice.invoiceId,
          });
          return;
        }

        // Settle the payment
        try {
          const settlementResult = await settleX402Payment(
            x402Signature as string,
            storedInvoice,
            mergedConfig.x402
          );

          if (!settlementResult.success) {
            if (debug) {
              console.log(`[Gateway] Settlement failed: ${settlementResult.error}`);
            }
            res.status(402).json({
              error: "Payment settlement failed",
              message: settlementResult.error,
              details: settlementResult.details,
            });
            return;
          }

          // Mark invoice as settled and consumed
          await x402SettlementStore.markSettled(storedInvoice.invoiceId, settlementResult.txHash!);
          await x402SettlementStore.markConsumed(storedInvoice.invoiceId);

          if (debug) {
            console.log(`[Gateway] x402 payment settled: ${settlementResult.txHash}`);
          }

          // Payment verified - allow request through
          gatewayReq.paymentVerified = true;
          if (settlementResult.txHash) {
            gatewayReq.paymentTxHash = settlementResult.txHash;
          }
          gatewayReq.gatewayInvoiceId = storedInvoice.invoiceId;
          return next();

        } catch (error) {
          if (error instanceof PaymentMismatchError) {
            if (debug) {
              console.log(`[Gateway] Payment mismatch: ${error.message}`);
            }
            res.status(400).json({
              error: "Payment mismatch",
              message: error.message,
              details: error.details,
            });
            return;
          }

          if (error instanceof SettlementError) {
            if (debug) {
              console.log(`[Gateway] Settlement error: ${error.message}`);
            }
            res.status(502).json({
              error: "Settlement service error",
              message: error.message,
              details: error.details,
            });
            return;
          }

          if (error instanceof TrustModeError) {
            // This should have been caught at startup, but just in case
            console.error(`[Gateway] CRITICAL: ${error.message}`);
            res.status(500).json({
              error: "Gateway configuration error",
              message: "Trust mode is not properly configured",
            });
            return;
          }

          throw error;
        }
      }

      // Check for Flux payment (legacy/fallback)
      const fluxInvoiceId = req.headers[FLUX_HEADERS.INVOICE_ID.toLowerCase()];
      const fluxPayment = req.headers[FLUX_HEADERS.PAYMENT.toLowerCase()];

      if (fluxInvoiceId && fluxPayment) {
        // Flux payment - verify against invoice store
        const invoice = await invoiceStore.get(fluxInvoiceId as string);

        if (invoice && (invoice.status === "confirmed" || invoice.status === "consumed")) {
          if (debug) {
            console.log(`[Gateway] Flux payment verified for invoice ${fluxInvoiceId}`);
          }
          gatewayReq.paymentVerified = true;
          gatewayReq.gatewayInvoiceId = invoice.id;
          return next();
        }

        // Payment provided but not verified - return 402
        if (debug) {
          console.log(`[Gateway] Flux payment not verified for invoice ${fluxInvoiceId}`);
        }
      }

      // No valid payment - return 402 with payment requirements
      await emit402Response(req, res, mergedConfig, invoiceStore, x402SettlementStore);
    } catch (error) {
      next(error);
    }
  };

  // ---------------------------------------------------------------------------
  // API Routes with Payment Gate
  // ---------------------------------------------------------------------------

  // Apply payment gate to all /api/* routes
  app.use("/api/*", paymentGateMiddleware, forwardMiddleware);

  // ---------------------------------------------------------------------------
  // Catch-all for Non-API Routes
  // ---------------------------------------------------------------------------

  // Forward non-API routes directly (no payment required)
  // This allows static assets, health checks, etc. to pass through
  app.use((req: Request, res: Response, next: NextFunction) => {
    // If it's not an API route and not handled, forward to backend
    if (!req.path.startsWith("/api/") && req.path !== "/health") {
      return forwardMiddleware(req, res, next);
    }
    next();
  });

  // ---------------------------------------------------------------------------
  // Error Handler
  // ---------------------------------------------------------------------------

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[Gateway] Error:", err.message);

    if (debug) {
      console.error(err.stack);
    }

    res.status(500).json({
      error: "Internal gateway error",
      message: err.message,
    });
  });

  return { app, invoiceStore, x402SettlementStore };
}

// ---------------------------------------------------------------------------
// 402 Response Emission
// ---------------------------------------------------------------------------

/**
 * Emit a 402 Payment Required response with x402 format.
 */
async function emit402Response(
  req: Request,
  res: Response,
  config: Required<GatewayConfig>,
  invoiceStore: MemoryInvoiceStore,
  x402SettlementStore: X402SettlementStore
): Promise<void> {
  const idempotencyKey = req.headers["x-idempotency-key"] as string | undefined;

  // Check for existing invoice with this idempotency key
  if (idempotencyKey) {
    const existingInvoice = await invoiceStore.findByIdempotencyKey(idempotencyKey);
    if (existingInvoice && existingInvoice.status === "pending") {
      // Return existing invoice
      emitX402Headers(res, existingInvoice, req.originalUrl, config);
      return;
    }
  }

  // Get pricing for this request
  const priceConfig = await config.pricing(req);

  // Generate invoice ID
  const generatedInvoiceId = await generateInvoiceId(
    req.method,
    req.originalUrl,
    idempotencyKey
  );

  // Create invoice params
  const invoiceParams: Parameters<typeof invoiceStore.create>[0] = {
    chain: priceConfig.chain,
    asset: priceConfig.asset,
    amountUnits: priceConfig.amountUnits,
    payTo: config.payTo,
    expiresInSeconds: config.invoiceExpiresInSeconds,
    metadata: {
      generatedId: generatedInvoiceId,
      method: req.method,
      path: req.originalUrl,
    },
  };

  // Only add idempotencyKey if it's defined
  if (idempotencyKey !== undefined) {
    invoiceParams.idempotencyKey = idempotencyKey;
  }

  // Create invoice in Flux store
  const invoice = await invoiceStore.create(invoiceParams);

  // Also create in x402 settlement store for payment verification
  // Generate a request hash that binds this invoice to the specific request
  const requestHash = generateInvoiceIdSync(req.method, req.originalUrl, idempotencyKey);

  const x402InvoiceParams: Parameters<typeof x402SettlementStore.create>[0] = {
    invoiceId: invoice.id,
    requestHash,
    requirements: {
      amount: priceConfig.amountUnits,
      payTo: config.payTo,
      asset: priceConfig.asset,
      chain: priceConfig.chain,
      timeout: config.invoiceExpiresInSeconds,
    },
    resource: req.originalUrl,
  };

  // Only add idempotencyKey if it's defined
  if (idempotencyKey !== undefined) {
    x402InvoiceParams.idempotencyKey = idempotencyKey;
  }

  await x402SettlementStore.create(x402InvoiceParams);

  emitX402Headers(res, invoice, req.originalUrl, config);
}

/**
 * Set x402 headers and send 402 response.
 */
function emitX402Headers(
  res: Response,
  invoice: { id: string; chain: string; amountUnits: string; payTo: string; asset: string; expiresAt?: string },
  resource: string,
  config: Required<GatewayConfig>
): void {
  // Calculate timeout
  let maxTimeoutSeconds = config.invoiceExpiresInSeconds;
  if (invoice.expiresAt) {
    maxTimeoutSeconds = Math.max(
      0,
      Math.floor((new Date(invoice.expiresAt).getTime() - Date.now()) / 1000)
    );
  }

  // Build x402 payload
  const payload = {
    version: "1",
    scheme: "exact",
    network: invoice.chain,
    maxAmountRequired: invoice.amountUnits,
    resource,
    payTo: invoice.payTo,
    maxTimeoutSeconds,
    asset: invoice.asset,
  };

  // Encode payload as base64
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");

  // Set response
  res.status(402);
  res.setHeader(X402_HEADERS.PAYMENT_REQUIRED, encoded);
  res.setHeader("Content-Type", "application/json");
  res.json({
    error: "Payment Required",
    invoiceId: invoice.id,
    protocol: "x402",
  });
}

// ---------------------------------------------------------------------------
// Server Startup
// ---------------------------------------------------------------------------

/**
 * Start the gateway server.
 *
 * Creates the Express application and starts listening on the configured
 * port and host.
 *
 * @param config - Gateway configuration
 * @returns Promise that resolves when server is listening
 *
 * @example
 * ```typescript
 * await startGateway({
 *   backendUrl: "http://localhost:8000",
 *   payTo: "0x...",
 *   chains: ["eip155:8453"],
 *   pricing: async () => ({ chain: "eip155:8453", asset: "USDC", amountUnits: "1000000" }),
 * });
 * // Gateway is now running
 * ```
 */
export function startGateway(config: GatewayConfig): Promise<GatewayServer> {
  return new Promise((resolve, reject) => {
    try {
      const merged = mergeConfig(config);
      const { app, invoiceStore, x402SettlementStore } = createGatewayServer(config);
      const port = merged.port;
      const host = merged.host;

      const server = app.listen(port, host, () => {
        console.log(`[Gateway] x402 Gateway running at http://${host}:${port}`);
        console.log(`[Gateway] Proxying to: ${merged.backendUrl}`);
        console.log(`[Gateway] Supported chains: ${merged.chains.join(", ")}`);
        console.log(`[Gateway] Pay to: ${merged.payTo}`);
        console.log(`[Gateway] x402 mode: ${merged.x402.mode}`);
        resolve({ app, invoiceStore, x402SettlementStore });
      });

      server.on("error", (err) => {
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}
