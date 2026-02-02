/**
 * @summary Central export point for utility functions in @fluxpointstudios/orynq-sdk-core.
 *
 * This file re-exports all utility functions from the utils subdirectory.
 * These utilities handle JSON canonicalization, hashing, and encoding
 * operations needed throughout the SDK.
 *
 * Usage:
 * ```typescript
 * import { canonicalize, sha256Hex, generateIdempotencyKey } from "@fluxpointstudios/orynq-sdk-core/utils";
 * ```
 */

// ---------------------------------------------------------------------------
// Canonical JSON Utilities
// ---------------------------------------------------------------------------

export type { JsonValue, CanonicalizeOptions } from "./canonical-json.js";

export {
  canonicalize,
  parseCanonical,
  canonicalEquals,
  normalizeJson,
  sortObjectKeys,
  isCanonical,
} from "./canonical-json.js";

// ---------------------------------------------------------------------------
// Hash Utilities
// ---------------------------------------------------------------------------

export type { IdempotencyKeyOptions } from "./hash.js";

export {
  // Core hash functions
  sha256,
  sha256String,
  sha256Hex,
  sha256StringHex,
  // Idempotency key generation
  generateIdempotencyKey,
  // Hex encoding
  bytesToHex,
  hexToBytes,
  isValidHex,
  // Base64 encoding
  bytesToBase64,
  base64ToBytes,
  bytesToBase64Url,
  base64UrlToBytes,
  // Content hashing
  generateContentHash,
  verifyContentHash,
} from "./hash.js";
