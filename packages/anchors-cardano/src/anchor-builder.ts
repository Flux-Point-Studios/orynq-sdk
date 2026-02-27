/**
 * @fileoverview Anchor builder for Cardano blockchain anchoring.
 *
 * Location: packages/anchors-cardano/src/anchor-builder.ts
 *
 * This module provides functions to build Cardano transaction metadata for PoI
 * (Proof-of-Intent) anchors using metadata label 2222. It handles the construction,
 * validation, and serialization of anchor entries from trace bundles.
 *
 * Key functions:
 * - buildAnchorMetadata: Build metadata for a single anchor entry
 * - buildBatchAnchorMetadata: Build metadata for multiple entries
 * - createAnchorEntryFromBundle: Create anchor entry from TraceBundle
 * - validateAnchorEntry: Validate anchor entry fields and format
 * - serializeForCardanoCli: Serialize for cardano-cli --metadata-json-file
 * - serializeForCbor: Serialize with 64-byte string limit handling
 *
 * Used by:
 * - Consumer applications anchoring traces to Cardano
 * - Integration with Mesh, Lucid, or cardano-serialization-lib
 * - CLI tools for batch anchoring operations
 *
 * @see https://github.com/Flux-Point-Studios/orynq-sdk for specification
 */

import type {
  AnchorEntry,
  AnchorMetadata,
  AnchorTxResult,
  AnchorType,
  CreateAnchorEntryOptions,
} from "./types.js";
import { POI_METADATA_LABEL, isAnchorType } from "./types.js";
import type { TraceBundle, TraceManifest } from "@fluxpointstudios/orynq-sdk-process-trace";

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Maximum bytes allowed per string in Cardano metadata.
 * Strings exceeding this limit must be split into arrays.
 */
const CARDANO_METADATA_STRING_LIMIT = 64;

/**
 * Valid anchor types for validation.
 */
const VALID_ANCHOR_TYPES: readonly AnchorType[] = [
  "process-trace",
  "proof-of-intent",
  "custom",
] as const;

/**
 * Regex pattern for validating hash strings with optional sha256: prefix.
 * Accepts either raw 64-char hex or "sha256:<64-char hex>".
 */
const HASH_STRING_PATTERN = /^(sha256:)?[a-f0-9]{64}$/;

/**
 * Regex pattern for validating ISO 8601 timestamps.
 * Matches formats like: 2024-01-28T12:00:00Z or 2024-01-28T12:00:00.000Z
 */
const ISO_8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

// =============================================================================
// VALIDATION RESULT TYPE
// =============================================================================

/**
 * Result of anchor entry validation.
 */
export interface ValidationResult {
  /** Whether the entry passed all validation checks. */
  valid: boolean;
  /** List of validation error messages. Empty if valid. */
  errors: string[];
}

// =============================================================================
// BUILD FUNCTIONS
// =============================================================================

/**
 * Build anchor metadata for a single entry.
 *
 * Creates the complete metadata structure ready to embed in a Cardano
 * transaction under label 2222. The metadata follows the poi-anchor-v1 schema.
 *
 * @param entry - The anchor entry to embed in metadata.
 * @returns AnchorTxResult containing label, metadata, and JSON representation.
 *
 * @example
 * ```typescript
 * const entry: AnchorEntry = {
 *   type: "process-trace",
 *   version: "1.0",
 *   rootHash: "abc123...",
 *   manifestHash: "def456...",
 *   timestamp: new Date().toISOString()
 * };
 * const result = buildAnchorMetadata(entry);
 * // Use with transaction builder:
 * // tx.setMetadata(result.label, result.json[result.label]);
 * ```
 */
export function buildAnchorMetadata(entry: AnchorEntry): AnchorTxResult {
  const metadata: AnchorMetadata = {
    schema: "poi-anchor-v1",
    anchors: [entry],
  };

  return {
    label: POI_METADATA_LABEL,
    metadata,
    json: { [POI_METADATA_LABEL]: metadata },
  };
}

