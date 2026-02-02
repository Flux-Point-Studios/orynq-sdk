/**
 * @fileoverview Type definitions for Cardano blockchain anchoring.
 *
 * Location: packages/anchors-cardano/src/types.ts
 *
 * This file defines all types for the anchors-cardano package, which provides
 * functionality to anchor PoI (Proof-of-Intent) trace bundles to the Cardano
 * blockchain using transaction metadata under label 2222.
 *
 * Key concepts:
 * - AnchorEntry: Individual anchor record linking a trace to on-chain data
 * - AnchorMetadata: Complete metadata structure for label 2222
 * - AnchorChainProvider: Interface for blockchain data providers (Blockfrost, Koios)
 * - Verification: Types for validating anchored data against on-chain records
 *
 * Used by:
 * - src/builder.ts: Creates anchor metadata from trace bundles
 * - src/parser.ts: Parses and validates anchor metadata from transactions
 * - src/verifier.ts: Verifies anchor integrity against chain data
 * - src/providers/: Blockchain data provider implementations
 *
 * @see https://github.com/Flux-Point-Studios/orynq-sdk for specification
 */

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Cardano metadata label for PoI anchors.
 *
 * Label 2222 is reserved for Proof-of-Intent anchor metadata.
 * This follows the CIP-10 metadata label registry convention.
 *
 * @see https://cips.cardano.org/cips/cip10/
 */
export const POI_METADATA_LABEL = 2222;

// =============================================================================
// SCHEMA & TYPE IDENTIFIERS
// =============================================================================

/**
 * Schema identifier for anchor metadata.
 *
 * This schema version identifies the structure of the anchor metadata.
 * Future versions may introduce new schemas while maintaining backward
 * compatibility through explicit versioning.
 */
export type AnchorSchema = "poi-anchor-v1";

/**
 * Types of anchors that can be stored.
 *
 * - "process-trace": Standard PoI process trace bundle anchor
 * - "proof-of-intent": Explicit proof-of-intent declaration
 * - "custom": Extension point for application-specific anchors
 */
export type AnchorType = "process-trace" | "proof-of-intent" | "custom";

/**
 * Network identifier for Cardano networks.
 *
 * - "mainnet": Production network
 * - "preprod": Pre-production testnet (stable)
 * - "preview": Preview testnet (cutting-edge)
 */
export type CardanoNetwork = "mainnet" | "preprod" | "preview";

// =============================================================================
// ANCHOR ENTRY
// =============================================================================

/**
 * Single anchor entry in transaction metadata.
 *
 * An anchor entry represents a cryptographic binding between a trace bundle
 * and the Cardano blockchain. The entry contains hashes that can be used to
 * verify the integrity and authenticity of the associated trace data.
 *
 * Hash Types:
 * - rootHash: Rolling hash final - proves execution sequence integrity
 * - manifestHash: H(canonical(manifest)) - binds to off-chain storage
 * - merkleRoot: Span-level commitment - enables selective disclosure
 *
 * @example
 * ```typescript
 * const entry: AnchorEntry = {
 *   type: "process-trace",
 *   version: "1.0",
 *   rootHash: "sha256:abc123...",
 *   manifestHash: "sha256:def456...",
 *   merkleRoot: "sha256:789ghi...",
 *   itemCount: 42,
 *   timestamp: "2024-01-28T12:00:00Z",
 *   agentId: "agent-claude-v1",
 *   storageUri: "ipfs://QmXyz..."
 * };
 * ```
 */
export interface AnchorEntry {
  /**
   * Type of anchor being stored.
   */
  type: AnchorType;

  /**
   * Version of the anchor entry format.
   * Currently always "1.0".
   */
  version: "1.0";

  /**
   * Rolling hash final value (execution sequence).
   *
   * This hash proves the complete execution sequence of the trace.
   * It is computed incrementally: H(prev || eventHash) for each event.
   * Format: "sha256:<hex>" or raw hex string.
   */
  rootHash: string;

  /**
   * Manifest hash - H(canonical(manifest)).
   *
   * This hash binds the anchor to off-chain storage.
   * Verifiers can fetch the manifest and confirm this hash matches.
   * Format: "sha256:<hex>" or raw hex string.
   */
  manifestHash: string;

  /**
   * Optional Merkle root for selective disclosure.
   *
   * When present, enables zero-knowledge proofs that specific spans
   * exist within the trace without revealing other spans.
   * Format: "sha256:<hex>" or raw hex string.
   */
  merkleRoot?: string;

  /**
   * Optional count of items (events or spans) in the trace.
   * Provides a quick summary without fetching full data.
   */
  itemCount?: number;

