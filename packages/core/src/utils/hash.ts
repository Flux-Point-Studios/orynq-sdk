/**
 * @summary SHA256 hashing utilities using Web Crypto API.
 *
 * This file provides SHA256 hashing functions that work in both browser and
 * Node.js environments using the Web Crypto API (SubtleCrypto). No external
 * dependencies are required.
 *
 * The idempotency key generation follows a deterministic algorithm to ensure
 * the same request always produces the same key, enabling duplicate detection
 * across retries and server restarts.
 *
 * Used by:
 * - Idempotency key generation for payment requests
 * - Payment request hashing for signatures
 * - Content integrity verification
 */

import { canonicalize } from "./canonical-json.js";

// ---------------------------------------------------------------------------
// Core Hash Functions
// ---------------------------------------------------------------------------

/**
 * Compute SHA256 hash of a Uint8Array.
 *
 * @param data - Data to hash
 * @returns Promise resolving to hash as Uint8Array
 *
 * @example
 * const hash = await sha256(new TextEncoder().encode("hello"));
 */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // Use Web Crypto API (available in Node 18+ and all modern browsers)
  // Create a copy to ensure we have a regular ArrayBuffer (not SharedArrayBuffer)
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return new Uint8Array(hashBuffer);
}

/**
 * Compute SHA256 hash of a string (UTF-8 encoded).
 *
 * @param text - Text to hash
 * @returns Promise resolving to hash as Uint8Array
 *
 * @example
 * const hash = await sha256String("hello world");
 */
export async function sha256String(text: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  return sha256(encoder.encode(text));
}

/**
 * Compute SHA256 hash and return as hex string.
 *
 * @param data - Data to hash
 * @returns Promise resolving to hash as lowercase hex string
 *
 * @example
 * const hex = await sha256Hex(new TextEncoder().encode("hello"));
 * // "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = await sha256(data);
  return bytesToHex(hash);
}

/**
 * Compute SHA256 hash of a string and return as hex.
 *
 * @param text - Text to hash
 * @returns Promise resolving to hash as lowercase hex string
 *
 * @example
 * const hex = await sha256StringHex("hello");
 * // "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
 */
export async function sha256StringHex(text: string): Promise<string> {
  const hash = await sha256String(text);
  return bytesToHex(hash);
}

// ---------------------------------------------------------------------------
// Idempotency Key Generation
// ---------------------------------------------------------------------------

/**
 * Options for idempotency key generation.
 */
export interface IdempotencyKeyOptions {
  /**
   * Include timestamp in key (makes each request unique).
   * Set to false for deterministic keys based only on content.
   * @default false
   */
  includeTimestamp?: boolean;

  /**
   * Prefix to add to the generated key.
   * Useful for namespacing keys by service or client.
   */
  prefix?: string;

  /**
   * Hash output length in characters (truncates the full hash).
   * Full SHA256 is 64 hex chars; shorter keys may have collisions.
   * @default 32 (128 bits of entropy)
   */
  length?: number;
}

/**
 * Generate an idempotency key from request parameters.
 *
 * The key is derived from SHA256(canonical(method + url + body)).
 * This ensures the same request content always produces the same key.
 *
 * @param method - HTTP method (GET, POST, etc.)
 * @param url - Request URL
 * @param body - Request body (will be canonicalized if object)
 * @param options - Generation options
 * @returns Promise resolving to idempotency key string
 *
 * @example
 * const key = await generateIdempotencyKey(
 *   "POST",
 *   "https://api.example.com/pay",
 *   { amount: "1000000", asset: "ADA" }
 * );
 * // "idem_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"
 */
export async function generateIdempotencyKey(
  method: string,
  url: string,
  body?: unknown,
  options: IdempotencyKeyOptions = {}
): Promise<string> {
  const { includeTimestamp = false, prefix = "idem", length = 32 } = options;

  // Build the input for hashing
  const input: Record<string, unknown> = {
    method: method.toUpperCase(),
    url: normalizeUrl(url),
  };

  // Add body if present
  if (body !== undefined && body !== null) {
    input["body"] = body;
  }

  // Add timestamp if requested
  if (includeTimestamp) {
    input["timestamp"] = Date.now();
  }

  // Canonicalize and hash
  const canonical = canonicalize(input);
  const hash = await sha256StringHex(canonical);

  // Truncate to requested length
  const truncated = hash.slice(0, Math.min(length, 64));

  // Add prefix
  return prefix ? `${prefix}_${truncated}` : truncated;
}