/**
 * Build anchor metadata for multiple entries (batch).
 *
 * All entries are combined into a single metadata object under label 2222.
 * This is more efficient than separate transactions for multiple anchors.
 * Each entry is validated before building.
 *
 * @param entries - Array of anchor entries to batch together.
 * @returns AnchorTxResult containing all entries.
 * @throws Error if any entry fails validation.
 *
 * @example
 * ```typescript
 * const entries: AnchorEntry[] = [
 *   { type: "process-trace", version: "1.0", rootHash: "...", manifestHash: "...", timestamp: "..." },
 *   { type: "process-trace", version: "1.0", rootHash: "...", manifestHash: "...", timestamp: "..." }
 * ];
 * const result = buildBatchAnchorMetadata(entries);
 * ```
 */
export function buildBatchAnchorMetadata(entries: AnchorEntry[]): AnchorTxResult {
  if (entries.length === 0) {
    throw new Error("Cannot build batch metadata with empty entries array");
  }

  // Validate all entries before building
  const validationErrors: string[] = [];
  entries.forEach((entry, index) => {
    const validation = validateAnchorEntry(entry);
    if (!validation.valid) {
      validationErrors.push(
        `Entry ${index}: ${validation.errors.join("; ")}`
      );
    }
  });

  if (validationErrors.length > 0) {
    throw new Error(
      `Batch validation failed:\n${validationErrors.join("\n")}`
    );
  }

  const metadata: AnchorMetadata = {
    schema: "poi-anchor-v1",
    anchors: entries,
  };

  return {
    label: POI_METADATA_LABEL,
    metadata,
    json: { [POI_METADATA_LABEL]: metadata },
  };
}

// =============================================================================
// ENTRY CREATION
// =============================================================================

/**
 * Create an anchor entry from a trace bundle.
 *
 * Extracts the necessary hashes and metadata from a TraceBundle to create
 * an AnchorEntry ready for blockchain anchoring. The entry captures the
 * cryptographic commitments that bind the trace to the chain.
 *
 * Hash extraction:
 * - rootHash: Always extracted (required) - proves execution sequence
 * - manifestHash: Extracted if present on bundle
 * - merkleRoot: Extracted if options.includeMerkleRoot is true (default: true)
 *
 * @param bundle - The trace bundle to create an anchor entry from.
 * @param options - Optional configuration for entry creation.
 * @returns AnchorEntry ready to be anchored.
 * @throws Error if bundle is missing required rootHash.
 *
 * @example
 * ```typescript
 * import { finalizeBundle } from "@fluxpointstudios/orynq-sdk-process-trace";
 *
 * const bundle = await finalizeBundle(traceRun);
 * const entry = createAnchorEntryFromBundle(bundle, {
 *   storageUri: "ipfs://QmXyz...",
 *   agentId: "my-agent-v1",
 *   includeMerkleRoot: true
 * });
 * const result = buildAnchorMetadata(entry);
 * ```
 */
export function createAnchorEntryFromBundle(
  bundle: TraceBundle,
  options?: CreateAnchorEntryOptions
): AnchorEntry {
  // Validate bundle has required rootHash
  if (!bundle.rootHash) {
    throw new Error("Bundle is missing required rootHash");
  }

  // Validate bundle has required manifestHash
  // The manifestHash is required for on-chain anchoring as it binds to off-chain storage
  if (!bundle.manifestHash) {
    throw new Error(
      "Bundle is missing required manifestHash. Ensure the manifest has been created before anchoring."
    );
  }

  // Determine whether to include merkle root (default: true)
  const includeMerkleRoot = options?.includeMerkleRoot !== false;

  // Build the anchor entry
  const entry: AnchorEntry = {
    type: "process-trace",
    version: "1.0",
    rootHash: bundle.rootHash,
    manifestHash: bundle.manifestHash,
    timestamp: new Date().toISOString(),
  };

  // Include merkleRoot if requested and available
  if (includeMerkleRoot && bundle.merkleRoot) {
    entry.merkleRoot = bundle.merkleRoot;
  }

  // Include item count from public view if available
  if (bundle.publicView?.totalEvents !== undefined) {
    entry.itemCount = bundle.publicView.totalEvents;
  }

  // Include agentId from options or bundle
  const agentId = options?.agentId ?? bundle.privateRun?.agentId ?? bundle.publicView?.agentId;
  if (agentId) {
    entry.agentId = agentId;
  }

  // Include storageUri from options
  if (options?.storageUri) {
    entry.storageUri = options.storageUri;
  }

  return entry;
}

