/**
 * @summary Express middleware factory for payment-required endpoints.
 *
 * This file provides Express middleware that implements HTTP 402 Payment Required
 * handling with support for both Flux and x402 protocols. The middleware:
 * - Intercepts requests to protected endpoints
 * - Checks for valid payment proofs in headers
 * - Verifies payments on-chain using configured verifiers
 * - Returns 402 responses when payment is required
 * - Handles idempotency for request deduplication
 *
 * Used by:
 * - Express applications requiring payment for API access
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import {
  FLUX_HEADERS,
  X402_HEADERS,
  type ChainId,
  type PaymentProof,
} from "@fluxpointstudios/poi-sdk-core";
import type { InvoiceStore, Invoice, CreateInvoiceParams } from "./invoice-store.js";
import type { ChainVerifier } from "./verifiers/interface.js";
import { findVerifier } from "./verifiers/interface.js";
import { createFlux402Response, type FluxSplit } from "./protocols/emit-flux.js";
import { createX402_402Response } from "./protocols/emit-x402.js";
import { processIdempotency, type IdempotencyConfig } from "./idempotency.js";
import { hashRequest } from "./request-hash.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Price configuration for a payment request.
 */
export interface PriceConfig {
  /**
   * CAIP-2 chain identifier for the payment.
   */
  chain: ChainId;

  /**
   * Asset identifier.
   * @example "ADA", "USDC", "ETH"
   */
  asset: string;

  /**
   * Amount in atomic units as STRING.
   */
  amountUnits: string;

  /**
   * Number of decimal places for display.
   */
  decimals?: number;
}

/**
 * Split payment configuration.
 */
export interface SplitConfig {
  /**
   * Split mode.
   * - "inclusive": splits are subtracted from amountUnits
   * - "additional": splits are added to amountUnits
   */
  mode: "inclusive" | "additional";

  /**
   * Split outputs.
   */
  outputs: Array<{
    to: string;
    amountUnits: string;
    role?: string;
  }>;
}

/**
 * Options for the requirePayment middleware.
 */
export interface RequirePaymentOptions {
  /**
   * Protocols to support.
   * @default ["flux", "x402"]
   */
  protocols?: Array<"flux" | "x402">;

  /**
   * Function to determine preferred protocol for a request.
   * Return "auto" to use the first supported protocol.
   */
  prefer?: (req: Request) => "flux" | "x402" | "auto";

  /**
   * Function to compute price for a request.
   * Can be async for dynamic pricing.
   */
  price: (req: Request) => PriceConfig | Promise<PriceConfig>;

  /**
   * Recipient address or function to compute it.
   */
  payTo: string | ((req: Request) => string);

  /**
   * Function to compute split configuration for a request.
   * Return undefined for no splits.
   */
  splits?: (req: Request) => SplitConfig | undefined;

  /**
   * Invoice storage implementation.
   */
  storage: InvoiceStore;

  /**
   * Chain verifiers for payment proof verification.
   */
  verifiers: ChainVerifier[];

  /**
   * Idempotency configuration.
   */
  idempotency?: IdempotencyConfig;

  /**
   * Invoice expiration time in seconds.
   * @default 300 (5 minutes)
   */
  expiresInSeconds?: number;

  /**
   * Callback when payment is verified.
   */
  onPaymentVerified?: (
    req: Request,
    invoice: Invoice,
    proof: PaymentProof
  ) => void | Promise<void>;

  /**
   * Callback when payment verification fails.
   */
  onPaymentFailed?: (
    req: Request,
    invoice: Invoice | null,
    error: string
  ) => void | Promise<void>;

