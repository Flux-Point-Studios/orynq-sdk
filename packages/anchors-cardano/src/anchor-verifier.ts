/**
 * @fileoverview Anchor verification for Cardano blockchain.
 *
 * Location: packages/anchors-cardano/src/anchor-verifier.ts
 *
 * This module provides functions to verify PoI (Proof-of-Intent) anchors stored
 * in Cardano transaction metadata under label 2222. It implements defensive parsing
 * that handles malformed or adversarial data gracefully, supporting forward
 * compatibility with schema evolution.
 *
 * Key features:
 * - Parse anchor metadata with graceful error handling
 * - Verify anchors exist and match expected hashes
 * - Find all anchors in a transaction
 * - Validate hash formats
 *
 * Parsing rules:
 * 1. Unknown fields -> warn and ignore (forward compatibility)
 * 2. Missing required fields -> error, skip entry
 * 3. Invalid hash format -> error, skip entry
 * 4. Schema version mismatch -> warn if minor, error if major
 * 5. Multiple anchors in one tx -> parse all, return array
 *
 * Used by:
 * - Verification workflows that check on-chain anchor integrity
 * - Audit tools that need to parse anchor metadata
 * - Applications that search for anchors by hash
 *
 * @example
 * ```typescript
 * import { verifyAnchor, findAnchorsInTx } from "./anchor-verifier.js";
 *
 * // Verify a specific anchor
 * const result = await verifyAnchor(provider, txHash, expectedRootHash);
 * if (result.valid) {
 *   console.log("Anchor verified at block", result.txInfo?.blockHeight);
 * }
 *
 * // Find all anchors in a transaction
 * const { anchors } = await findAnchorsInTx(provider, txHash);
 * ```
 */

import type {
  AnchorEntry,
  AnchorMetadata,
  AnchorChainProvider,
  AnchorVerificationResult,
  AnchorParseResult,
  StorageRef,
  TxInfo,
} from "./types.js";
import { POI_METADATA_LABEL, isAnchorMetadata } from "./types.js";
import { computeRootHash, computeRollingHash } from "@fluxpointstudios/orynq-sdk-process-trace";
import type { TraceRun } from "@fluxpointstudios/orynq-sdk-process-trace";

/**
 * Options for {@link verifyAnchor} (issue #61).
 */
