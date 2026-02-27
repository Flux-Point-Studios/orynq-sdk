/**
 * @summary Invoice ID generation and settlement info extraction for the gateway.
 *
 * This file provides utilities for bridging x402 payment settlements to
 * backend invoice tracking. It generates deterministic invoice IDs from
 * request data and extracts settlement information from x402 responses.
 *
 * The deterministic invoice ID generation allows the gateway to create
 * consistent IDs that can be used for idempotency on both the gateway
 * and backend sides.
 *
 * Used by:
 * - forward.ts for generating invoice IDs when forwarding requests
 * - server.ts for creating invoices on payment required responses
 */

import { sha256StringHex } from "@fluxpointstudios/orynq-sdk-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Settlement information extracted from an x402 payment response.
 */
export interface SettlementInfo {
  /**
   * Invoice ID associated with this settlement.
   */
  invoiceId: string;

  /**
   * Transaction hash on the blockchain (if available).
   */
  txHash?: string;

  /**
   * Payer's wallet address (if available).
   */
  payer?: string;

  /**
   * Amount paid in atomic units (if available).
   */
  amount?: string;

  /**
   * Chain on which payment was made (if available).
   */
  chain?: string;

  /**
   * Timestamp of the settlement (if available).
   */
  settledAt?: string;
}

/**
 * x402 payment response structure (partial).
 */
export interface X402ResponseData {
  /**
   * Transaction hash on the blockchain.
   */
  txHash?: string;

  /**
   * Sender/payer address.
   */
  from?: string;

  /**
   * Amount paid.
   */
  amount?: string;

  /**
   * Chain identifier.
   */
  network?: string;

  /**
   * Settlement timestamp.
   */
  settledAt?: string;

  /**
   * Payment status.
   */
  status?: string;
}

// ---------------------------------------------------------------------------
// Invoice ID Generation
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic invoice ID from request data.
 *
 * This allows the gateway to create consistent invoiceIds that can be used
 * for idempotency on both sides. If an idempotency key is provided, it is
 * used to ensure the same request always produces the same invoice ID.
 *
 * Without an idempotency key, a timestamp is included to make each request
 * generate a unique invoice ID.
 *
 * @param method - HTTP method (GET, POST, etc.)
 * @param url - Request URL or path
 * @param idempotencyKey - Optional client-provided idempotency key
 * @returns Promise resolving to a 32-character hex invoice ID
 *
 * @example
 * ```typescript
 * // With idempotency key - same inputs always produce same ID
 * const id1 = await generateInvoiceId("POST", "/api/resource", "key123");
 * const id2 = await generateInvoiceId("POST", "/api/resource", "key123");
 * // id1 === id2
 *
 * // Without idempotency key - includes timestamp for uniqueness
 * const id3 = await generateInvoiceId("POST", "/api/resource");
 * ```
 */
export async function generateInvoiceId(
  method: string,
  url: string,
  idempotencyKey?: string
): Promise<string> {
  // Build deterministic input string
  const data = idempotencyKey
    ? `${method.toUpperCase()}:${url}:${idempotencyKey}`
    : `${method.toUpperCase()}:${url}:${Date.now()}`;

  // Hash and truncate to 32 characters
  const hash = await sha256StringHex(data);
  return hash.slice(0, 32);
}

/**
 * Synchronous version of generateInvoiceId for use in synchronous contexts.
 *
 * Note: This uses a simple hash approximation. For cryptographic security,
 * prefer the async version.
 *
 * @param method - HTTP method
 * @param url - Request URL
 * @param idempotencyKey - Optional idempotency key
 * @returns 32-character hex invoice ID
 */