  /**
   * Additional metadata to store with invoices.
   */
  metadata?: (req: Request) => Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Middleware Factory
// ---------------------------------------------------------------------------

/**
 * Create Express middleware that requires payment for protected endpoints.
 *
 * The middleware checks for payment proofs in request headers and verifies
 * them on-chain. If no valid payment is found, it returns a 402 response
 * with payment requirements in the configured protocol format.
 *
 * @param options - Middleware configuration
 * @returns Express middleware function
 *
 * @example
 * ```typescript
 * import express from "express";
 * import { requirePayment, MemoryInvoiceStore, CardanoVerifier } from "@fluxpointstudios/poi-sdk-server-middleware";
 *
 * const app = express();
 * const store = new MemoryInvoiceStore();
 * const verifier = new CardanoVerifier({ blockfrostProjectId: "..." });
 *
 * app.get(
 *   "/api/protected",
 *   requirePayment({
 *     price: () => ({
 *       chain: "cardano:mainnet",
 *       asset: "ADA",
 *       amountUnits: "1000000", // 1 ADA
 *     }),
 *     payTo: "addr1...",
 *     storage: store,
 *     verifiers: [verifier],
 *   }),
 *   (req, res) => {
 *     res.json({ message: "Access granted!" });
 *   }
 * );
 * ```
 */
export function requirePayment(options: RequirePaymentOptions): RequestHandler {
  const {
    protocols = ["flux", "x402"],
    prefer,
    price,
    payTo,
    splits,
    storage,
    verifiers: _verifiers,
    idempotency = {},
    expiresInSeconds = 300,
    onPaymentVerified,
    onPaymentFailed,
    metadata,
  } = options;

  // Store verifiers reference for use in verification
  void _verifiers;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Check for existing payment proof in headers
      const fluxInvoiceId = getHeader(req, FLUX_HEADERS.INVOICE_ID);
      const fluxPayment = getHeader(req, FLUX_HEADERS.PAYMENT);
      const x402Signature = getHeader(req, X402_HEADERS.PAYMENT_SIGNATURE);

      // If payment headers present, try to verify
      if ((fluxInvoiceId && fluxPayment) || x402Signature) {
        const verifyResult = await verifyPayment(req, options);

        if (verifyResult.verified && verifyResult.invoice) {
          // Payment verified - call callback and continue
          if (onPaymentVerified) {
            await onPaymentVerified(req, verifyResult.invoice, verifyResult.proof!);
          }

          // Attach invoice to request for downstream use
          (req as RequestWithInvoice).paidInvoice = verifyResult.invoice;

          return next();
        }

        // Payment verification failed
        if (onPaymentFailed) {
          await onPaymentFailed(
            req,
            verifyResult.invoice ?? null,
            verifyResult.error ?? "Verification failed"
          );
        }
      }

      // Check idempotency for existing invoice
      const idempotencyResult = await processIdempotency(req, storage, idempotency);

      if (idempotencyResult.isDuplicate && idempotencyResult.existingInvoice) {
        const existingInvoice = idempotencyResult.existingInvoice;

        // If already confirmed/consumed, allow access
        if (existingInvoice.status === "confirmed" || existingInvoice.status === "consumed") {
          (req as RequestWithInvoice).paidInvoice = existingInvoice;
          return next();
        }

        // Return existing pending invoice
        return emit402Response(
          existingInvoice,
          req,
          res,
          protocols,
          prefer,
          splits?.(req)
        );
      }

      // Create new invoice
      const priceConfig = await price(req);
      const recipientAddress = typeof payTo === "function" ? payTo(req) : payTo;
      const requestHash = await hashRequest(req.method, req.url, req.body);

      const metadataValue = metadata?.(req);
      const invoiceParams: CreateInvoiceParams = {
        chain: priceConfig.chain,
        asset: priceConfig.asset,
        amountUnits: priceConfig.amountUnits,
        payTo: recipientAddress,
        expiresInSeconds,
        idempotencyKey: idempotencyResult.key,
        requestHash,
        ...(metadataValue !== undefined ? { metadata: metadataValue } : {}),
      };

      const invoice = await storage.create(invoiceParams);

      // Return 402 response
      return emit402Response(
        invoice,
        req,
        res,
        protocols,
        prefer,
        splits?.(req)
      );
    } catch (error) {
      next(error);
    }
  };
}

