/**
 * @summary HTTP header constants for Flux and x402 payment protocols.
 *
 * This file defines the header names used in both payment protocols.
 * Using constants ensures consistency across client and server implementations.
 *
 * Used by:
 * - Request interceptors for payment detection
 * - Response handlers for payment requirement parsing
 * - Server middleware for header generation
 */

// ---------------------------------------------------------------------------
// x402 Protocol Headers
// ---------------------------------------------------------------------------

/**
 * HTTP headers used by the x402 protocol.
 *
 * x402 uses uppercase header names following HTTP/2 conventions.
 * These headers are used in both request (proof) and response (requirement).
 */
export const X402_HEADERS = {
  /**
   * Response header containing payment requirement details.
   * Present in 402 responses when payment is required.
   * Value is base64-encoded JSON.
   */
  PAYMENT_REQUIRED: "PAYMENT-REQUIRED",

  /**
   * Request header containing payment signature.
   * Used for cryptographic proof of payment authorization.
   * Value is the signature in hex or base64 format.
   */
  PAYMENT_SIGNATURE: "PAYMENT-SIGNATURE",

  /**
   * Response header containing payment processing result.
   * Present after successful payment verification.
   * Value is base64-encoded JSON with status details.
   */
  PAYMENT_RESPONSE: "PAYMENT-RESPONSE",

  /**
   * Request header for retry with same payment.
   * Used when server didn't receive previous payment attempt.
   */
  PAYMENT_RETRY: "PAYMENT-RETRY",

  /**
   * Response header indicating payment was accepted.
   * Value is the transaction hash or receipt ID.
   */
  PAYMENT_ACCEPTED: "PAYMENT-ACCEPTED",
} as const;

/**
 * Type for x402 header names.
 */
export type X402HeaderName = (typeof X402_HEADERS)[keyof typeof X402_HEADERS];

// ---------------------------------------------------------------------------
// Flux Protocol Headers
// ---------------------------------------------------------------------------

/**
 * HTTP headers used by the Flux protocol.
 *
 * Flux uses X- prefixed headers following traditional HTTP conventions.
 * These support both simple payment flows and complex multi-party payments.
 */
export const FLUX_HEADERS = {
  /**
   * Response header containing the invoice ID.
   * Present in 402 responses to identify the payment request.
   */
  INVOICE_ID: "X-Invoice-Id",

  /**
   * Request header containing payment proof.
   * Value is JSON with proof details (txHash, cborHex, etc.).
   */
  PAYMENT: "X-Payment",

  /**
   * Request header for partner/referrer attribution.
   * Used for tracking referrals and revenue sharing.
   */
  PARTNER: "X-Partner",

  /**
   * Request header containing the payer's wallet address.
   * Used for payment verification and address whitelisting.
   */
  WALLET_ADDRESS: "X-Wallet-Address",

  /**
   * Request header specifying the blockchain.
   * Uses friendly names (e.g., "cardano-mainnet", "base-mainnet").
   */
  CHAIN: "X-Chain",

  /**
   * Request header for request-level idempotency.
   * Ensures the same payment isn't processed twice.
   */
  IDEMPOTENCY_KEY: "X-Idempotency-Key",

  /**
   * Response header indicating payment was verified.
   * Value is "true" when payment has been confirmed.
   */
  PAID_VERIFIED: "X-Paid-Verified",

  /**
   * Response header containing payment status.
   * Value is one of: pending, submitted, confirmed, consumed, expired, failed.
   */
  PAYMENT_STATUS: "X-Payment-Status",

  /**
   * Response header with transaction hash.
   * Present after payment is submitted to blockchain.
   */
  TX_HASH: "X-Tx-Hash",

  /**
   * Request header for specifying payment asset.
   * Value is asset identifier (e.g., "ADA", "USDC", policy.assetHex).
   */
  ASSET: "X-Asset",

  /**
   * Response header containing payment amount in atomic units.
   */
  AMOUNT: "X-Amount",

  /**
   * Response header containing payment recipient address.
   */
  PAY_TO: "X-Pay-To",

  /**
   * Response header indicating payment timeout in seconds.
   */
  TIMEOUT: "X-Timeout",
} as const;

/**
 * Type for Flux header names.
 */
export type FluxHeaderName = (typeof FLUX_HEADERS)[keyof typeof FLUX_HEADERS];

// ---------------------------------------------------------------------------
// Combined Header Types
// ---------------------------------------------------------------------------

/**
 * All payment-related header names (both protocols).
 */
export type PaymentHeaderName = X402HeaderName | FluxHeaderName;

/**
 * Map of all header constants for convenience.
 */
export const PAYMENT_HEADERS = {
  ...X402_HEADERS,
  ...FLUX_HEADERS,
} as const;

// ---------------------------------------------------------------------------
// Header Utilities
// ---------------------------------------------------------------------------

/**
 * Check if a response indicates payment is required (402 status).
 *
 * @param status - HTTP status code
 * @returns true if status is 402 Payment Required
 */
export function isPaymentRequired(status: number): boolean {
  return status === 402;
}

/**
 * Detect which protocol is being used based on response headers.
 *
 * @param headers - Headers object or Map
 * @returns Protocol identifier or null if not a payment response
 */
export function detectProtocol(
  headers: Headers | Map<string, string> | Record<string, string | undefined>
): "flux" | "x402" | null {
  // Normalize header access
  const get = (name: string): string | undefined => {
    if (headers instanceof Headers) {
      return headers.get(name) ?? undefined;
    }
    if (headers instanceof Map) {
      return headers.get(name);
    }
    // Case-insensitive lookup for plain objects
    const lowerName = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === lowerName) {
        return value;
      }
    }
    return undefined;
  };

  // Check for x402 first (more specific)
  if (get(X402_HEADERS.PAYMENT_REQUIRED)) {
    return "x402";
  }

  // Check for Flux headers
  if (get(FLUX_HEADERS.INVOICE_ID) ?? get(FLUX_HEADERS.PAY_TO)) {
    return "flux";
  }

  return null;
}

/**
 * Extract payment-related headers from a response.
 *
 * @param headers - Headers object
 * @returns Object with normalized header values
 */
export function extractPaymentHeaders(
  headers: Headers | Map<string, string> | Record<string, string | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};

  // Normalize header access
  const get = (name: string): string | undefined => {
    if (headers instanceof Headers) {
      return headers.get(name) ?? undefined;
    }
    if (headers instanceof Map) {
      return headers.get(name);
    }
    const lowerName = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === lowerName) {
        return value;
      }
    }
    return undefined;
  };

  // Extract all known payment headers
  const allHeaders = [...Object.values(X402_HEADERS), ...Object.values(FLUX_HEADERS)];

  for (const header of allHeaders) {
    const value = get(header);
    if (value !== undefined) {
      result[header] = value;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Content Types
// ---------------------------------------------------------------------------

/**
 * Content types commonly used in payment flows.
 */
export const CONTENT_TYPES = {
  /** Standard JSON content type */
  JSON: "application/json",
  /** NDJson streaming content type */
  NDJSON: "application/x-ndjson",
  /** Server-sent events content type */
  SSE: "text/event-stream",
  /** x402 payment request content type */
  X402_PAYMENT: "application/x402+json",
} as const;

/**
 * Type for content type values.
 */
export type ContentType = (typeof CONTENT_TYPES)[keyof typeof CONTENT_TYPES];