/**
 * Normalize a URL for consistent hashing.
 * Removes default ports and trailing slashes.
 *
 * @param url - URL to normalize
 * @returns Normalized URL string
 */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);

    // Remove default ports
    if (
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")
    ) {
      parsed.port = "";
    }

    // Remove trailing slash from pathname (except root)
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    return parsed.toString();
  } catch {
    // If URL parsing fails, return as-is
    return url;
  }
}

// ---------------------------------------------------------------------------
// Hex Encoding Utilities
// ---------------------------------------------------------------------------

/**
 * Convert bytes to lowercase hex string.
 *
 * @param bytes - Bytes to encode
 * @returns Lowercase hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Convert hex string to bytes.
 *
 * @param hex - Hex string (with or without 0x prefix)
 * @returns Decoded bytes
 * @throws Error if hex string is invalid
 */
export function hexToBytes(hex: string): Uint8Array {
  // Remove 0x prefix if present
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;

  // Validate hex string
  if (cleanHex.length % 2 !== 0) {
    throw new Error("Hex string must have even length");
  }
  if (!/^[0-9a-fA-F]*$/.test(cleanHex)) {
    throw new Error("Invalid hex character");
  }

  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Check if a string is a valid hex string.
 *
 * @param value - String to check
 * @param expectedLength - Expected byte length (optional)
 * @returns true if valid hex string
 */
export function isValidHex(value: string, expectedLength?: number): boolean {
  const cleanHex = value.startsWith("0x") ? value.slice(2) : value;

  if (!/^[0-9a-fA-F]*$/.test(cleanHex)) {
    return false;
  }

  if (cleanHex.length % 2 !== 0) {
    return false;
  }

  if (expectedLength !== undefined && cleanHex.length !== expectedLength * 2) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Base64 Encoding Utilities
// ---------------------------------------------------------------------------

/**
 * Convert bytes to base64 string.
 *
 * @param bytes - Bytes to encode
 * @returns Base64 encoded string
 */
export function bytesToBase64(bytes: Uint8Array): string {
  // Use btoa which is available in browsers and Node 18+
  const binary = String.fromCharCode(...bytes);
  return btoa(binary);
}

/**
 * Convert base64 string to bytes.
 *
 * @param base64 - Base64 encoded string
 * @returns Decoded bytes
 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Convert bytes to URL-safe base64 string.
 *
 * @param bytes - Bytes to encode
 * @returns URL-safe base64 encoded string
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * Convert URL-safe base64 string to bytes.
 *
 * @param base64url - URL-safe base64 encoded string
 * @returns Decoded bytes
 */
export function base64UrlToBytes(base64url: string): Uint8Array {
  // Convert URL-safe to standard base64
  let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");

  // Add padding if necessary
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }

  return base64ToBytes(base64);
}

// ---------------------------------------------------------------------------
// Content Hash Utilities
// ---------------------------------------------------------------------------

/**
 * Generate a content hash for integrity verification.
 *
 * @param content - Content to hash (string or bytes)
 * @returns Promise resolving to hash object with algorithm and value
 */
export async function generateContentHash(
  content: string | Uint8Array
): Promise<{ algorithm: "sha256"; value: string }> {
  const data =
    typeof content === "string" ? new TextEncoder().encode(content) : content;

  const hash = await sha256Hex(data);

  return {
    algorithm: "sha256",
    value: hash,
  };
}

/**
 * Verify content against a hash.
 *
 * @param content - Content to verify
 * @param expectedHash - Expected hash value (hex string)
 * @returns Promise resolving to true if content matches hash
 */
export async function verifyContentHash(
  content: string | Uint8Array,
  expectedHash: string
): Promise<boolean> {
  const data =
    typeof content === "string" ? new TextEncoder().encode(content) : content;

  const actualHash = await sha256Hex(data);

  // Constant-time comparison to prevent timing attacks
  return constantTimeEqual(actualHash, expectedHash.toLowerCase());
}

/**
 * Constant-time string comparison.
 * Prevents timing attacks by always comparing all characters.
 *
 * @param a - First string
 * @param b - Second string
 * @returns true if strings are equal
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}