  /**
   * ISO 8601 timestamp when the anchor was created.
   *
   * Note: This is the anchor creation time, not necessarily the
   * trace execution time (which may differ).
   *
   * @example "2024-01-28T12:00:00.000Z"
   */
  timestamp: string;

  /**
   * Optional identifier of the agent that produced the trace.
   * Useful for multi-agent systems or audit trails.
   */
  agentId?: string;

  /**
   * Optional URI where the full trace data can be retrieved.
   *
   * Supported schemes:
   * - ipfs://: IPFS content-addressed storage
   * - ar://: Arweave permanent storage
   * - https://: Traditional HTTP endpoints
   *
   * @example "ipfs://QmXyz123..."
   * @example "https://storage.example.com/traces/abc123"
   */
  storageUri?: string;
}

// =============================================================================
// ANCHOR METADATA
// =============================================================================

/**
 * Complete anchor metadata structure for label 2222.
 *
 * This is the top-level structure embedded in Cardano transaction metadata.
 * A single transaction can contain multiple anchor entries.
 *
 * @example
 * ```typescript
 * const metadata: AnchorMetadata = {
 *   schema: "poi-anchor-v1",
 *   anchors: [
 *     {
 *       type: "process-trace",
 *       version: "1.0",
 *       rootHash: "sha256:abc123...",
 *       manifestHash: "sha256:def456...",
 *       timestamp: "2024-01-28T12:00:00Z"
 *     }
 *   ]
 * };
 * ```
 */
export interface AnchorMetadata {
  /**
   * Schema identifier for this metadata structure.
   * Enables forward compatibility and versioning.
   */
  schema: AnchorSchema;

  /**
   * Array of anchor entries.
   * A transaction may anchor multiple trace bundles.
   */
  anchors: AnchorEntry[];
}

// =============================================================================
// BUILD RESULTS
// =============================================================================

/**
 * Result of building anchor transaction metadata.
 *
 * This type represents the output of the anchor builder, ready to be
 * embedded in a Cardano transaction using any wallet or transaction
 * building library.
 *
 * @example
 * ```typescript
 * const result = buildAnchorMetadata(bundle);
 * // Use with Mesh, Lucid, or cardano-serialization-lib:
 * tx.setMetadata(result.label, result.json);
 * ```
 */
export interface AnchorTxResult {
  /**
   * Metadata label (always POI_METADATA_LABEL = 2222).
   */
  label: number;

  /**
   * Structured anchor metadata.
   */
  metadata: AnchorMetadata;

  /**
   * JSON representation ready to embed in transaction.
   *
   * This is the same as metadata but typed as a generic record
   * for compatibility with various transaction building libraries.
   */
  json: Record<string, unknown>;
}

// =============================================================================
// CHAIN DATA TYPES
// =============================================================================

/**
 * Transaction information from chain provider.
 *
 * Represents the on-chain context of a transaction containing
 * anchor metadata. Used for verification and audit trails.
 */
export interface TxInfo {
  /**
   * Transaction hash (hex-encoded).
   *
   * @example "abc123def456..."
   */
  txHash: string;

  /**
   * Block hash containing this transaction (hex-encoded).
   */
  blockHash: string;

  /**
   * Block height (slot leader sequence number).
   */
  blockHeight: number;

  /**
   * Slot number when the transaction was included.
   */
  slot: number;

  /**
   * ISO 8601 timestamp derived from slot.
   *
   * Note: This is the block timestamp, which may differ
   * from the anchor's internal timestamp.
   */
  timestamp: string;

  /**
   * Number of confirmations (blocks since inclusion).
   *
   * Higher values indicate stronger finality.
   * Cardano achieves practical finality after ~2160 blocks (~12 hours).
   */
  confirmations: number;
}

// =============================================================================
// VERIFICATION RESULTS
// =============================================================================

/**
 * Result of anchor verification.
 *
 * Verification checks that anchor metadata exists on-chain and
 * optionally that it matches expected values from off-chain data.
 */
export interface AnchorVerificationResult {
  /**
   * Overall verification status.
   * True only if all checks pass with no errors.
   */
  valid: boolean;

  /**
   * Transaction information if found on-chain.
   * Undefined if transaction not found or verification failed early.
   */
  txInfo?: TxInfo;

  /**
   * Parsed anchor entry if verification succeeded.
   * Undefined if parsing failed or anchor not found.
   */
  anchor?: AnchorEntry;

  /**
   * Fatal errors that caused verification to fail.
   * Empty array if verification succeeded.
   *
   * @example ["Transaction not found", "Invalid anchor schema"]
   */
  errors: string[];