export interface VerifyAnchorOptions {
  /** Fetch the bundle from the anchor's storageRefs/storageUri and attach it to `result.bundle`. */
  fetchBundle?: boolean;
  /** Injectable fetch (edge runtimes / testing). Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** IPFS HTTP gateway base for ipfs:// URIs (default "https://ipfs.io/ipfs/"). */
  ipfsGateway?: string;
  /** Arweave HTTP gateway base for ar:// URIs (default "https://arweave.net/"). */
  arweaveGateway?: string;
  /**
   * SSRF allow-list of hostnames the verifier may fetch from (case-insensitive,
   * exact host match). When set, any URL whose host is not listed is rejected.
   * When omitted, fetches are still restricted to https:// with public hosts
   * (private/link-local/loopback addresses are always rejected).
   */
  allowedHosts?: string[];
  /**
   * Hard cap on the number of response bytes read from a storage fetch. A
   * `StorageRef.size` smaller than this further tightens the cap for that ref.
   * Defaults to {@link DEFAULT_MAX_BUNDLE_BYTES}.
   */
  maxBundleBytes?: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Expected schema prefix for anchor metadata.
 * Used for major version checking.
 */
const SCHEMA_PREFIX = "poi-anchor-";

/**
 * Current supported schema version.
 */
const CURRENT_SCHEMA = "poi-anchor-v1";

/**
 * Required fields for an anchor entry.
 */
const REQUIRED_ENTRY_FIELDS = [
  "type",
  "version",
  "rootHash",
  "manifestHash",
  "timestamp",
] as const;

/**
 * Optional fields for an anchor entry.
 * Used to detect unknown fields.
 */
const OPTIONAL_ENTRY_FIELDS = [
  "merkleRoot",
  "itemCount",
  "agentId",
  "storageUri",
  "storageRefs",
] as const;

/**
 * All known fields for an anchor entry.
 */
const KNOWN_ENTRY_FIELDS = new Set<string>([
  ...REQUIRED_ENTRY_FIELDS,
  ...OPTIONAL_ENTRY_FIELDS,
]);

/**
 * Valid anchor types.
 */
const VALID_ANCHOR_TYPES = new Set(["process-trace", "proof-of-intent", "custom"]);

/**
 * Default hard cap on bytes read from a storage fetch (8 MiB). Prevents an
 * attacker-controlled storageRef from streaming an unbounded response (#61).
 */
export const DEFAULT_MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

// =============================================================================
// HASH VALIDATION
// =============================================================================

/**
 * Validate a hash string format.
 *
 * A valid hash must be exactly 64 characters of lowercase hexadecimal.
 * This supports both raw hex strings and prefixed formats (the prefix
 * is stripped before validation).
 *
 * @param hash - Hash string to validate
 * @returns True if the hash format is valid
 *
 * @example
 * ```typescript
 * isValidHashFormat("abc123..."); // true (if 64 chars, lowercase hex)
 * isValidHashFormat("sha256:abc123..."); // true (prefix stripped)
 * isValidHashFormat("ABC123..."); // false (uppercase)
 * isValidHashFormat("short"); // false (not 64 chars)
 * ```
 */
export function isValidHashFormat(hash: string): boolean {
  if (typeof hash !== "string") {
    return false;
  }

  // Strip optional sha256: prefix
  const rawHash = hash.startsWith("sha256:") ? hash.slice(7) : hash;

  // Must be exactly 64 characters
  if (rawHash.length !== 64) {
    return false;
  }

  // Must be lowercase hex only
  return /^[0-9a-f]{64}$/.test(rawHash);
}

/**
 * Normalize a hash by stripping the sha256: prefix if present.
 *
 * @param hash - Hash string to normalize
 * @returns Raw hex hash without prefix
 */
function normalizeHash(hash: string): string {
  return hash.startsWith("sha256:") ? hash.slice(7) : hash;
}

// =============================================================================
// METADATA EXTRACTION
// =============================================================================

/**
 * Extract anchor metadata from label 2222.
 *
 * This function attempts to extract and validate the anchor metadata
 * structure from raw transaction metadata. It handles both string and
 * numeric keys for the label.
 *
 * @param metadata - Raw transaction metadata object
 * @returns Validated AnchorMetadata or null if not present/invalid
 *
 * @example
 * ```typescript
 * const rawMetadata = { "2222": { schema: "poi-anchor-v1", anchors: [...] } };
 * const anchorMetadata = extractAnchorFromMetadata(rawMetadata);
 * if (anchorMetadata) {
 *   console.log("Found", anchorMetadata.anchors.length, "anchors");
 * }
 * ```
 */
export function extractAnchorFromMetadata(
  metadata: Record<string, unknown>
): AnchorMetadata | null {
  if (typeof metadata !== "object" || metadata === null) {
    return null;
  }

  // Try both string and numeric keys for label 2222
  const label2222 =
    metadata[POI_METADATA_LABEL.toString()] ?? metadata[POI_METADATA_LABEL];

  if (label2222 === undefined || label2222 === null) {
    return null;
  }

  // Validate the structure using type guard
  if (isAnchorMetadata(label2222)) {
    return label2222;
  }

  return null;
}

// =============================================================================
// ANCHOR PARSING
// =============================================================================

/**
 * Parse a single anchor entry from raw data.
 *
 * Performs defensive parsing with detailed error reporting.
 * Unknown fields are ignored with warnings for forward compatibility.
 *
 * @param entry - Raw entry data
 * @param index - Entry index for error messages
 * @returns Parsed entry with any warnings, or null with errors
 */
function parseAnchorEntry(
  entry: unknown,
  index: number
): { entry: AnchorEntry | null; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const prefix = `Entry ${index}`;

  // Must be an object
  if (typeof entry !== "object" || entry === null) {
    errors.push(`${prefix}: expected object, got ${typeof entry}`);
    return { entry: null, warnings, errors };
  }

  const raw = entry as Record<string, unknown>;

  // Check for unknown fields (forward compatibility warning)
  for (const key of Object.keys(raw)) {
    if (!KNOWN_ENTRY_FIELDS.has(key)) {
      warnings.push(`${prefix}: unknown field '${key}' ignored`);
    }
  }

  // Validate required fields exist
  for (const field of REQUIRED_ENTRY_FIELDS) {
    if (raw[field] === undefined) {
      errors.push(`${prefix}: missing required field '${field}'`);
    }
  }

  // If any required fields missing, skip this entry
  if (errors.length > 0) {
    return { entry: null, warnings, errors };
  }

  // Validate type
  if (typeof raw.type !== "string" || !VALID_ANCHOR_TYPES.has(raw.type)) {
    errors.push(
      `${prefix}: invalid type '${raw.type}', expected one of: process-trace, proof-of-intent, custom`
    );
    return { entry: null, warnings, errors };
  }

  // Validate version
  if (raw.version !== "1.0") {
    errors.push(`${prefix}: unsupported version '${raw.version}', expected '1.0'`);
    return { entry: null, warnings, errors };
  }

  // Validate rootHash format
  if (typeof raw.rootHash !== "string") {
    errors.push(`${prefix}: rootHash must be a string`);
    return { entry: null, warnings, errors };
  }
  if (!isValidHashFormat(raw.rootHash)) {
    errors.push(
      `${prefix}: invalid rootHash format, expected 64-char lowercase hex`
    );
    return { entry: null, warnings, errors };
  }

  // Validate manifestHash format
  if (typeof raw.manifestHash !== "string") {
    errors.push(`${prefix}: manifestHash must be a string`);
    return { entry: null, warnings, errors };
  }
  if (!isValidHashFormat(raw.manifestHash)) {
    errors.push(
      `${prefix}: invalid manifestHash format, expected 64-char lowercase hex`
    );
    return { entry: null, warnings, errors };
  }

  // Validate timestamp
  if (typeof raw.timestamp !== "string") {
    errors.push(`${prefix}: timestamp must be a string`);
    return { entry: null, warnings, errors };
  }

  // Validate optional fields if present
  if (raw.merkleRoot !== undefined) {
    if (typeof raw.merkleRoot !== "string") {
      errors.push(`${prefix}: merkleRoot must be a string`);
      return { entry: null, warnings, errors };
    }
    if (!isValidHashFormat(raw.merkleRoot)) {
      errors.push(
        `${prefix}: invalid merkleRoot format, expected 64-char lowercase hex`
      );
      return { entry: null, warnings, errors };
    }
  }

  if (raw.itemCount !== undefined) {
    if (typeof raw.itemCount !== "number" || !Number.isInteger(raw.itemCount)) {
      errors.push(`${prefix}: itemCount must be an integer`);
      return { entry: null, warnings, errors };
    }
    if (raw.itemCount < 0) {
      errors.push(`${prefix}: itemCount must be non-negative`);
      return { entry: null, warnings, errors };
    }
  }

  if (raw.agentId !== undefined && typeof raw.agentId !== "string") {
    errors.push(`${prefix}: agentId must be a string`);
    return { entry: null, warnings, errors };
  }

  if (raw.storageUri !== undefined && typeof raw.storageUri !== "string") {
    errors.push(`${prefix}: storageUri must be a string`);
    return { entry: null, warnings, errors };
  }

  // Validate storageRefs (issue #61) — defensive: tolerate malformed entries.
  let parsedStorageRefs: StorageRef[] | undefined;
  if (raw.storageRefs !== undefined) {
    if (!Array.isArray(raw.storageRefs)) {
      errors.push(`${prefix}: storageRefs must be an array`);
      return { entry: null, warnings, errors };
    }
    const refs: StorageRef[] = [];
    for (let i = 0; i < raw.storageRefs.length; i++) {
      const r = raw.storageRefs[i] as Record<string, unknown> | null;
      if (typeof r !== "object" || r === null) {
        warnings.push(`${prefix}: storageRefs[${i}] is not an object, skipped`);
        continue;
      }
      if (typeof r.type !== "string" || typeof r.uri !== "string" || typeof r.hash !== "string") {
        warnings.push(`${prefix}: storageRefs[${i}] missing type/uri/hash, skipped`);
        continue;
      }
      const ref: StorageRef = { type: r.type, uri: r.uri, hash: r.hash };
      if (typeof r.size === "number") ref.size = r.size;
      refs.push(ref);
    }
    if (refs.length > 0) parsedStorageRefs = refs;
  }

  // Build the validated entry
  const validEntry: AnchorEntry = {
    type: raw.type as AnchorEntry["type"],
    version: "1.0",
    rootHash: raw.rootHash as string,
    manifestHash: raw.manifestHash as string,
    timestamp: raw.timestamp as string,
  };

  // Add optional fields if present
  if (raw.merkleRoot !== undefined) {
    validEntry.merkleRoot = raw.merkleRoot as string;
  }
  if (raw.itemCount !== undefined) {
    validEntry.itemCount = raw.itemCount as number;
  }
  if (raw.agentId !== undefined) {
    validEntry.agentId = raw.agentId as string;
  }
  if (raw.storageUri !== undefined) {
    validEntry.storageUri = raw.storageUri as string;
  }
  if (parsedStorageRefs !== undefined) {
    validEntry.storageRefs = parsedStorageRefs;
  }

  return { entry: validEntry, warnings, errors };
}

/**
 * Parse anchor metadata from raw transaction metadata.
 *
 * Performs defensive parsing that handles malformed or adversarial data
 * gracefully. Supports forward compatibility by ignoring unknown fields
 * with warnings.
 *
 * Parsing rules:
 * 1. Unknown fields -> warn and ignore (forward compatibility)
 * 2. Missing required fields -> error, skip entry
 * 3. Invalid hash format -> error, skip entry
 * 4. Schema version mismatch -> warn if minor, error if major
 * 5. Multiple anchors in one tx -> parse all, return array
 *
 * @param rawMetadata - Raw transaction metadata object
 * @returns Parse result with valid entries, warnings, and errors
 *
 * @example
 * ```typescript
 * const parseResult = parseAnchorMetadata(rawMetadata);
 * console.log("Valid anchors:", parseResult.valid.length);
 * console.log("Warnings:", parseResult.warnings);
 * console.log("Errors:", parseResult.errors);
 * ```
 */
export function parseAnchorMetadata(
  rawMetadata: Record<string, unknown>
): AnchorParseResult {
  const valid: AnchorEntry[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  // Guard against non-object input
  if (typeof rawMetadata !== "object" || rawMetadata === null) {
    errors.push("Metadata must be an object");
    return { valid, warnings, errors };
  }

  // Try both string and numeric keys for label 2222
  const label2222 =
    rawMetadata[POI_METADATA_LABEL.toString()] ?? rawMetadata[POI_METADATA_LABEL];

  if (label2222 === undefined || label2222 === null) {
    errors.push(`Metadata label ${POI_METADATA_LABEL} not found`);
    return { valid, warnings, errors };
  }

  if (typeof label2222 !== "object" || label2222 === null) {
    errors.push(`Label ${POI_METADATA_LABEL} must be an object`);
    return { valid, warnings, errors };
  }

  const anchorData = label2222 as Record<string, unknown>;

  // Validate schema
  if (anchorData.schema === undefined) {
    errors.push("Missing required field 'schema'");
    return { valid, warnings, errors };
  }

  if (typeof anchorData.schema !== "string") {
    errors.push("Field 'schema' must be a string");
    return { valid, warnings, errors };
  }

  // Check schema version compatibility
  if (!anchorData.schema.startsWith(SCHEMA_PREFIX)) {
    errors.push(
      `Unknown schema '${anchorData.schema}', expected '${SCHEMA_PREFIX}*'`
    );
    return { valid, warnings, errors };
  }

  if (anchorData.schema !== CURRENT_SCHEMA) {
    // Extract version number for comparison
    const schemaVersion = anchorData.schema.slice(SCHEMA_PREFIX.length);
    const currentVersion = CURRENT_SCHEMA.slice(SCHEMA_PREFIX.length);

    // For now, any mismatch is a warning (minor version difference)
    // In the future, could implement proper semver comparison
    if (schemaVersion.charAt(0) !== currentVersion.charAt(0)) {
      // Major version mismatch
      errors.push(
        `Schema major version mismatch: got '${anchorData.schema}', expected '${CURRENT_SCHEMA}'`
      );
      return { valid, warnings, errors };
    } else {
      // Minor version difference
      warnings.push(
        `Schema version mismatch: got '${anchorData.schema}', expected '${CURRENT_SCHEMA}'`
      );
    }
  }

  // Check for unknown top-level fields
  const knownTopLevelFields = new Set(["schema", "anchors"]);
  for (const key of Object.keys(anchorData)) {
    if (!knownTopLevelFields.has(key)) {
      warnings.push(`Unknown top-level field '${key}' ignored`);
    }
  }

  // Validate anchors array
  if (!Array.isArray(anchorData.anchors)) {
    errors.push("Field 'anchors' must be an array");
    return { valid, warnings, errors };
  }

  if (anchorData.anchors.length === 0) {
    warnings.push("Empty anchors array");
    return { valid, warnings, errors };
  }

  // Parse each anchor entry
  for (let i = 0; i < anchorData.anchors.length; i++) {
    const entryResult = parseAnchorEntry(anchorData.anchors[i], i);
    warnings.push(...entryResult.warnings);
    errors.push(...entryResult.errors);

    if (entryResult.entry !== null) {
      valid.push(entryResult.entry);
    }
  }

  return { valid, warnings, errors };
}

// =============================================================================
// ANCHOR VERIFICATION
// =============================================================================

/**
 * Verify an anchor exists in a transaction and matches expected hash.
 *
 * This function fetches transaction metadata from the chain provider,
 * parses the anchor metadata, and verifies that an anchor with the
 * expected root hash exists.
 *
 * @param provider - Chain data provider (Blockfrost, Koios, etc.)
 * @param txHash - Transaction hash to check
 * @param expectedRootHash - Expected root hash to match
 * @returns Verification result with status, txInfo, anchor, errors, and warnings
 *
 * @example
 * ```typescript
 * const result = await verifyAnchor(blockfrost, txHash, expectedRootHash);
 * if (result.valid) {
 *   console.log("Anchor verified at block", result.txInfo?.blockHeight);
 *   console.log("Confirmations:", result.txInfo?.confirmations);
 * } else {
 *   console.log("Verification failed:", result.errors);
 * }
 * ```
 */
export async function verifyAnchor(
  provider: AnchorChainProvider,
  txHash: string,
  expectedRootHash: string,
  options: VerifyAnchorOptions = {}
): Promise<AnchorVerificationResult> {
  const warnings: string[] = [];

  // Validate input parameters
  if (!txHash || typeof txHash !== "string") {
    return {
      valid: false,
      errors: ["Invalid transaction hash"],
      warnings: [],
    };
  }

  if (!expectedRootHash || typeof expectedRootHash !== "string") {
    return {
      valid: false,
      errors: ["Invalid expected root hash"],
      warnings: [],
    };
  }

  if (!isValidHashFormat(expectedRootHash)) {
    return {
      valid: false,
      errors: ["Expected root hash has invalid format (must be 64-char lowercase hex)"],
      warnings: [],
    };
  }

  try {
    // Fetch transaction metadata
    const metadata = await provider.getTxMetadata(txHash);

    if (metadata === null) {
      return {
        valid: false,
        errors: ["Transaction not found"],
        warnings: [],
      };
    }

    // Parse anchor metadata
    const parseResult = parseAnchorMetadata(metadata);
    warnings.push(...parseResult.warnings);

    if (parseResult.valid.length === 0) {
      return {
        valid: false,
        errors: parseResult.errors.length > 0
          ? parseResult.errors
          : ["No valid anchor entries found"],
        warnings,
      };
    }

    // Normalize expected hash for comparison
    const normalizedExpected = normalizeHash(expectedRootHash);

    // Find anchor with matching rootHash
    const matchingAnchor = parseResult.valid.find((anchor) => {
      const normalizedAnchor = normalizeHash(anchor.rootHash);
      return normalizedAnchor === normalizedExpected;
    });

    if (!matchingAnchor) {
      return {
        valid: false,
        errors: [`No anchor found with rootHash matching '${expectedRootHash}'`],
        warnings,
      };
    }

    // Fetch transaction info for confirmation details
    const txInfo = await provider.getTxInfo(txHash);

    // Optionally fetch the raw bundle from storage refs (issue #61) and verify
    // its content hashes to the on-chain anchor rootHash.
    let bundle: unknown;
    const errors: string[] = [];
    if (options.fetchBundle) {
      const fetched = await fetchBundleFromAnchor(matchingAnchor, options);
      warnings.push(...fetched.warnings);
      if (fetched.integrityFailed) {
        errors.push(
          "Fetched bundle failed integrity check: its content does not hash to the on-chain anchor rootHash"
        );
      } else {
        bundle = fetched.bundle;
      }
    }

    const valid = errors.length === 0;

    if (txInfo === null) {
      warnings.push("Transaction metadata found but txInfo unavailable");
      return {
        valid,
        anchor: matchingAnchor,
        errors,
        warnings,
        ...(bundle !== undefined ? { bundle } : {}),
      };
    }

    if (txInfo.confirmations < 10) {
      warnings.push(`Low confirmation count (${txInfo.confirmations} < 10)`);
    }

    return {
      valid,
      txInfo,
      anchor: matchingAnchor,
      errors,
      warnings,
      ...(bundle !== undefined ? { bundle } : {}),
    };
  } catch (error) {
    // Handle network or provider errors
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";
    return {
      valid: false,
      errors: [`Provider error: ${errorMessage}`],
      warnings,
    };
  }
}

/**
 * True for hosts that must never be fetched: loopback, link-local, and RFC1918
 * private ranges (the classic SSRF targets, incl. the cloud metadata endpoint
 * 169.254.169.254). Hostnames (non-IP) are allowed only via the allow-list.
 */
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;

  // IPv6 loopback / unique-local / link-local.
  if (h === "[::1]" || h === "::1") return true;
  if (h.startsWith("[fc") || h.startsWith("[fd") || h.startsWith("[fe80")) return true;

  // IPv4 dotted-quad ranges.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 169 && b === 254) return true; // link-local (metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 0) return true; // 0.0.0.0/8
  }
  return false;
}

