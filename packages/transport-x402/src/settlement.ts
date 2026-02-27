/**
 * @summary Parse x402 PAYMENT-RESPONSE headers for settlement information.
 *
 * This file handles the decoding and extraction of settlement data from
 * the PAYMENT-RESPONSE header returned after successful payment processing.
 * The header contains base64-encoded JSON with transaction details.
 *
 * Used by:
 * - index.ts X402Transport.parseSettlement() implementation
 * - Client code that needs to verify payment completion
 */

import { X402_HEADERS } from "@fluxpointstudios/orynq-sdk-core";
import type { X402Settlement } from "./types.js";
import { isX402PaymentResponse } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse settlement information from a response that may contain PAYMENT-RESPONSE header.
 *
 * The PAYMENT-RESPONSE header is present after the server has processed a payment.
 * It contains information about whether the payment succeeded and optional
 * transaction details.
 *
 * @param res - HTTP Response to extract settlement from
 * @returns Settlement information or null if header not present
 *
 * @example
 * ```typescript
 * const response = await fetch(paidRequest);
 * const settlement = parseSettlement(response);
 * if (settlement?.success) {
 *   console.log(`Payment confirmed: ${settlement.txHash}`);
 * }
 * ```
 */
export function parseSettlement(res: Response): X402Settlement | null {
  const header = res.headers.get(X402_HEADERS.PAYMENT_RESPONSE);
  if (!header) {
    return null;
  }

  return parsePaymentResponse(header);
}

/**
 * Parse a base64-encoded PAYMENT-RESPONSE header value.
 *
 * @param header - Base64-encoded JSON string from PAYMENT-RESPONSE header
 * @returns Settlement information
 * @throws Error if the header cannot be decoded or is invalid
 *
 * @example
 * ```typescript
 * const header = response.headers.get("PAYMENT-RESPONSE");
 * if (header) {
 *   const settlement = parsePaymentResponse(header);
 *   console.log(`Success: ${settlement.success}`);
 * }
 * ```
 */
export function parsePaymentResponse(header: string): X402Settlement {
  // Decode base64 to JSON string
  let jsonString: string;
  try {
    jsonString = decodeBase64(header);
  } catch (err) {
    throw new Error(
      `Failed to decode x402 PAYMENT-RESPONSE header: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Parse JSON
  let rawData: unknown;
  try {
    rawData = JSON.parse(jsonString);
  } catch (err) {
    throw new Error(
      `Failed to parse x402 PAYMENT-RESPONSE JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Validate and convert
  return x402ResponseToSettlement(rawData);
}

/**
 * Convert raw x402 payment response to settlement format.
 *
 * @param raw - Raw decoded data from PAYMENT-RESPONSE header
 * @returns Normalized settlement information
 * @throws Error if the data is not a valid payment response
 */
export function x402ResponseToSettlement(raw: unknown): X402Settlement {
  if (!isX402PaymentResponse(raw)) {
    throw new Error(
      "Invalid x402 PAYMENT-RESPONSE header: missing required 'success' field"
    );
  }

  const settlement: X402Settlement = {
    success: raw.success,
  };

  // Copy optional fields if present
  if (typeof raw.txHash === "string") {
    settlement.txHash = raw.txHash;
  }

  if (typeof raw.settledAt === "string") {
    settlement.settledAt = raw.settledAt;
  }

  if (typeof raw.error === "string") {
    settlement.error = raw.error;
  }

  // Collect any extra fields
  const knownFields = new Set(["success", "txHash", "settledAt", "error", "network"]);
  const extra: Record<string, unknown> = {};
  let hasExtra = false;

  for (const [key, value] of Object.entries(raw)) {
    if (!knownFields.has(key)) {
      extra[key] = value;
      hasExtra = true;
    }
  }

  if (hasExtra) {
    settlement.extra = extra;
  }

  return settlement;
}

/**
 * Check if a response indicates successful payment.
 *
 * Convenience function to quickly check if a response contains
 * a successful payment settlement.
 *
 * @param res - HTTP Response to check
 * @returns true if the response has a successful settlement header
 *
 * @example
 * ```typescript
 * const response = await fetch(paidRequest);
 * if (isPaymentSettled(response)) {
 *   console.log("Payment successful!");
 * }
 * ```
 */
export function isPaymentSettled(res: Response): boolean {
  const settlement = parseSettlement(res);
  return settlement !== null && settlement.success;
}

/**
 * Extract transaction hash from a settlement response.
 *
 * @param res - HTTP Response that may contain settlement
 * @returns Transaction hash or null
 *
 * @example
 * ```typescript
 * const txHash = getSettlementTxHash(response);
 * if (txHash) {
 *   console.log(`View on explorer: https://basescan.org/tx/${txHash}`);
 * }
 * ```
 */
export function getSettlementTxHash(res: Response): string | null {
  const settlement = parseSettlement(res);
  return settlement?.txHash ?? null;
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Decode a base64 string to UTF-8 text.
 * Works in both Node.js and browser environments.
 *
 * @param base64 - Base64-encoded string
 * @returns Decoded UTF-8 string
 */
function decodeBase64(base64: string): string {
  // Handle URL-safe base64 (replace - with + and _ with /)
  const normalized = base64.replace(/-/g, "+").replace(/_/g, "/");

  // Node.js environment
  if (typeof Buffer !== "undefined") {
    return Buffer.from(normalized, "base64").toString("utf-8");
  }

  // Browser environment
  if (typeof atob !== "undefined") {
    const binaryString = atob(normalized);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }

  throw new Error("No base64 decoding function available in this environment");
}