  /**
   * Non-fatal warnings about potential issues.
   * Verification can still succeed with warnings.
   *
   * @example ["Low confirmation count (< 10)", "Missing optional merkleRoot"]
   */
  warnings: string[];
}

/**
 * Result of parsing anchor metadata.
 *
 * Defensive parsing allows partial success - some entries may parse
 * correctly while others fail. This supports forward compatibility
 * when new anchor types or fields are introduced.
 */
export interface AnchorParseResult {
  /**
   * Successfully parsed anchor entries.
   * May be empty if all entries failed parsing.
   */
  valid: AnchorEntry[];

  /**
   * Non-fatal parsing warnings.
   *
   * @example ["Unknown field 'foo' ignored", "Missing optional field 'agentId'"]
   */
  warnings: string[];

  /**
   * Errors for entries that couldn't be parsed.
   * Each string describes what went wrong.
   *
   * @example ["Entry 0: missing required field 'rootHash'"]
   */
  errors: string[];
}

// =============================================================================
// CHAIN PROVIDER CONFIGURATION
// =============================================================================

/**
 * Configuration for chain providers.
 *
 * Base configuration shared by all provider implementations.
 * Supports dependency injection for testing and edge runtime compatibility.
 */
export interface AnchorChainProviderConfig {
  /**
   * Injectable fetch function.
   *
   * Allows using custom fetch implementations for:
   * - Testing with mocked responses
   * - Edge runtimes (Cloudflare Workers, Deno Deploy)
   * - Proxy or custom transport needs
   *
   * Defaults to global fetch if not provided.
   */
  fetchFn?: typeof fetch;

  /**
   * Request timeout in milliseconds.
   *
   * @default 30000 (30 seconds)
   */
  timeout?: number;

  /**
   * Number of retry attempts for transient failures.
   *
   * Retries use exponential backoff with jitter.
   *
   * @default 3
   */
  retries?: number;
}

// =============================================================================
// CHAIN PROVIDER INTERFACE
// =============================================================================

/**
 * Interface for blockchain data providers.
 *
 * Abstraction over different Cardano data sources (Blockfrost, Koios, etc.).
 * Implementations handle API-specific details while exposing a common interface.
 *
 * @example
 * ```typescript
 * const provider: AnchorChainProvider = new BlockfrostProvider({
 *   projectId: "mainnetXYZ...",
 *   network: "mainnet"
 * });
 *
 * const metadata = await provider.getTxMetadata(txHash);
 * const info = await provider.getTxInfo(txHash);
 * ```
 */
export interface AnchorChainProvider {
  /**
   * Get transaction metadata by hash.
   *
   * Returns the full metadata object for the transaction,
   * or null if the transaction is not found or has no metadata.
   *
   * @param txHash - Transaction hash (hex-encoded, with or without 0x prefix)
   * @returns Metadata object or null if not found
   * @throws Error on network or API errors (not for missing transactions)
   */
  getTxMetadata(txHash: string): Promise<Record<string, unknown> | null>;

  /**
   * Get transaction info by hash.
   *
   * Returns chain context information for the transaction,
   * or null if the transaction is not found.
   *
   * @param txHash - Transaction hash (hex-encoded, with or without 0x prefix)
   * @returns Transaction info or null if not found
   * @throws Error on network or API errors (not for missing transactions)
   */
  getTxInfo(txHash: string): Promise<TxInfo | null>;

  /**
   * Get the network this provider is connected to.
   *
   * @returns Network identifier
   */
  getNetworkId(): CardanoNetwork;
}

// =============================================================================
// PROVIDER-SPECIFIC CONFIGURATIONS
// =============================================================================

/**
 * Blockfrost-specific configuration.
 *
 * Blockfrost is a hosted Cardano API service.
 *
 * @see https://blockfrost.io/
 */
export interface BlockfrostConfig extends AnchorChainProviderConfig {
  /**
   * Blockfrost project ID.
   *
   * Format: "<network><apiKey>" (e.g., "mainnetABCDEF123...")
   * Obtain from https://blockfrost.io/dashboard
   */
  projectId: string;

  /**
   * Network to connect to.
   * Must match the network prefix in projectId.
   */
  network: CardanoNetwork;
}

/**
 * Koios-specific configuration.
 *
 * Koios is a distributed, community-operated Cardano API.
 *
 * @see https://www.koios.rest/
 */
export interface KoiosConfig extends AnchorChainProviderConfig {
  /**
   * Network to connect to.
   * Determines which Koios endpoint to use.
   */
  network: CardanoNetwork;

