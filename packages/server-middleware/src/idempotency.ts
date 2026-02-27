/**
 * @summary Idempotency key handling for payment requests.
 *
 * This file provides utilities for handling idempotency keys in payment
 * requests. Idempotency keys ensure that retried requests don't result
 * in duplicate payments by allowing the server to recognize and return
 * cached responses for repeated requests.
 *
 * Key sources (in order of priority):
 * 1. Client-provided Idempotency-Key header
 * 2. Request hash (computed from method + URL + body)
 *
 * Used by:
 * - Express middleware for idempotency handling
 * - Fastify plugin for idempotency handling
 */

import { FLUX_HEADERS } from "@fluxpointstudios/orynq-sdk-core";
import { hashRequest, type RequestHashOptions } from "./request-hash.js";
import type { Invoice, InvoiceStore } from "./invoice-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for idempotency handling.
 */
export interface IdempotencyConfig {
  /**
   * Header name to read idempotency key from.
   * @default "X-Idempotency-Key"
   */
  headerName?: string;

  /**
   * Whether to generate keys from request hash when no header is provided.
   * @default true
   */
  generateFromRequest?: boolean;

  /**
   * Options for request hash generation.
   */
  hashOptions?: RequestHashOptions;

  /**
   * Maximum length for idempotency keys.
   * Keys longer than this will be truncated.
   * @default 128
   */
  maxKeyLength?: number;

  /**
   * Prefix to add to generated keys.
   * @default "auto_"
   */
  generatedKeyPrefix?: string;
}

/**
 * Result of idempotency key lookup.
 */
export interface IdempotencyResult {
  /**
   * The idempotency key used (provided or generated).
   */
  key: string;

  /**
   * Whether the key was provided by the client or generated.
   */
  source: "header" | "generated" | "request-hash";

  /**
   * Existing invoice if this is a duplicate request.
   */
  existingInvoice?: Invoice;

  /**
   * Whether this request should be treated as a duplicate.
   */
  isDuplicate: boolean;
}

// ---------------------------------------------------------------------------
// Request Interface
// ---------------------------------------------------------------------------

/**
 * Minimal request interface for idempotency handling.
 */
interface HttpRequest {
  method: string;
  url: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined> | Headers;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Extract idempotency key from request headers.
 *
 * @param req - HTTP request
 * @param headerName - Header name to look for
 * @returns Idempotency key or undefined if not present
 */
export function extractIdempotencyKey(
  req: HttpRequest,
  headerName: string = FLUX_HEADERS.IDEMPOTENCY_KEY
): string | undefined {
  const normalizedHeader = headerName.toLowerCase();

  // Handle Headers object
  if (req.headers instanceof Headers) {
    return req.headers.get(normalizedHeader) ?? undefined;
  }

  // Handle plain object
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.toLowerCase() === normalizedHeader) {
      return Array.isArray(value) ? value[0] : value;
    }
  }

  return undefined;
}

/**
 * Process idempotency for a request.
 *
 * Checks for an existing invoice using the idempotency key or request hash,
 * and returns information about whether this is a duplicate request.
 *
 * @param req - HTTP request
 * @param store - Invoice store to check for existing invoices
 * @param config - Idempotency configuration
 * @returns Promise resolving to idempotency result
 *
 * @example
 * ```typescript
 * const result = await processIdempotency(req, store, {
 *   headerName: "X-Idempotency-Key",
 * });
 *
 * if (result.isDuplicate && result.existingInvoice) {
 *   // Return cached response
 *   return res.status(200).json({ invoiceId: result.existingInvoice.id });
 * }
 *
 * // Process new request
 * const invoice = await store.create({
 *   idempotencyKey: result.key,
 *   // ...
 * });
 * ```
 */
export async function processIdempotency(
  req: HttpRequest,
  store: InvoiceStore,
  config: IdempotencyConfig = {}
): Promise<IdempotencyResult> {
  const {
    headerName = FLUX_HEADERS.IDEMPOTENCY_KEY,
    generateFromRequest = true,
    hashOptions = {},
    maxKeyLength = 128,
    generatedKeyPrefix = "auto_",
  } = config;

  // Try to get key from header
  let key = extractIdempotencyKey(req, headerName);
  let source: IdempotencyResult["source"] = "header";

  if (key) {
    // Truncate if too long
    key = key.slice(0, maxKeyLength);

    // Check for existing invoice
    const existingInvoice = await store.findByIdempotencyKey(key);

    if (existingInvoice) {
      return {
        key,
        source,
        existingInvoice,
        isDuplicate: true,
      };
    }

    return {
      key,
      source,
      isDuplicate: false,
    };
  }

  // Generate key from request hash if enabled
  if (generateFromRequest) {
    const hash = await hashRequest(req.method, req.url, req.body, hashOptions);
    key = `${generatedKeyPrefix}${hash}`;
    source = "request-hash";

    // Check for existing invoice by request hash
    const existingInvoice = await store.findByRequestHash(hash);

    if (existingInvoice) {
      return {
        key,
        source,
        existingInvoice,
        isDuplicate: true,
      };
    }

    return {
      key,
      source,
      isDuplicate: false,
    };
  }

  // Generate a random key as fallback
  key = `${generatedKeyPrefix}${generateRandomKey()}`;
  source = "generated";

  return {
    key,
    source,
    isDuplicate: false,
  };
}

/**
 * Check if a request is a duplicate based on idempotency.
 *
 * Simple helper that returns true if the request matches an existing invoice.
 *
 * @param req - HTTP request
 * @param store - Invoice store to check
 * @param config - Idempotency configuration
 * @returns Promise resolving to existing invoice or null
 */
export async function findDuplicateInvoice(
  req: HttpRequest,
  store: InvoiceStore,
  config: IdempotencyConfig = {}
): Promise<Invoice | null> {
  const result = await processIdempotency(req, store, config);
  return result.existingInvoice ?? null;
}

/**
 * Validate an idempotency key format.
 *
 * Keys must be non-empty strings containing only allowed characters.
 *
 * @param key - Idempotency key to validate
 * @param maxLength - Maximum allowed length
 * @returns true if key is valid
 */
export function isValidIdempotencyKey(key: string, maxLength: number = 128): boolean {
  if (!key || typeof key !== "string") {
    return false;
  }

  if (key.length > maxLength) {
    return false;
  }

  // Allow alphanumeric, hyphen, underscore, and period
  if (!/^[a-zA-Z0-9._-]+$/.test(key)) {
    return false;
  }

  return true;
}

/**
 * Normalize an idempotency key.
 *
 * Trims whitespace and converts to lowercase for consistent comparison.
 *
 * @param key - Key to normalize
 * @returns Normalized key
 */
export function normalizeIdempotencyKey(key: string): string {
  return key.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Internal Utilities
// ---------------------------------------------------------------------------

/**
 * Generate a random idempotency key.
 */
function generateRandomKey(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  // Fallback
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