/**
 * Create an anchor entry from a trace manifest.
 *
 * This is useful when you have already created a manifest for off-chain storage
 * and want to create an anchor entry for on-chain commitment. The manifest
 * already contains all the necessary cryptographic hashes.
 *
 * @param manifest - The trace manifest to create an anchor entry from.
 * @param opts - Optional configuration for entry creation.
 * @param opts.storageUri - URI where the manifest and chunks are stored.
 * @returns AnchorEntry ready to be anchored.
 * @throws Error if manifest is missing required manifestHash.
 *
 * @example
 * ```typescript
 * import { createManifest } from "@fluxpointstudios/orynq-sdk-process-trace";
 *
 * const { manifest, chunks } = await createManifest(bundle);
 * // Store manifest and chunks to IPFS/Arweave...
 *
 * const entry = createAnchorEntryFromManifest(manifest, {
 *   storageUri: "ipfs://QmXyz...",
 * });
 * const result = buildAnchorMetadata(entry);
 * ```
 */
export function createAnchorEntryFromManifest(
  manifest: TraceManifest,
  opts?: { storageUri?: string }
): AnchorEntry {
  // Validate manifest has required manifestHash
  if (!manifest.manifestHash) {
    throw new Error(
      "Manifest is missing required manifestHash. Ensure the manifest has been finalized before anchoring."
    );
  }

  // Build the anchor entry with required fields
  const entry: AnchorEntry = {
    type: "process-trace",
    version: "1.0",
    rootHash: manifest.rootHash,
    manifestHash: manifest.manifestHash,
    timestamp: new Date().toISOString(),
  };

  // Include merkleRoot if available
  if (manifest.merkleRoot) {
    entry.merkleRoot = manifest.merkleRoot;
  }

  // Include item count
  if (manifest.totalEvents !== undefined) {
    entry.itemCount = manifest.totalEvents;
  }

  // Include agentId if available
  if (manifest.agentId) {
    entry.agentId = manifest.agentId;
  }

  // Include storageUri from options
  if (opts?.storageUri) {
    entry.storageUri = opts.storageUri;
  }

  return entry;
}

// =============================================================================
// VALIDATION
// =============================================================================

/**
 * Validate an anchor entry has all required fields and correct format.
 *
 * Performs comprehensive validation including:
 * - Required field presence (type, version, rootHash, manifestHash, timestamp)
 * - Hash format validation (64-char lowercase hex, with optional sha256: prefix)
 * - Timestamp format validation (ISO 8601)
 * - Type validation (must be valid AnchorType)
 *
 * @param entry - The anchor entry to validate.
 * @returns ValidationResult with valid flag and error messages.
 *
 * @example
 * ```typescript
 * const entry: AnchorEntry = {
 *   type: "process-trace",
 *   version: "1.0",
 *   rootHash: "abc123...",
 *   manifestHash: "def456...",
 *   timestamp: "2024-01-28T12:00:00Z"
 * };
 *
 * const result = validateAnchorEntry(entry);
 * if (!result.valid) {
 *   console.error("Validation errors:", result.errors);
 * }
 * ```
 */
