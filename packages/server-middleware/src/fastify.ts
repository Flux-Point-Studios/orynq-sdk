/**
 * @summary Fastify plugin for payment-required endpoints.
 *
 * This file provides a Fastify plugin that implements HTTP 402 Payment Required
 * handling with support for both Flux and x402 protocols. The plugin:
 * - Registers a preHandler hook on specified routes
 * - Checks for valid payment proofs in headers
 * - Verifies payments on-chain using configured verifiers
 * - Returns 402 responses when payment is required
 * - Handles idempotency for request deduplication
 *
 * Used by:
 * - Fastify applications requiring payment for API access
 */

import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  FastifyPluginCallback,
  FastifyPluginOptions,
} from "fastify";
import {
  FLUX_HEADERS,
  X402_HEADERS,
  type ChainId,
  type PaymentProof,
} from "@fluxpointstudios/poi-sdk-core";
import type { InvoiceStore, Invoice, CreateInvoiceParams } from "./invoice-store.js";
import type { ChainVerifier } from "./verifiers/interface.js";
import { findVerifier } from "./verifiers/interface.js";
import {
  buildFluxResponseBody,
  getFluxHeaders,
  type FluxSplit,
} from "./protocols/emit-flux.js";
import { buildX402Payload, encodePayload } from "./protocols/emit-x402.js";
import { processIdempotency, type IdempotencyConfig } from "./idempotency.js";
import { hashRequest } from "./request-hash.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Price configuration for a payment request.
 */
export interface PriceConfig {
  chain: ChainId;
  asset: string;
  amountUnits: string;
  decimals?: number;
}

/**
 * Split payment configuration.
 */
export interface SplitConfig {
  mode: "inclusive" | "additional";
  outputs: Array<{
    to: string;
    amountUnits: string;
    role?: string;
  }>;
}

/**
 * Options for the Fastify payment plugin.
 */
export interface FastifyPaymentPluginOptions extends FastifyPluginOptions {
  /**
   * Protocols to support.
   * @default ["flux", "x402"]
   */
  protocols?: Array<"flux" | "x402">;

  /**
   * Function to determine preferred protocol for a request.
   */
  prefer?: (req: FastifyRequest) => "flux" | "x402" | "auto";

  /**
   * Function to compute price for a request.
   */
  price: (req: FastifyRequest) => PriceConfig | Promise<PriceConfig>;

  /**
   * Recipient address or function to compute it.
   */
  payTo: string | ((req: FastifyRequest) => string);

  /**
   * Function to compute split configuration for a request.
   */
  splits?: (req: FastifyRequest) => SplitConfig | undefined;

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
   * Routes to protect (optional - use onRoute hook to apply selectively).
   */
  routes?: string[];

  /**
   * Callback when payment is verified.
   */
  onPaymentVerified?: (
    req: FastifyRequest,
    invoice: Invoice,
    proof: PaymentProof
  ) => void | Promise<void>;

  /**
   * Callback when payment verification fails.
   */
  onPaymentFailed?: (
    req: FastifyRequest,
    invoice: Invoice | null,
    error: string
  ) => void | Promise<void>;

  /**
   * Additional metadata to store with invoices.
   */
  metadata?: (req: FastifyRequest) => Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Request Decoration
// ---------------------------------------------------------------------------

/**
 * Extend FastifyRequest to include paid invoice.
 */
declare module "fastify" {
  interface FastifyRequest {
    paidInvoice?: Invoice;
  }
}

// ---------------------------------------------------------------------------
// Plugin Implementation
// ---------------------------------------------------------------------------

/**
 * Fastify plugin for payment-required endpoints.
 *
 * @example
 * ```typescript
 * import Fastify from "fastify";
 * import { fastifyPayment, MemoryInvoiceStore, CardanoVerifier } from "@fluxpointstudios/poi-sdk-server-middleware";
 *
 * const fastify = Fastify();
 * const store = new MemoryInvoiceStore();
 * const verifier = new CardanoVerifier({ blockfrostProjectId: "..." });
 *
 * fastify.register(fastifyPayment, {
 *   price: () => ({
 *     chain: "cardano:mainnet",
 *     asset: "ADA",
 *     amountUnits: "1000000",
 *   }),
 *   payTo: "addr1...",
 *   storage: store,
 *   verifiers: [verifier],
 *   routes: ["/api/protected/*"],
 * });
 *
 * fastify.get("/api/protected/resource", async (req, reply) => {
 *   return { message: "Access granted!", invoice: req.paidInvoice };
 * });
 * ```
 */
export const fastifyPayment: FastifyPluginCallback<FastifyPaymentPluginOptions> =
  (fastify: FastifyInstance, options: FastifyPaymentPluginOptions, done) => {
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
      routes,
      onPaymentVerified,
      onPaymentFailed,
      metadata,
    } = options;

