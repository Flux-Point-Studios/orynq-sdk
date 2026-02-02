/**
 * @summary Request hashing utilities for idempotency and deduplication.
 *
 * This file provides functions to generate deterministic hashes of HTTP
 * requests using RFC 8785 canonical JSON. These hashes are used to detect
 * duplicate requests and implement idempotency without requiring client-
 * provided keys.
 *
 * The hash algorithm:
 * 1. Normalize the request (method, URL, body)
 * 2. Serialize to RFC 8785 canonical JSON
 * 3. Compute SHA256 hash
 * 4. Return hex-encoded hash
 *
 * Used by:
 * - Express middleware for request deduplication
 * - Fastify plugin for request deduplication
 * - Invoice store for finding existing invoices
 */

import { canonicalize, sha256StringHex } from "@fluxpointstudios/poi-sdk-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for request hash generation.
 */
export interface RequestHashOptions {
  /**
   * Fields to exclude from the body when hashing.
   * Useful for ignoring timestamps or other variable fields.
   */
  excludeBodyFields?: string[];

  /**
   * Whether to include query parameters in the hash.
   * @default true
   */
  includeQuery?: boolean;

  /**
   * Whether to normalize the URL path (lowercase, remove trailing slash).
   * @default true
   */
  normalizePath?: boolean;

