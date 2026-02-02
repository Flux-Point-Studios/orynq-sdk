/**
 * @summary x402 protocol 402 response emitter.
 *
 * This file provides functions to emit HTTP 402 Payment Required responses
 * in the x402 protocol format. x402 uses base64-encoded JSON in the
 * PAYMENT-REQUIRED header to communicate payment requirements.
 *
 * x402 protocol features:
 * - Base64-encoded payment info in header
 * - Compact wire format
 * - Scheme-based payment models (exact, stream, etc.)
 * - Network identifier for multi-chain support
 *
 * Used by:
 * - Express middleware when emitting 402 responses
 * - Fastify plugin when emitting 402 responses
 */

import { X402_HEADERS } from "@fluxpointstudios/orynq-sdk-core";
import type { Invoice } from "../invoice-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * x402 Payment Required payload structure.
 *
 * This is encoded as base64 JSON in the PAYMENT-REQUIRED header.
 */
export interface X402PaymentRequired {
  /**
   * Protocol version.
   * @default "1"
   */
  version: string;

  /**
   * Payment scheme determining how payment is calculated.
   * - "exact": Fixed amount for the resource
   * - "stream": Pay-per-unit streaming
   * - "subscription": Recurring payment
   */
  scheme: "exact" | "stream" | "subscription";

  /**
   * Network/chain identifier.
   * Uses CAIP-2 format internally but may be aliased in the protocol.
   */
  network: string;

  /**
   * Maximum amount required in atomic units.
   */
  maxAmountRequired: string;

  /**
   * Resource identifier (typically the request URL/path).
   */
  resource: string;

  /**
   * Recipient address for payment.
   */
  payTo: string;

  /**
   * Maximum timeout in seconds before the payment offer expires.
   */
  maxTimeoutSeconds?: number;

  /**
   * Asset/token identifier.
   * @default Native token (ETH, ADA, etc.)
   */
  asset?: string;

  /**
   * Number of decimal places for the asset.
   */
  decimals?: number;

  /**
   * Additional metadata fields.
   */
  extra?: Record<string, unknown>;
}

/**
 * Options for creating x402 402 responses.
 */
export interface CreateX402ResponseOptions {
  /**
   * Payment scheme.
   * @default "exact"
   */
  scheme?: "exact" | "stream" | "subscription";

  /**
   * Protocol version.
   * @default "1"
   */
  version?: string;

  /**
   * Number of decimal places for display.
   */
  decimals?: number;

  /**
   * Additional metadata to include in the payload.
   */
  extra?: Record<string, unknown>;