// ---------------------------------------------------------------------------
// Payment Verification
// ---------------------------------------------------------------------------

interface VerifyResult {
  verified: boolean;
  invoice?: Invoice;
  proof?: PaymentProof;
  error?: string;
}

/**
 * Verify a payment from request headers.
 */
async function verifyPayment(
  req: Request,
  options: RequirePaymentOptions
): Promise<VerifyResult> {
  const { storage, verifiers } = options;

  // Get invoice ID and payment proof from headers
  const invoiceId = getHeader(req, FLUX_HEADERS.INVOICE_ID);
  const payment = getHeader(req, FLUX_HEADERS.PAYMENT);

  if (!invoiceId) {
    return { verified: false, error: "Missing invoice ID" };
  }

  // Get invoice from storage
  const invoice = await storage.get(invoiceId);

  if (!invoice) {
    return { verified: false, error: "Invoice not found" };
  }

  // Check if already consumed (prevent replay)
  if (invoice.status === "consumed") {
    return {
      verified: false,
      invoice,
      error: "Invoice already consumed",
    };
  }

  // If already confirmed, mark as consumed and allow
  if (invoice.status === "confirmed") {
    await storage.markConsumed(invoiceId);
    const proof = createProofFromInvoice(invoice);
    if (proof) {
      return { verified: true, invoice, proof };
    }
    return { verified: true, invoice };
  }

  // Check if expired
  if (invoice.expiresAt && new Date(invoice.expiresAt) < new Date()) {
    await storage.updateStatus(invoiceId, "expired");
    return {
      verified: false,
      invoice,
      error: "Invoice expired",
    };
  }

  // Find verifier for the chain
  const verifier = findVerifier(verifiers, invoice.chain);

  if (!verifier) {
    return {
      verified: false,
      invoice,
      error: `No verifier available for chain: ${invoice.chain}`,
    };
  }

  // Create proof from payment header
  const proof = createProofFromPayment(payment, invoice.chain);

  if (!proof) {
    return {
      verified: false,
      invoice,
      error: "Invalid payment proof format",
    };
  }

  // Verify payment on-chain
  const verifyResult = await verifier.verify(
    proof,
    BigInt(invoice.amountUnits),
    invoice.payTo,
    invoice.chain
  );

  if (!verifyResult.verified) {
    return {
      verified: false,
      invoice,
      proof,
      error: verifyResult.error ?? "Payment verification failed",
    };
  }

  // Update invoice status
  await storage.updateStatus(invoiceId, "confirmed", verifyResult.txHash);
  await storage.markConsumed(invoiceId);

  // Refresh invoice
  const updatedInvoice = await storage.get(invoiceId);

  return {
    verified: true,
    invoice: updatedInvoice ?? invoice,
    proof,
  };
}

/**
 * Create a payment proof from header value.
 */
function createProofFromPayment(
  payment: string | undefined,
  chain: ChainId
): PaymentProof | null {
  if (!payment) {
    return null;
  }

  // Try to parse as JSON
  try {
    const parsed = JSON.parse(payment);
    if (parsed.kind) {
      return parsed as PaymentProof;
    }
    if (parsed.txHash) {
      // Infer kind from chain
      if (chain.startsWith("cardano")) {
        return { kind: "cardano-txhash", txHash: parsed.txHash };
      }
      return { kind: "evm-txhash", txHash: parsed.txHash };
    }
  } catch {
    // Not JSON - treat as raw txHash
  }

  // Treat as raw transaction hash
  if (chain.startsWith("cardano")) {
    return { kind: "cardano-txhash", txHash: payment };
  }

  return { kind: "evm-txhash", txHash: payment };
}

/**
 * Create proof from confirmed invoice.
 */