    // Store reference
    void _verifiers;

    // Decorate request with paidInvoice
    if (!fastify.hasRequestDecorator("paidInvoice")) {
      fastify.decorateRequest("paidInvoice", undefined);
    }

    // Create the preHandler hook
    const paymentHandler = async (
      req: FastifyRequest,
      reply: FastifyReply
    ): Promise<void> => {
      try {
        // Check for existing payment proof in headers
        const fluxInvoiceId = getHeader(req, FLUX_HEADERS.INVOICE_ID);
        const fluxPayment = getHeader(req, FLUX_HEADERS.PAYMENT);
        const x402Signature = getHeader(req, X402_HEADERS.PAYMENT_SIGNATURE);

        // If payment headers present, try to verify
        if ((fluxInvoiceId && fluxPayment) || x402Signature) {
          const verifyResult = await verifyPayment(req, options);

          if (verifyResult.verified && verifyResult.invoice) {
            if (onPaymentVerified) {
              await onPaymentVerified(req, verifyResult.invoice, verifyResult.proof!);
            }

            req.paidInvoice = verifyResult.invoice;
            return; // Continue to route handler
          }

          if (onPaymentFailed) {
            await onPaymentFailed(
              req,
              verifyResult.invoice ?? null,
              verifyResult.error ?? "Verification failed"
            );
          }
        }

        // Check idempotency for existing invoice
        const idempotencyResult = await processIdempotency(
          {
            method: req.method,
            url: req.url,
            body: req.body,
            headers: req.headers,
          },
          storage,
          idempotency
        );

        if (idempotencyResult.isDuplicate && idempotencyResult.existingInvoice) {
          const existingInvoice = idempotencyResult.existingInvoice;

          if (existingInvoice.status === "confirmed" || existingInvoice.status === "consumed") {
            req.paidInvoice = existingInvoice;
            return;
          }

          await emit402Response(
            existingInvoice,
            req,
            reply,
            protocols,
            prefer,
            splits?.(req)
          );
          return;
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

        await emit402Response(
          invoice,
          req,
          reply,
          protocols,
          prefer,
          splits?.(req)
        );
      } catch (error) {
        throw error; // Let Fastify error handler deal with it
      }
    };

    // Apply to specific routes or globally
    if (routes && routes.length > 0) {
      // Register hook for specific routes
      fastify.addHook("onRoute", (routeOptions) => {
        const routePath = routeOptions.url;

        // Check if route matches any of the protected routes
        const isProtected = routes.some((pattern) => {
          if (pattern.endsWith("/*")) {
            const prefix = pattern.slice(0, -2);
            return routePath.startsWith(prefix);
          }
          return routePath === pattern;
        });

        if (isProtected) {
          const existingPreHandler = routeOptions.preHandler;

          if (Array.isArray(existingPreHandler)) {
            routeOptions.preHandler = [paymentHandler, ...existingPreHandler];
          } else if (existingPreHandler) {
            routeOptions.preHandler = [paymentHandler, existingPreHandler];
          } else {
            routeOptions.preHandler = paymentHandler;
          }
        }
      });
    } else {
      // Apply globally (use with caution)
      fastify.addHook("preHandler", paymentHandler);
    }

    done();
  };

// ---------------------------------------------------------------------------
// Payment Verification
// ---------------------------------------------------------------------------

interface VerifyResult {
  verified: boolean;
  invoice?: Invoice;
  proof?: PaymentProof;
  error?: string;
}

async function verifyPayment(
  req: FastifyRequest,
  options: FastifyPaymentPluginOptions
): Promise<VerifyResult> {
  const { storage, verifiers } = options;

  const invoiceId = getHeader(req, FLUX_HEADERS.INVOICE_ID);
  const payment = getHeader(req, FLUX_HEADERS.PAYMENT);

  if (!invoiceId) {
    return { verified: false, error: "Missing invoice ID" };
  }

  const invoice = await storage.get(invoiceId);

  if (!invoice) {
    return { verified: false, error: "Invoice not found" };
  }

  if (invoice.status === "consumed") {
    return { verified: false, invoice, error: "Invoice already consumed" };
  }

  if (invoice.status === "confirmed") {
    await storage.markConsumed(invoiceId);
    const proof = createProofFromInvoice(invoice);
    if (proof) {
      return { verified: true, invoice, proof };
    }
    return { verified: true, invoice };
  }

  if (invoice.expiresAt && new Date(invoice.expiresAt) < new Date()) {
    await storage.updateStatus(invoiceId, "expired");
    return { verified: false, invoice, error: "Invoice expired" };
  }

  const verifier = findVerifier(verifiers, invoice.chain);

  if (!verifier) {
    return {
      verified: false,
      invoice,
      error: `No verifier available for chain: ${invoice.chain}`,
    };
  }

  const proof = createProofFromPayment(payment, invoice.chain);

  if (!proof) {
    return { verified: false, invoice, error: "Invalid payment proof format" };
  }

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

  await storage.updateStatus(invoiceId, "confirmed", verifyResult.txHash);
  await storage.markConsumed(invoiceId);

  const updatedInvoice = await storage.get(invoiceId);

  return {
    verified: true,
    invoice: updatedInvoice ?? invoice,
    proof,
  };
}

function createProofFromPayment(
  payment: string | undefined,
  chain: ChainId
): PaymentProof | null {
  if (!payment) return null;

  try {
    const parsed = JSON.parse(payment);
    if (parsed.kind) return parsed as PaymentProof;
    if (parsed.txHash) {
      if (chain.startsWith("cardano")) {
        return { kind: "cardano-txhash", txHash: parsed.txHash };
      }
      return { kind: "evm-txhash", txHash: parsed.txHash };
    }
  } catch {
    // Not JSON
  }

  if (chain.startsWith("cardano")) {
    return { kind: "cardano-txhash", txHash: payment };
  }

  return { kind: "evm-txhash", txHash: payment };
}

function createProofFromInvoice(invoice: Invoice): PaymentProof | undefined {
  if (!invoice.txHash) return undefined;

  if (invoice.chain.startsWith("cardano")) {
    return { kind: "cardano-txhash", txHash: invoice.txHash };
  }

  return { kind: "evm-txhash", txHash: invoice.txHash };
}

// ---------------------------------------------------------------------------
// 402 Response Emission
// ---------------------------------------------------------------------------

async function emit402Response(
  invoice: Invoice,
  req: FastifyRequest,
  reply: FastifyReply,
  protocols: Array<"flux" | "x402">,
  prefer: ((req: FastifyRequest) => "flux" | "x402" | "auto") | undefined,
  splitConfig: SplitConfig | undefined
): Promise<void> {
  let protocol: "flux" | "x402";

  if (prefer) {
    const preferred = prefer(req);
    protocol = preferred === "auto" ? protocols[0] ?? "flux" : preferred;
  } else {
    const accept = req.headers.accept ?? "";
    if (accept.includes("x402") && protocols.includes("x402")) {
      protocol = "x402";
    } else {
      protocol = protocols[0] ?? "flux";
    }
  }

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

  if (protocol === "x402" && protocols.includes("x402")) {
    const payload = buildX402Payload(invoice, req.url);
    const encoded = encodePayload(payload);

    reply
      .status(402)
      .header("Content-Type", "application/json")
      .header(X402_HEADERS.PAYMENT_REQUIRED, encoded)
      .send({
        error: "Payment Required",
        invoiceId: invoice.id,
        paymentRequired: true,
      });
  } else {
    const emitOptions: { splits?: FluxSplit[]; splitMode?: "inclusive" | "additional" } = {};
    if (fluxSplits !== undefined) {
      emitOptions.splits = fluxSplits;
    }
    if (splitConfig?.mode !== undefined) {
      emitOptions.splitMode = splitConfig.mode;
    }
    const body = buildFluxResponseBody(invoice, emitOptions);
    const headers = getFluxHeaders(invoice);

    let replyChain = reply.status(402);
    for (const [name, value] of Object.entries(headers)) {
      replyChain = replyChain.header(name, value);
    }
    replyChain.send(body);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getHeader(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export default fastifyPayment;