/**
 * Resolve a storage URI to an HTTPS URL the verifier is allowed to fetch (#61).
 *
 * SSRF hardening: only https:// is honored (http:// is rejected); the host must
 * be on `options.allowedHosts` when that list is provided; private/link-local/
 * loopback hosts are always rejected. Returns `{ url }` when fetchable, or
 * `{ reason }` describing why it was rejected (for a caller warning).
 */
function resolveStorageUri(
  uri: string,
  options: VerifyAnchorOptions
): { url: string } | { reason: string } {
  let resolved: string;
  if (uri.startsWith("https://")) {
    resolved = uri;
  } else if (uri.startsWith("http://")) {
    // Plaintext http is never allowed (SSRF + downgrade).
    return { reason: `rejected non-https scheme (only https:// allowed): ${uri}` };
  } else if (uri.startsWith("ipfs://")) {
    const base = (options.ipfsGateway ?? "https://ipfs.io/ipfs/").replace(/\/+$/, "/");
    const cid = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
    resolved = base.endsWith("/") ? base + cid : base + "/" + cid;
  } else if (uri.startsWith("ar://")) {
    const base = (options.arweaveGateway ?? "https://arweave.net/").replace(/\/+$/, "/");
    const id = uri.slice("ar://".length);
    resolved = base.endsWith("/") ? base + id : base + "/" + id;
  } else {
    return { reason: `unsupported storage scheme (skipped): ${uri}` };
  }

  let host: string;
  try {
    const parsed = new URL(resolved);
    if (parsed.protocol !== "https:") {
      return { reason: `rejected non-https resolved URL: ${resolved}` };
    }
    host = parsed.hostname;
  } catch {
    return { reason: `unparseable storage URL (skipped): ${resolved}` };
  }

  if (isBlockedHost(host)) {
    return { reason: `rejected private/link-local host: ${host}` };
  }

  if (options.allowedHosts !== undefined) {
    const allowed = options.allowedHosts.map((h) => h.toLowerCase());
    if (!allowed.includes(host.toLowerCase())) {
      return { reason: `host not in allow-list: ${host}` };
    }
  }

  return { url: resolved };
}

