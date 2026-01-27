/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/client/src/idempotency.ts
 * @summary Idempotency key management and duplicate payment prevention.
 *
 * This module provides the IdempotencyManager class for generating idempotency
 * keys and preventing duplicate payments. It uses the InvoiceCache from
 * @poi-sdk/core to track paid invoices.
 *
 * Features:
 * - Deterministic key generation from request parameters
 * - Duplicate payment detection via invoice cache
 * - Support for both invoice ID and idempotency key lookups
 *
 * Used by:
 * - PoiClient for request-level duplicate detection
 * - Any component needing idempotent payment handling
 */

import {
  generateIdempotencyKey as coreGenerateKey,
  type PaymentProof,
  type InvoiceCache,
} from "@poi-sdk/core";

// ---------------------------------------------------------------------------
// Idempotency Manager
// ---------------------------------------------------------------------------

/**
 * Manager for idempotency keys and duplicate payment prevention.
 *
 * The IdempotencyManager wraps an InvoiceCache to provide:
 * 1. Deterministic key generation from (method, url, body)
 * 2. Lookup of previously paid invoices by invoice ID
 * 3. Lookup of previously paid requests by idempotency key
 *
 * This enables the client to avoid paying the same invoice twice and to
 * recover gracefully from retries where payment was made but confirmation
 * was not received.
 *
 * @example
 * ```typescript
 * import { IdempotencyManager } from "@poi-sdk/client";
 * import { InMemoryInvoiceCache } from "@poi-sdk/core";
 *
 * const manager = new IdempotencyManager(new InMemoryInvoiceCache());
 *
 * // Generate a key for a request
 * const key = await manager.generateKey("POST", "/api/generate", { prompt: "hello" });
 *
 * // Check if we already paid this invoice
 * const existingProof = await manager.checkPaid("inv_123");
 * if (existingProof) {
 *   console.log("Already paid with:", existingProof);
 * }
 * ```
 */
export class IdempotencyManager {
  private readonly cache: InvoiceCache | undefined;

  /**
   * Create a new IdempotencyManager.
   *
   * @param cache - Optional InvoiceCache for persistent tracking
   */
  constructor(cache?: InvoiceCache) {
    this.cache = cache;
  }

  /**
   * Generate an idempotency key from request parameters.
   *
   * The key is a deterministic hash of the method, URL, and body.
   * The same request will always produce the same key.
   *
   * @param method - HTTP method (GET, POST, etc.)
   * @param url - Request URL
   * @param body - Request body (will be canonicalized if object)
   * @returns Idempotency key string
   */
  async generateKey(
    method: string,
    url: string,
    body?: unknown
  ): Promise<string> {
    return coreGenerateKey(method, url, body);
  }

  /**
   * Check if an invoice has already been paid.
   *
   * @param invoiceId - Invoice identifier
   * @returns Payment proof if already paid, null otherwise
   */
  async checkPaid(invoiceId: string): Promise<PaymentProof | null> {
    if (!this.cache) {
      return null;
    }
    return this.cache.getPaid(invoiceId);
  }

  /**
   * Record that an invoice has been paid.
   *
   * @param invoiceId - Invoice identifier
   * @param proof - Payment proof to store
   */
  async recordPaid(invoiceId: string, proof: PaymentProof): Promise<void> {
    if (!this.cache) {
      return;
    }
    await this.cache.setPaid(invoiceId, proof);
  }

  /**
   * Check if a request has already been paid by idempotency key.
   *
   * This is useful when you don't have the invoice ID but know
   * the original request parameters.
   *
   * @param key - Idempotency key to check
   * @returns Payment proof if found, null otherwise
   */
  async checkByIdempotencyKey(key: string): Promise<PaymentProof | null> {
    if (!this.cache) {
      return null;
    }
    return this.cache.getByIdempotencyKey(key);
  }

  /**
   * Record a payment by idempotency key.
   *
   * This enables looking up payments by the original request parameters
   * rather than just the invoice ID.
   *
   * @param key - Idempotency key
   * @param proof - Payment proof to store
   */
  async recordByIdempotencyKey(
    key: string,
    proof: PaymentProof
  ): Promise<void> {
    if (!this.cache?.setByIdempotencyKey) {
      return;
    }
    await this.cache.setByIdempotencyKey(key, proof);
  }

  /**
   * Check if the manager has a cache configured.
   *
   * @returns true if an InvoiceCache is available
   */
  hasCache(): boolean {
    return this.cache !== undefined;
  }

  /**
   * Clear a specific invoice from the cache.
   *
   * Useful for testing or handling payment failures where
   * you want to retry with a fresh payment.
   *
   * @param invoiceId - Invoice identifier to clear
   */
  async clearInvoice(invoiceId: string): Promise<void> {
    if (!this.cache?.delete) {
      return;
    }
    await this.cache.delete(invoiceId);
  }

  /**
   * Clear the entire cache.
   *
   * Use with caution - this removes all tracking of paid invoices.
   */
  async clearAll(): Promise<void> {
    if (!this.cache?.clear) {
      return;
    }
    await this.cache.clear();
  }
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Generate an idempotency key synchronously using a simple hash.
 *
 * This is a fallback for environments where async is inconvenient.
 * The key is less secure than the async version but still deterministic.
 *
 * @param method - HTTP method
 * @param url - Request URL
 * @param body - Request body
 * @returns Simple idempotency key
 */
export function generateSimpleIdempotencyKey(
  method: string,
  url: string,
  body?: unknown
): string {
  // Simple deterministic string building
  const parts = [method.toUpperCase(), url];

  if (body !== undefined && body !== null) {
    try {
      parts.push(JSON.stringify(body));
    } catch {
      parts.push(String(body));
    }
  }

  const input = parts.join("|");

  // Simple hash using djb2 algorithm
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }

  // Convert to unsigned 32-bit and then to hex
  const unsigned = hash >>> 0;
  return `idem_${unsigned.toString(16).padStart(8, "0")}`;
}

/**
 * Extract invoice ID from a payment request URL path if present.
 *
 * Some APIs include the invoice ID in the URL path for paid requests.
 * This helper extracts it if it follows common patterns.
 *
 * @param url - Request URL
 * @returns Invoice ID if found, null otherwise
 */
export function extractInvoiceIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split("/").filter(Boolean);

    // Look for common patterns like /invoice/:id or /pay/:id
    for (let i = 0; i < pathParts.length - 1; i++) {
      const part = pathParts[i];
      const nextPart = pathParts[i + 1];
      if (
        (part === "invoice" || part === "invoices" || part === "pay") &&
        nextPart &&
        nextPart.length > 0
      ) {
        return nextPart;
      }
    }

    // Check query parameters
    const invoiceId = parsed.searchParams.get("invoiceId");
    if (invoiceId) {
      return invoiceId;
    }

    const invoiceIdAlt = parsed.searchParams.get("invoice_id");
    if (invoiceIdAlt) {
      return invoiceIdAlt;
    }

    return null;
  } catch {
    return null;
  }
}