  /**
   * Optional API token for authenticated access.
   *
   * Public access is rate-limited; authenticated access
   * provides higher limits and priority.
   */
  apiToken?: string;
}

// =============================================================================
// BUILDER OPTIONS
// =============================================================================

/**
 * Options for creating an anchor entry from a trace bundle.
 *
 * These options customize how the anchor entry is constructed
 * from a TraceBundle or TraceManifest.
 *
 * @example
 * ```typescript
 * const entry = createAnchorEntry(bundle, {
 *   storageUri: "ipfs://QmXyz...",
 *   agentId: "my-agent-v1",
 *   includeMerkleRoot: true
 * });
 * ```
 */
export interface CreateAnchorEntryOptions {
  /**
   * Optional storage URI where the full trace can be retrieved.
   *
   * If provided, this URI is included in the anchor entry,
   * allowing verifiers to fetch the complete trace data.
   */
  storageUri?: string;

  /**
   * Optional agent identifier to include in the anchor.
   *
   * If not provided, the agentId from the bundle/manifest is used.
   * If neither is available, the field is omitted.
   */
  agentId?: string;

  /**
   * Whether to include the Merkle root in the anchor.
   *
   * The Merkle root enables selective disclosure proofs.
   * Set to false to reduce metadata size when selective
   * disclosure is not needed.
   *
   * @default true
   */
  includeMerkleRoot?: boolean;
}

// =============================================================================
// TYPE GUARDS
// =============================================================================

/**
 * Type guard to check if a value is a valid AnchorType.
 *
 * @param value - Value to check
 * @returns True if value is a valid AnchorType
 */
export function isAnchorType(value: unknown): value is AnchorType {
  return (
    typeof value === "string" &&
    (value === "process-trace" ||
      value === "proof-of-intent" ||
      value === "custom")
  );
}

/**
 * Type guard to check if a value is a valid CardanoNetwork.
 *
 * @param value - Value to check
 * @returns True if value is a valid CardanoNetwork
 */
export function isCardanoNetwork(value: unknown): value is CardanoNetwork {
  return (
    typeof value === "string" &&
    (value === "mainnet" || value === "preprod" || value === "preview")
  );
}

/**
 * Type guard to check if a value is a valid AnchorSchema.
 *
 * @param value - Value to check
 * @returns True if value is a valid AnchorSchema
 */
export function isAnchorSchema(value: unknown): value is AnchorSchema {
  return value === "poi-anchor-v1";
}

/**
 * Type guard to check if a value is a valid AnchorEntry.
 *
 * Performs structural validation of required fields.
 * Does not validate hash formats or semantic correctness.
 *
 * @param value - Value to check
 * @returns True if value has the structure of an AnchorEntry
 */
export function isAnchorEntry(value: unknown): value is AnchorEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const entry = value as Record<string, unknown>;

  return (
    isAnchorType(entry.type) &&
    entry.version === "1.0" &&
    typeof entry.rootHash === "string" &&
    typeof entry.manifestHash === "string" &&
    typeof entry.timestamp === "string" &&
    (entry.merkleRoot === undefined || typeof entry.merkleRoot === "string") &&
    (entry.itemCount === undefined || typeof entry.itemCount === "number") &&
    (entry.agentId === undefined || typeof entry.agentId === "string") &&
    (entry.storageUri === undefined || typeof entry.storageUri === "string")
  );
}

/**
 * Type guard to check if a value is a valid AnchorMetadata.
 *
 * @param value - Value to check
 * @returns True if value has the structure of AnchorMetadata
 */
export function isAnchorMetadata(value: unknown): value is AnchorMetadata {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const metadata = value as Record<string, unknown>;

  return (
    isAnchorSchema(metadata.schema) &&
    Array.isArray(metadata.anchors) &&
    metadata.anchors.every(isAnchorEntry)
  );
}

// =============================================================================
// UTILITY TYPES
// =============================================================================

/**
 * Hash format with optional prefix.
 * Supports both "sha256:hex" and raw hex formats.
 */
export type HashString = `sha256:${string}` | string;

/**
 * Strict version of AnchorEntry with all optional fields required.
 * Useful for internal processing where all fields are guaranteed present.
 */
export type StrictAnchorEntry = Required<AnchorEntry>;

/**
 * Input type for anchor entry creation.
 * Allows omitting version and timestamp which are auto-generated.
 */
export type AnchorEntryInput = Omit<AnchorEntry, "version" | "timestamp"> & {
  version?: "1.0";
  timestamp?: string;
};