/**
 * Recompute a fetched trace bundle's rootHash from its ACTUAL content, using the
 * same canonical derivation the bundle builder uses. The rolling hash is
 * recomputed from the events themselves (NOT read from the stored field), so
 * any tampering with events, spans, or the model-manifest pin changes the
 * result. Returns null when the document is not a full bundle we can
 * independently recompute (e.g. a manifest with redacted spans) — in which case
 * integrity cannot be established from the fetch alone.
 */
async function recomputeBundleRootHash(parsed: unknown): Promise<string | null> {
  if (!parsed || typeof parsed !== "object") return null;
  const run = (parsed as { privateRun?: unknown }).privateRun as
    | Partial<TraceRun>
    | undefined;
  if (!run || !Array.isArray(run.events) || !Array.isArray(run.spans)) {
    return null;
  }
  try {
    const rollingHash = await computeRollingHash(run.events as TraceRun["events"]);
    return await computeRootHash(
      rollingHash,
      run.spans as TraceRun["spans"],
      run.modelManifestHash
    );
  } catch {
    return null;
  }
}

/**
 * Read a response body with a hard byte cap (#61). Rejects (returns null) when
 * the stream exceeds `maxBytes` instead of buffering an unbounded response.
 */
async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  const declared = res.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) return null;
  }
  const text = await res.text();
  // TextEncoder gives the true byte length (multi-byte chars count correctly).
  if (new TextEncoder().encode(text).length > maxBytes) return null;
  return text;
}