  /**
   * Custom error message for the JSON body.
   */
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Response Type (Framework Agnostic)
// ---------------------------------------------------------------------------

/**
 * Minimal response interface for framework compatibility.
 */
interface HttpResponse {
  status?(code: number): HttpResponse;
  statusCode?: number;
  setHeader(name: string, value: string | number): void;
  json(body: unknown): void;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Create an x402 402 Payment Required response.
 *
 * Sets the PAYMENT-REQUIRED header with base64-encoded payment info
 * and returns a JSON error body.
 *
 * @param invoice - Invoice to include in the response
 * @param resource - Resource identifier (usually request URL)
 * @param res - HTTP response object (Express, Fastify, etc.)
 * @param options - Additional options for the response
 *
 * @example
 * ```typescript
 * app.get("/protected", async (req, res) => {
 *   const invoice = await store.create({
 *     chain: "eip155:8453",
 *     asset: "USDC",
 *     amountUnits: "1000000",
 *     payTo: "0x...",
 *   });
 *
 *   createX402_402Response(invoice, req.url, res);
 * });
 * ```
 */
export function createX402_402Response(
  invoice: Invoice,
  resource: string,
  res: HttpResponse,
  options: CreateX402ResponseOptions = {}
): void {
  const {
    scheme = "exact",
    version = "1",
    decimals,
    extra,
    errorMessage = "Payment Required",
  } = options;

  // Calculate timeout
  let maxTimeoutSeconds: number | undefined;
  if (invoice.expiresAt) {
    maxTimeoutSeconds = Math.max(
      0,
      Math.floor((new Date(invoice.expiresAt).getTime() - Date.now()) / 1000)
    );
  }

  // Build x402 payload
  const payload: X402PaymentRequired = {
    version,
    scheme,
    network: invoice.chain,
    maxAmountRequired: invoice.amountUnits,
    resource,
    payTo: invoice.payTo,
  };

  // Add optional fields only if they have values
  if (maxTimeoutSeconds !== undefined) {
    payload.maxTimeoutSeconds = maxTimeoutSeconds;
  }
  if (invoice.asset !== undefined) {
    payload.asset = invoice.asset;
  }
  if (decimals !== undefined) {
    payload.decimals = decimals;
  }
  if (extra !== undefined) {
    payload.extra = extra;
  }

  // Encode payload as base64
  const encoded = encodePayload(payload);

  // Set status
  if (typeof res.status === "function") {
    res.status(402);
  } else if (res.statusCode !== undefined) {
    res.statusCode = 402;
  }

  // Set headers
  res.setHeader("Content-Type", "application/json");
  res.setHeader(X402_HEADERS.PAYMENT_REQUIRED, encoded);

  // Send response body
  res.json({
    error: errorMessage,
    invoiceId: invoice.id,
    paymentRequired: true,
  });
}

/**
 * Build an x402 payment required payload without sending it.
 *
 * @param invoice - Invoice to build payload for
 * @param resource - Resource identifier
 * @param options - Additional options
 * @returns x402 payment required payload object
 */
export function buildX402Payload(
  invoice: Invoice,
  resource: string,
  options: CreateX402ResponseOptions = {}
): X402PaymentRequired {
  const { scheme = "exact", version = "1", decimals, extra } = options;

  let maxTimeoutSeconds: number | undefined;
  if (invoice.expiresAt) {
    maxTimeoutSeconds = Math.max(
      0,
      Math.floor((new Date(invoice.expiresAt).getTime() - Date.now()) / 1000)
    );
  }

  const payload: X402PaymentRequired = {
    version,
    scheme,
    network: invoice.chain,
    maxAmountRequired: invoice.amountUnits,
    resource,
    payTo: invoice.payTo,
  };

  if (maxTimeoutSeconds !== undefined) {
    payload.maxTimeoutSeconds = maxTimeoutSeconds;
  }
  if (invoice.asset !== undefined) {
    payload.asset = invoice.asset;
  }
  if (decimals !== undefined) {
    payload.decimals = decimals;
  }
  if (extra !== undefined) {
    payload.extra = extra;
  }

  return payload;
}

/**
 * Encode an x402 payload to base64 string.
 *
 * @param payload - Payment required payload to encode
 * @returns Base64-encoded JSON string
 */
export function encodePayload(payload: X402PaymentRequired): string {
  const json = JSON.stringify(payload);

  // Use Buffer in Node.js, btoa in browser
  if (typeof Buffer !== "undefined") {
    return Buffer.from(json, "utf-8").toString("base64");
  }
  return btoa(json);
}

/**
 * Decode an x402 payload from base64 string.
 *
 * @param encoded - Base64-encoded payload
 * @returns Decoded payment required payload
 */
export function decodePayload(encoded: string): X402PaymentRequired {
  let json: string;

  // Use Buffer in Node.js, atob in browser
  if (typeof Buffer !== "undefined") {
    json = Buffer.from(encoded, "base64").toString("utf-8");
  } else {
    json = atob(encoded);
  }

  return JSON.parse(json) as X402PaymentRequired;
}

/**
 * Get x402 headers for a 402 response.
 *
 * @param invoice - Invoice to get headers for
 * @param resource - Resource identifier
 * @param options - Additional options
 * @returns Object with header name-value pairs
 */
export function getX402Headers(
  invoice: Invoice,
  resource: string,
  options: CreateX402ResponseOptions = {}
): Record<string, string> {
  const payload = buildX402Payload(invoice, resource, options);

  return {
    "Content-Type": "application/json",
    [X402_HEADERS.PAYMENT_REQUIRED]: encodePayload(payload),
  };
}

/**
 * Create an x402 payment response header value.
 *
 * This is used in responses after successful payment verification.
 *
 * @param invoiceId - Invoice that was paid
 * @param txHash - Transaction hash (if applicable)
 * @param status - Payment status
 * @returns Base64-encoded payment response
 */
export function createPaymentResponse(
  invoiceId: string,
  txHash?: string,
  status: "accepted" | "pending" | "failed" = "accepted"
): string {
  const response = {
    invoiceId,
    txHash,
    status,
    settledAt: status === "accepted" ? new Date().toISOString() : undefined,
  };

  const json = JSON.stringify(response);

  if (typeof Buffer !== "undefined") {
    return Buffer.from(json, "utf-8").toString("base64");
  }
  return btoa(json);
}