export function generateInvoiceIdSync(
  method: string,
  url: string,
  idempotencyKey?: string
): string {
  // Build deterministic input string
  const data = idempotencyKey
    ? `${method.toUpperCase()}:${url}:${idempotencyKey}`
    : `${method.toUpperCase()}:${url}:${Date.now()}`;

  // Simple string hash for synchronous operation
  // This is not cryptographically secure but sufficient for invoice IDs
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }

  // Convert to positive hex and pad
  const positiveHash = Math.abs(hash);
  const hex1 = positiveHash.toString(16).padStart(8, "0");

  // Generate more entropy from the data
  let hash2 = 5381;
  for (let i = 0; i < data.length; i++) {
    hash2 = ((hash2 << 5) + hash2 + data.charCodeAt(i)) | 0;
  }
  const hex2 = Math.abs(hash2).toString(16).padStart(8, "0");

  let hash3 = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash3 ^= data.charCodeAt(i);
    hash3 = Math.imul(hash3, 0x01000193);
  }
  const hex3 = Math.abs(hash3 >>> 0).toString(16).padStart(8, "0");

  let hash4 = 0;
  for (let i = 0; i < data.length; i++) {
    hash4 = data.charCodeAt(i) + ((hash4 << 6) + (hash4 << 16) - hash4);
  }
  const hex4 = Math.abs(hash4 >>> 0).toString(16).padStart(8, "0");

  return (hex1 + hex2 + hex3 + hex4).slice(0, 32);
}

// ---------------------------------------------------------------------------
// Settlement Info Extraction
// ---------------------------------------------------------------------------

/**
 * Extract payment information from an x402 settlement response.
 *
 * Used to record payment details on the backend side after the gateway
 * has verified the payment through the x402 protocol.
 *
 * @param x402Response - Raw x402 response data (may be undefined)
 * @param generatedInvoiceId - Invoice ID generated by the gateway
 * @returns Normalized settlement information
 *
 * @example
 * ```typescript
 * const settlement = extractSettlementInfo(
 *   { txHash: "0x...", from: "0x...", amount: "1000000" },
 *   "abc123def456..."
 * );
 * // { invoiceId: "abc123def456...", txHash: "0x...", payer: "0x...", amount: "1000000" }
 * ```
 */
export function extractSettlementInfo(
  x402Response: X402ResponseData | undefined | null,
  generatedInvoiceId: string
): SettlementInfo {
  const info: SettlementInfo = {
    invoiceId: generatedInvoiceId,
  };

  if (x402Response) {
    if (x402Response.txHash) {
      info.txHash = x402Response.txHash;
    }
    if (x402Response.from) {
      info.payer = x402Response.from;
    }
    if (x402Response.amount) {
      info.amount = x402Response.amount;
    }
    if (x402Response.network) {
      info.chain = x402Response.network;
    }
    if (x402Response.settledAt) {
      info.settledAt = x402Response.settledAt;
    }
  }

  return info;
}

/**
 * Parse settlement info from a base64-encoded x402 response header.
 *
 * @param encodedHeader - Base64-encoded JSON string from PAYMENT-RESPONSE header
 * @param invoiceId - Invoice ID to include in the result
 * @returns Parsed settlement info or null if parsing fails
 */
export function parseSettlementHeader(
  encodedHeader: string | undefined,
  invoiceId: string
): SettlementInfo | null {
  if (!encodedHeader) {
    return null;
  }

  try {
    let json: string;
    if (typeof Buffer !== "undefined") {
      json = Buffer.from(encodedHeader, "base64").toString("utf-8");
    } else {
      json = atob(encodedHeader);
    }

    const parsed = JSON.parse(json) as X402ResponseData;
    return extractSettlementInfo(parsed, invoiceId);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Check if a string is a valid invoice ID format.
 *
 * Invoice IDs should be 32-character lowercase hex strings.
 *
 * @param invoiceId - String to validate
 * @returns true if valid invoice ID format
 */
export function isValidInvoiceId(invoiceId: string): boolean {
  return /^[0-9a-f]{32}$/.test(invoiceId);
}

/**
 * Normalize an invoice ID to consistent format.
 *
 * @param invoiceId - Invoice ID to normalize
 * @returns Lowercase invoice ID or original if invalid
 */
export function normalizeInvoiceId(invoiceId: string): string {
  return invoiceId.toLowerCase().trim();
}