/**
 * Fetch the trace bundle from an anchor's storage references (issue #61).
 *
 * SSRF-hardened (https-only, host allow-list, private-host block) and size-
 * capped. Integrity is established by recomputing the fetched bundle's rootHash
 * from its own bytes and requiring it equals the on-chain anchor rootHash — the
 * fetched document's self-declared `rootHash` field is NEVER trusted. On an
 * integrity mismatch the fetch fails hard (`integrityFailed`) so the caller
 * marks the whole verification invalid.
 */
async function fetchBundleFromAnchor(
  anchor: AnchorEntry,
  options: VerifyAnchorOptions
): Promise<{ bundle: unknown; warnings: string[]; integrityFailed: boolean }> {
  const warnings: string[] = [];
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    warnings.push("fetchBundle requested but no fetch implementation is available");
    return { bundle: undefined, warnings, integrityFailed: false };
  }

  const maxBytes = options.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES;

  const candidates: StorageRef[] = [...(anchor.storageRefs ?? [])];
  if (anchor.storageUri) {
    candidates.push({ type: "uri", uri: anchor.storageUri, hash: "" });
  }
  if (candidates.length === 0) {
    warnings.push("fetchBundle requested but anchor has no storageRefs or storageUri");
    return { bundle: undefined, warnings, integrityFailed: false };
  }

  for (const ref of candidates) {
    const resolved = resolveStorageUri(ref.uri, options);
    if ("reason" in resolved) {
      warnings.push(resolved.reason);
      continue;
    }
    const url = resolved.url;

    // A storageRef may declare its own byte size; use the tighter of the two.
    const refCap =
      typeof ref.size === "number" && ref.size > 0
        ? Math.min(ref.size, maxBytes)
        : maxBytes;

    try {
      const res = await fetchFn(url);
      if (!res.ok) {
        warnings.push(`Fetch failed (HTTP ${res.status}): ${url}`);
        continue;
      }
      const text = await readCapped(res, refCap);
      if (text === null) {
        warnings.push(`Fetched content exceeds size cap (${refCap} bytes): ${url}`);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }

      // Integrity: recompute the root from the ACTUAL bytes and require it to
      // equal the on-chain anchor rootHash. Never trust the self-declared field.
      const recomputed = await recomputeBundleRootHash(parsed);
      if (recomputed === null) {
        warnings.push(
          `Fetched content is not a full trace bundle; cannot recompute rootHash to verify against the anchor (${ref.uri})`
        );
        return { bundle: undefined, warnings, integrityFailed: true };
      }
      if (normalizeHash(recomputed) !== normalizeHash(anchor.rootHash)) {
        warnings.push(
          `Fetched bundle content hashes to ${recomputed} which does not match anchor rootHash ${anchor.rootHash} (${ref.uri})`
        );
        return { bundle: undefined, warnings, integrityFailed: true };
      }

      return { bundle: parsed, warnings, integrityFailed: false };
    } catch (error) {
      warnings.push(
        `Fetch errored (${ref.uri}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return { bundle: undefined, warnings, integrityFailed: false };
}

/**
 * Verify anchor matches a specific manifest hash.
 *
 * Similar to verifyAnchor but matches on manifestHash instead of rootHash.
 * Useful when you have the manifest hash but not the root hash.
 *
 * @param provider - Chain data provider (Blockfrost, Koios, etc.)
 * @param txHash - Transaction hash to check
 * @param expectedManifestHash - Expected manifest hash to match
 * @returns Verification result with status, txInfo, anchor, errors, and warnings
 *
 * @example
 * ```typescript
 * const result = await verifyAnchorManifest(blockfrost, txHash, manifestHash);
 * if (result.valid) {
 *   console.log("Manifest verified:", result.anchor?.manifestHash);
 * }
 * ```
 */
export async function verifyAnchorManifest(
  provider: AnchorChainProvider,
  txHash: string,
  expectedManifestHash: string
): Promise<AnchorVerificationResult> {
  const warnings: string[] = [];

  // Validate input parameters
  if (!txHash || typeof txHash !== "string") {
    return {
      valid: false,
      errors: ["Invalid transaction hash"],
      warnings: [],
    };
  }

  if (!expectedManifestHash || typeof expectedManifestHash !== "string") {
    return {
      valid: false,
      errors: ["Invalid expected manifest hash"],
      warnings: [],
    };
  }

  if (!isValidHashFormat(expectedManifestHash)) {
    return {
      valid: false,
      errors: ["Expected manifest hash has invalid format (must be 64-char lowercase hex)"],
      warnings: [],
    };
  }

  try {
    // Fetch transaction metadata
    const metadata = await provider.getTxMetadata(txHash);

    if (metadata === null) {
      return {
        valid: false,
        errors: ["Transaction not found"],
        warnings: [],
      };
    }

    // Parse anchor metadata
    const parseResult = parseAnchorMetadata(metadata);
    warnings.push(...parseResult.warnings);

    if (parseResult.valid.length === 0) {
      return {
        valid: false,
        errors: parseResult.errors.length > 0
          ? parseResult.errors
          : ["No valid anchor entries found"],
        warnings,
      };
    }

    // Normalize expected hash for comparison
    const normalizedExpected = normalizeHash(expectedManifestHash);

    // Find anchor with matching manifestHash
    const matchingAnchor = parseResult.valid.find((anchor) => {
      const normalizedAnchor = normalizeHash(anchor.manifestHash);
      return normalizedAnchor === normalizedExpected;
    });

    if (!matchingAnchor) {
      return {
        valid: false,
        errors: [`No anchor found with manifestHash matching '${expectedManifestHash}'`],
        warnings,
      };
    }

    // Fetch transaction info for confirmation details
    const txInfo = await provider.getTxInfo(txHash);

    if (txInfo === null) {
      warnings.push("Transaction metadata found but txInfo unavailable");
      return {
        valid: true,
        anchor: matchingAnchor,
        errors: [],
        warnings,
      };
    }

    if (txInfo.confirmations < 10) {
      warnings.push(`Low confirmation count (${txInfo.confirmations} < 10)`);
    }

    return {
      valid: true,
      txInfo,
      anchor: matchingAnchor,
      errors: [],
      warnings,
    };
  } catch (error) {
    // Handle network or provider errors
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";
    return {
      valid: false,
      errors: [`Provider error: ${errorMessage}`],
      warnings,
    };
  }
}

/**
 * Find all anchors in a transaction.
 *
 * Fetches transaction metadata and returns all valid anchor entries found.
 * Useful for discovering what anchors exist in a transaction without
 * knowing the specific hashes in advance.
 *
 * @param provider - Chain data provider (Blockfrost, Koios, etc.)
 * @param txHash - Transaction hash to search
 * @returns Object containing anchors array, txInfo, and any errors
 *
 * @example
 * ```typescript
 * const { anchors, txInfo, errors } = await findAnchorsInTx(blockfrost, txHash);
 * for (const anchor of anchors) {
 *   console.log(anchor.type, anchor.rootHash);
 *   console.log("Stored at:", anchor.storageUri);
 * }
 * ```
 */
export async function findAnchorsInTx(
  provider: AnchorChainProvider,
  txHash: string
): Promise<{ anchors: AnchorEntry[]; txInfo: TxInfo | null; errors: string[] }> {
  const errors: string[] = [];

  // Validate input
  if (!txHash || typeof txHash !== "string") {
    return {
      anchors: [],
      txInfo: null,
      errors: ["Invalid transaction hash"],
    };
  }

  try {
    // Fetch transaction metadata
    const metadata = await provider.getTxMetadata(txHash);

    if (metadata === null) {
      return {
        anchors: [],
        txInfo: null,
        errors: ["Transaction not found"],
      };
    }

    // Parse anchor metadata
    const parseResult = parseAnchorMetadata(metadata);

    // Include parse errors in the result
    errors.push(...parseResult.errors);

    // Also include warnings as they may be important
    if (parseResult.warnings.length > 0) {
      errors.push(...parseResult.warnings.map((w) => `Warning: ${w}`));
    }

    // Fetch transaction info
    let txInfo: TxInfo | null = null;
    try {
      txInfo = await provider.getTxInfo(txHash);
    } catch (infoError) {
      const errorMessage =
        infoError instanceof Error ? infoError.message : "Unknown error";
      errors.push(`Failed to fetch txInfo: ${errorMessage}`);
    }

    return {
      anchors: parseResult.valid,
      txInfo,
      errors,
    };
  } catch (error) {
    // Handle network or provider errors
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";
    return {
      anchors: [],
      txInfo: null,
      errors: [`Provider error: ${errorMessage}`],
    };
  }
}