  /**
   * Hash length in characters (truncates SHA256).
   * @default 32 (128 bits of entropy)
   */
  hashLength?: number;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Generate a hash of an HTTP request for idempotency.
 *
 * Creates a deterministic hash from the request method, URL, and body.
 * The same request content will always produce the same hash.
 *
 * @param method - HTTP method (GET, POST, etc.)
 * @param url - Request URL (with or without query parameters)
 * @param body - Request body (object, string, or undefined)
 * @param options - Hash generation options
 * @returns Promise resolving to hex-encoded hash string
 *
 * @example
 * ```typescript
 * const hash = await hashRequest(
 *   "POST",
 *   "/api/protected",
 *   { amount: "1000", asset: "ADA" }
 * );
 * // "a1b2c3d4..."
 * ```
 */
export async function hashRequest(
  method: string,
  url: string,
  body?: unknown,
  options: RequestHashOptions = {}
): Promise<string> {
  const {
    excludeBodyFields = [],
    includeQuery = true,
    normalizePath = true,
    hashLength = 32,
  } = options;

  // Normalize method
  const normalizedMethod = method.toUpperCase();

  // Normalize URL
  const normalizedUrl = normalizeUrl(url, {
    includeQuery,
    normalizePath,
  });

  // Normalize body
  const normalizedBody = normalizeBody(body, excludeBodyFields);

  // Build hash input
  const input = {
    method: normalizedMethod,
    url: normalizedUrl,
    body: normalizedBody,
  };

  // Canonicalize and hash
  const canonical = canonicalize(input);
  const fullHash = await sha256StringHex(canonical);

  // Truncate to requested length
  return fullHash.slice(0, Math.min(hashLength, 64));
}

/**
 * Synchronous version of hashRequest that returns a hash synchronously.
 *
 * Note: This uses a blocking hash computation which may not be suitable
 * for high-throughput scenarios. Prefer the async version when possible.
 *
 * @param method - HTTP method
 * @param url - Request URL
 * @param body - Request body
 * @param options - Hash generation options
 * @returns Hex-encoded hash string (computed asynchronously in the background)
 *
 * @deprecated Use hashRequest for better performance
 */
export function hashRequestSync(
  method: string,
  url: string,
  body?: unknown,
  options: RequestHashOptions = {}
): string {
  const {
    excludeBodyFields = [],
    includeQuery = true,
    normalizePath = true,
    hashLength = 32,
  } = options;

  // Normalize inputs
  const normalizedMethod = method.toUpperCase();
  const normalizedUrl = normalizeUrl(url, { includeQuery, normalizePath });
  const normalizedBody = normalizeBody(body, excludeBodyFields);

  // Build and canonicalize
  const input = { method: normalizedMethod, url: normalizedUrl, body: normalizedBody };
  const canonical = canonicalize(input);

  // Simple hash for sync usage (not cryptographically strong, but deterministic)
  // For proper security, use the async version
  let hash = 0;
  for (let i = 0; i < canonical.length; i++) {
    const char = canonical.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }

  // Convert to hex-like string
  const hex = Math.abs(hash).toString(16).padStart(8, "0");
  return hex.repeat(4).slice(0, hashLength);
}

/**
 * Check if two requests produce the same hash.
 *
 * @param req1 - First request
 * @param req2 - Second request
 * @param options - Hash generation options
 * @returns Promise resolving to true if requests are equivalent
 */
export async function requestsEqual(
  req1: { method: string; url: string; body?: unknown },
  req2: { method: string; url: string; body?: unknown },
  options?: RequestHashOptions
): Promise<boolean> {
  const [hash1, hash2] = await Promise.all([
    hashRequest(req1.method, req1.url, req1.body, options),
    hashRequest(req2.method, req2.url, req2.body, options),
  ]);

  return hash1 === hash2;
}

// ---------------------------------------------------------------------------
// URL Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a URL for consistent hashing.
 */
function normalizeUrl(
  url: string,
  options: { includeQuery: boolean; normalizePath: boolean }
): string {
  try {
    // Parse as URL if it's a full URL
    if (url.startsWith("http://") || url.startsWith("https://")) {
      const parsed = new URL(url);

      let path = parsed.pathname;

      // Normalize path
      if (options.normalizePath) {
        path = path.toLowerCase();
        // Remove trailing slash (except for root)
        if (path.length > 1 && path.endsWith("/")) {
          path = path.slice(0, -1);
        }
      }

      // Include or exclude query
      if (options.includeQuery && parsed.search) {
        // Sort query parameters for consistency
        const params = new URLSearchParams(parsed.search);
        const sortedParams = new URLSearchParams([...params.entries()].sort());
        return `${path}?${sortedParams.toString()}`;
      }

      return path;
    }

    // Handle relative URLs / paths
    let path = url;

    // Split path and query
    const queryIndex = path.indexOf("?");
    let query = "";

    if (queryIndex !== -1) {
      query = path.slice(queryIndex + 1);
      path = path.slice(0, queryIndex);
    }

    // Normalize path
    if (options.normalizePath) {
      path = path.toLowerCase();
      if (path.length > 1 && path.endsWith("/")) {
        path = path.slice(0, -1);
      }
    }

    // Include or exclude query
    if (options.includeQuery && query) {
      const params = new URLSearchParams(query);
      const sortedParams = new URLSearchParams([...params.entries()].sort());
      return `${path}?${sortedParams.toString()}`;
    }

    return path;
  } catch {
    // If parsing fails, return as-is
    return url;
  }
}

// ---------------------------------------------------------------------------
// Body Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize request body for consistent hashing.
 */
function normalizeBody(
  body: unknown,
  excludeFields: string[]
): unknown {
  if (body === undefined || body === null) {
    return null;
  }

  if (typeof body === "string") {
    // Try to parse as JSON
    try {
      const parsed = JSON.parse(body);
      return normalizeBody(parsed, excludeFields);
    } catch {
      // Return string as-is if not JSON
      return body;
    }
  }

  if (Array.isArray(body)) {
    return body.map((item) => normalizeBody(item, excludeFields));
  }

  if (typeof body === "object") {
    const normalized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      // Skip excluded fields
      if (excludeFields.includes(key)) {
        continue;
      }

      // Recursively normalize nested objects
      normalized[key] = normalizeBody(value, excludeFields);
    }

    return normalized;
  }

  // Return primitives as-is
  return body;
}

// ---------------------------------------------------------------------------
// Utility Exports
// ---------------------------------------------------------------------------

/**
 * Extract path from URL (without query string).
 */
export function extractPath(url: string): string {
  const queryIndex = url.indexOf("?");
  if (queryIndex !== -1) {
    return url.slice(0, queryIndex);
  }
  return url;
}

/**
 * Extract query string from URL.
 */
export function extractQuery(url: string): string | null {
  const queryIndex = url.indexOf("?");
  if (queryIndex !== -1) {
    return url.slice(queryIndex + 1);
  }
  return null;
}