function createProofFromInvoice(invoice: Invoice): PaymentProof | undefined {
  if (!invoice.txHash) {
    return undefined;
  }

  if (invoice.chain.startsWith("cardano")) {
    return { kind: "cardano-txhash", txHash: invoice.txHash };
  }

  return { kind: "evm-txhash", txHash: invoice.txHash };
}

// ---------------------------------------------------------------------------
// 402 Response Emission
// ---------------------------------------------------------------------------

/**
 * Emit a 402 response in the appropriate protocol format.
 */
function emit402Response(
  invoice: Invoice,
  req: Request,
  res: Response,
  protocols: Array<"flux" | "x402">,
  prefer: ((req: Request) => "flux" | "x402" | "auto") | undefined,
  splitConfig: SplitConfig | undefined
): void {
  // Determine preferred protocol
  let protocol: "flux" | "x402";

  if (prefer) {
    const preferred = prefer(req);
    protocol = preferred === "auto"
      ? protocols[0] ?? "flux"
      : preferred;
  } else {
    // Check Accept header for preference
    const accept = req.get("Accept") ?? "";
    if (accept.includes("x402") && protocols.includes("x402")) {
      protocol = "x402";
    } else {
      protocol = protocols[0] ?? "flux";
    }
  }

  // Convert splits to protocol format
  const fluxSplits: FluxSplit[] | undefined = splitConfig?.outputs.map((o) => {
    const split: FluxSplit = {
      to: o.to,
      amount: o.amountUnits,
    };
    if (o.role !== undefined) {
      split.role = o.role;
    }
    return split;
  });

  // Emit response in selected protocol
  if (protocol === "x402" && protocols.includes("x402")) {
    createX402_402Response(invoice, req.url, res);
  } else {
    const emitOptions: { splits?: FluxSplit[]; splitMode?: "inclusive" | "additional" } = {};
    if (fluxSplits !== undefined) {
      emitOptions.splits = fluxSplits;
    }
    if (splitConfig?.mode !== undefined) {
      emitOptions.splitMode = splitConfig.mode;
    }
    createFlux402Response(invoice, res, emitOptions);
  }
}

// ---------------------------------------------------------------------------
// CORS Helper
// ---------------------------------------------------------------------------

/**
 * Get CORS configuration for 402 payment flows.
 *
 * Returns configuration compatible with the cors middleware package.
 *
 * @returns CORS configuration object
 *
 * @example
 * ```typescript
 * import cors from "cors";
 * import { cors402 } from "@fluxpointstudios/poi-sdk-server-middleware";
 *
 * app.use(cors(cors402()));
 * ```
 */
export function cors402() {
  return {
    exposedHeaders: [
      X402_HEADERS.PAYMENT_REQUIRED,
      X402_HEADERS.PAYMENT_RESPONSE,
      FLUX_HEADERS.INVOICE_ID,
      FLUX_HEADERS.PAY_TO,
      FLUX_HEADERS.AMOUNT,
      FLUX_HEADERS.ASSET,
      FLUX_HEADERS.CHAIN,
      FLUX_HEADERS.TIMEOUT,
      FLUX_HEADERS.PAYMENT_STATUS,
      FLUX_HEADERS.TX_HASH,
      FLUX_HEADERS.PAID_VERIFIED,
      "X-Request-Id",
    ],
    allowedHeaders: [
      X402_HEADERS.PAYMENT_SIGNATURE,
      FLUX_HEADERS.INVOICE_ID,
      FLUX_HEADERS.PAYMENT,
      FLUX_HEADERS.IDEMPOTENCY_KEY,
      FLUX_HEADERS.PARTNER,
      FLUX_HEADERS.WALLET_ADDRESS,
      FLUX_HEADERS.CHAIN,
      FLUX_HEADERS.ASSET,
      "Content-Type",
      "Authorization",
    ],
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Get header value from request (case-insensitive).
 */
function getHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Extended request type with paid invoice attached.
 */
export interface RequestWithInvoice extends Request {
  paidInvoice?: Invoice;
}