export function validateAnchorEntry(entry: AnchorEntry): ValidationResult {
  const errors: string[] = [];

  // Check required fields exist
  if (entry.type === undefined || entry.type === null) {
    errors.push("Missing required field: type");
  } else if (!isAnchorType(entry.type)) {
    errors.push(
      `Invalid type "${entry.type}". Must be one of: ${VALID_ANCHOR_TYPES.join(", ")}`
    );
  }

  if (entry.version === undefined || entry.version === null) {
    errors.push("Missing required field: version");
  } else if (entry.version !== "1.0") {
    errors.push(`Invalid version "${entry.version}". Must be "1.0"`);
  }

  if (entry.rootHash === undefined || entry.rootHash === null) {
    errors.push("Missing required field: rootHash");
  } else if (typeof entry.rootHash !== "string") {
    errors.push("rootHash must be a string");
  } else if (!isValidHashString(entry.rootHash)) {
    errors.push(
      "Invalid rootHash format. Must be 64-char lowercase hex or sha256:<64-char hex>"
    );
  }

  if (entry.manifestHash === undefined || entry.manifestHash === null) {
    errors.push("Missing required field: manifestHash");
  } else if (typeof entry.manifestHash !== "string") {
    errors.push("manifestHash must be a string");
  } else if (!isValidHashString(entry.manifestHash)) {
    errors.push(
      "Invalid manifestHash format. Must be 64-char lowercase hex or sha256:<64-char hex>"
    );
  }

  if (entry.timestamp === undefined || entry.timestamp === null) {
    errors.push("Missing required field: timestamp");
  } else if (typeof entry.timestamp !== "string") {
    errors.push("timestamp must be a string");
  } else if (!isValidISO8601(entry.timestamp)) {
    errors.push(
      `Invalid timestamp format "${entry.timestamp}". Must be ISO 8601 (e.g., 2024-01-28T12:00:00Z)`
    );
  }

  // Validate optional fields if present
  if (entry.merkleRoot !== undefined && entry.merkleRoot !== null) {
    if (typeof entry.merkleRoot !== "string") {
      errors.push("merkleRoot must be a string");
    } else if (!isValidHashString(entry.merkleRoot)) {
      errors.push(
        "Invalid merkleRoot format. Must be 64-char lowercase hex or sha256:<64-char hex>"
      );
    }
  }

  if (entry.itemCount !== undefined && entry.itemCount !== null) {
    if (typeof entry.itemCount !== "number") {
      errors.push("itemCount must be a number");
    } else if (!Number.isInteger(entry.itemCount) || entry.itemCount < 0) {
      errors.push("itemCount must be a non-negative integer");
    }
  }

  if (entry.agentId !== undefined && entry.agentId !== null) {
    if (typeof entry.agentId !== "string") {
      errors.push("agentId must be a string");
    } else if (entry.agentId.length === 0) {
      errors.push("agentId cannot be empty if provided");
    }
  }

  if (entry.storageUri !== undefined && entry.storageUri !== null) {
    if (typeof entry.storageUri !== "string") {
      errors.push("storageUri must be a string");
    } else if (entry.storageUri.length === 0) {
      errors.push("storageUri cannot be empty if provided");
    } else if (!isValidStorageUri(entry.storageUri)) {
      errors.push(
        "Invalid storageUri. Must start with ipfs://, ar://, or https://"
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// =============================================================================
// SERIALIZATION
// =============================================================================

/**
 * Serialize anchor metadata to the format expected by cardano-cli.
 *
 * Returns a JSON string ready for use with cardano-cli --metadata-json-file.
 * The format is a JSON object with the metadata label as the top-level key.
 *
 * @param result - The anchor transaction result to serialize.
 * @returns JSON string for cardano-cli metadata file.
 *
 * @example
 * ```typescript
 * const result = buildAnchorMetadata(entry);
 * const cliJson = serializeForCardanoCli(result);
 *
 * // Write to file for cardano-cli
 * fs.writeFileSync("metadata.json", cliJson);
 *
 * // Use with cardano-cli:
 * // cardano-cli transaction build ... --metadata-json-file metadata.json
 * ```
 */
export function serializeForCardanoCli(result: AnchorTxResult): string {
  return JSON.stringify({ [result.label]: result.metadata }, null, 2);
}

/**
 * Serialize anchor metadata to CBOR-compatible JSON.
 *
 * Cardano metadata has a 64-byte limit per string. This function handles
 * splitting long strings into arrays of chunks, each <= 64 bytes.
 *
 * The output is suitable for CBOR encoding and submission to the Cardano
 * blockchain via any transaction building library.
 *
 * @param result - The anchor transaction result to serialize.
 * @returns CBOR-compatible JSON object with chunked strings.
 *
 * @example
 * ```typescript
 * const result = buildAnchorMetadata(entry);
 * const cborCompatible = serializeForCbor(result);
 *
 * // Use with cardano-serialization-lib or similar
 * const metadata = TransactionMetadata.from_json(JSON.stringify(cborCompatible));
 * ```
 */
export function serializeForCbor(result: AnchorTxResult): Record<string, unknown> {
  const cborCompatibleMetadata = processValueForCbor(result.metadata);
  return { [result.label]: cborCompatibleMetadata };
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if a string is a valid hash (64-char hex with optional sha256: prefix).
 *
 * @param value - String to validate.
 * @returns True if valid hash format.
 */
function isValidHashString(value: string): boolean {
  return HASH_STRING_PATTERN.test(value.toLowerCase());
}

/**
 * Check if a string is a valid ISO 8601 timestamp.
 *
 * @param value - String to validate.
 * @returns True if valid ISO 8601 format.
 */
function isValidISO8601(value: string): boolean {
  // First check pattern
  if (!ISO_8601_PATTERN.test(value)) {
    return false;
  }

  // Then verify it parses to a valid date
  const parsed = Date.parse(value);
  return !isNaN(parsed);
}

/**
 * Check if a string is a valid storage URI.
 *
 * Valid schemes: ipfs://, ar://, https://
 *
 * @param value - String to validate.
 * @returns True if valid storage URI.
 */
function isValidStorageUri(value: string): boolean {
  return (
    value.startsWith("ipfs://") ||
    value.startsWith("ar://") ||
    value.startsWith("https://")
  );
}

/**
 * Process a value for CBOR serialization, handling the 64-byte string limit.
 *
 * - Strings > 64 bytes are split into arrays of chunks
 * - Objects are recursively processed
 * - Arrays have each element processed
 * - Primitives (numbers, booleans, null) pass through unchanged
 *
 * @param value - Value to process.
 * @returns CBOR-compatible value.
 */
function processValueForCbor(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return splitStringForCbor(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => processValueForCbor(item));
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = processValueForCbor(val);
    }
    return result;
  }

  // Fallback: return as-is
  return value;
}

/**
 * Split a string into chunks of max 64 bytes for CBOR encoding.
 *
 * If the string fits within 64 bytes, returns it unchanged.
 * Otherwise, returns an array of chunks, each <= 64 bytes.
 *
 * Uses byte length (not character length) to handle UTF-8 properly.
 *
 * @param str - String to potentially split.
 * @returns Original string or array of chunks.
 */
function splitStringForCbor(str: string): string | string[] {
  // Check byte length using TextEncoder
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);

  if (bytes.length <= CARDANO_METADATA_STRING_LIMIT) {
    return str;
  }

  // Split into chunks of max 64 bytes
  const chunks: string[] = [];
  let currentChunk = "";
  let currentBytes = 0;

  for (const char of str) {
    const charBytes = encoder.encode(char).length;

    if (currentBytes + charBytes > CARDANO_METADATA_STRING_LIMIT) {
      // Push current chunk and start new one
      chunks.push(currentChunk);
      currentChunk = char;
      currentBytes = charBytes;
    } else {
      currentChunk += char;
      currentBytes += charBytes;
    }
  }

  // Push final chunk
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Extract the raw hex hash from a hash string.
 *
 * Removes the optional "sha256:" prefix if present.
 *
 * @param hashString - Hash string with optional prefix.
 * @returns Raw 64-character hex string.
 */
export function extractRawHash(hashString: string): string {
  if (hashString.toLowerCase().startsWith("sha256:")) {
    return hashString.slice(7).toLowerCase();
  }
  return hashString.toLowerCase();
}

/**
 * Normalize a hash string to include the sha256: prefix.
 *
 * @param hashString - Hash string with or without prefix.
 * @returns Hash string with sha256: prefix.
 */
export function normalizeHashWithPrefix(hashString: string): string {
  const raw = extractRawHash(hashString);
  return `sha256:${raw}`;
}
