/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/transport-flux/src/parse.ts
 * @summary Parse Flux JSON invoice body into PaymentRequest format.
 *
 * This file handles the conversion from T-Backend wire format to the
 * protocol-neutral PaymentRequest structure used throughout poi-sdk.
 *
 * Key transformations:
 * - Chain format: "cardano-mainnet" -> "cardano:mainnet" (CAIP-2)
 * - Expiration: ISO timestamp -> timeoutSeconds
 * - Splits: T-Backend format -> PaymentSplits format
 * - Raw invoice preserved for debugging
 *
 * Used by:
 * - index.ts FluxTransport.parse402() method
 * - Server middleware parsing incoming payment requests
 */

import { CHAINS, type PaymentRequest } from "@poi-sdk/core";
import type { FluxInvoice } from "./types.js";

// ---------------------------------------------------------------------------
// Invoice Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a Flux invoice into a PaymentRequest.
 *
 * Converts the T-Backend wire format to the protocol-neutral internal format.
 * Chain identifiers are converted from dash format to CAIP-2 format.
 *
 * @param invoice - Flux invoice from 402 response body
 * @returns Normalized PaymentRequest
 *
 * @example
 * const invoice = {
 *   invoiceId: "inv_123",
 *   amount: "1000000",
 *   currency: "ADA",
 *   payTo: "addr1...",
 *   chain: "cardano-mainnet",
 * };
 * const request = parseFluxInvoice(invoice);
 * // request.chain === "cardano:mainnet"
 */
export function parseFluxInvoice(invoice: FluxInvoice): PaymentRequest {
  // Convert wire chain format (dash) to CAIP-2 format (colon)
  // If not found in CHAINS mapping, use the original value (may already be CAIP-2)
  const chainKey = invoice.chain as keyof typeof CHAINS;
  const chain = CHAINS[chainKey] ?? invoice.chain;

  // Calculate timeout from expiration timestamp
  let timeoutSeconds: number | undefined;
  if (invoice.expiresAt) {
    const expiresAtMs = new Date(invoice.expiresAt).getTime();
    const nowMs = Date.now();
    const remainingMs = expiresAtMs - nowMs;
    // Only set timeout if still in the future
    if (remainingMs > 0) {
      timeoutSeconds = Math.floor(remainingMs / 1000);
    } else {
      // Invoice already expired, set to 0 (will be rejected)
      timeoutSeconds = 0;
    }
  }

  // Build the PaymentRequest
  const request: PaymentRequest = {
    protocol: "flux",
    invoiceId: invoice.invoiceId,
    chain,
    asset: invoice.currency,
    amountUnits: invoice.amount,
    payTo: invoice.payTo,
    // Store raw invoice for debugging and advanced use cases
    raw: invoice,
  };

  // Add optional fields only if present
  if (invoice.decimals !== undefined) {
    request.decimals = invoice.decimals;
  }

  if (timeoutSeconds !== undefined) {
    request.timeoutSeconds = timeoutSeconds;
  }

  if (invoice.partner) {
    request.partner = invoice.partner;
  }

  // Convert splits if present
  if (invoice.splits && invoice.splits.length > 0) {
    request.splits = {
      // Default to "additional" if splitMode not specified
      mode: invoice.splitMode ?? "additional",
      outputs: invoice.splits.map((s) => {
        // Build output object, only including defined optional fields
        // This satisfies exactOptionalPropertyTypes
        const output: {
          to: string;
          amountUnits: string;
          role?: string;
          asset?: string;
        } = {
          to: s.to,
          amountUnits: s.amount,
        };
        if (s.role !== undefined) {
          output.role = s.role;
        }
        if (s.currency !== undefined) {
          output.asset = s.currency;
        }
        return output;
      }),
    };
  }

  return request;
}

// ---------------------------------------------------------------------------
// Response Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a 402 Response to extract a PaymentRequest.
 *
 * Checks if the response is a valid Flux 402 (JSON body with invoiceId)
 * and parses the invoice if so.
 *
 * @param res - HTTP Response to parse
 * @returns PaymentRequest if valid Flux 402, null otherwise
 *
 * @example
 * const res = await fetch(url);
 * if (res.status === 402) {
 *   const request = await parse402Response(res);
 *   if (request) {
 *     // Handle Flux payment requirement
 *   }
 * }
 */
export async function parse402Response(
  res: Response
): Promise<PaymentRequest | null> {
  // Check content type - must be JSON for Flux
  const contentType = res.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    return null;
  }

  try {
    // Clone response to avoid consuming the body
    const body: unknown = await res.clone().json();

    // Validate that body is an object with invoiceId
    if (
      body === null ||
      typeof body !== "object" ||
      !("invoiceId" in body) ||
      typeof (body as FluxInvoice).invoiceId !== "string"
    ) {
      return null;
    }

    // Type assertion is safe after validation
    const invoice = body as FluxInvoice;

    // Additional validation for required fields
    if (
      !invoice.amount ||
      !invoice.currency ||
      !invoice.payTo ||
      !invoice.chain
    ) {
      return null;
    }

    return parseFluxInvoice(invoice);
  } catch {
    // JSON parse error or other failure
    return null;
  }
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Check if a response body looks like a Flux invoice.
 *
 * This is a synchronous check that only examines headers,
 * useful for quick protocol detection before parsing.
 *
 * @param res - Response to check
 * @returns true if response appears to be Flux format
 */
export function looksLikeFluxResponse(res: Response): boolean {
  // Must be JSON content type
  const contentType = res.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    return false;
  }

  // Must NOT have x402's PAYMENT-REQUIRED header
  if (res.headers.has("PAYMENT-REQUIRED")) {
    return false;
  }

  return true;
}

/**
 * Extract invoice ID from response headers if present.
 *
 * Some Flux servers include the invoice ID in response headers
 * for convenience.
 *
 * @param res - Response to check
 * @returns Invoice ID if present in headers
 */
export function extractInvoiceIdFromHeaders(res: Response): string | null {
  return res.headers.get("X-Invoice-Id");
}
