/**
 * @fileoverview Cardano blockchain anchor support for Proof-of-Intent SDK.
 *
 * Location: packages/anchors-cardano/src/index.ts
 *
 * This is the main entry point for the anchors-cardano package. It re-exports
 * all public types, functions, and constants for anchoring cryptographic
 * commitments to the Cardano blockchain using transaction metadata label 2222.
 *
 * The package provides:
 * - Types for anchor entries, metadata, and verification results
 * - Builder functions to create anchor metadata from trace bundles
 * - Verifier functions to parse and verify anchors from on-chain data
 * - Provider implementations for Blockfrost and Koios APIs
 *
 * Used by:
 * - Consumer applications anchoring traces to Cardano
 * - Verification workflows that check on-chain anchor integrity
 * - Integration with transaction building libraries (Mesh, Lucid, etc.)
 *
 * @example
 * ```typescript
 * import {
 *   buildAnchorMetadata,
 *   createAnchorEntryFromBundle,
 *   verifyAnchor,
 *   createBlockfrostProvider,
 *   POI_METADATA_LABEL,
 * } from "@fluxpointstudios/poi-sdk-anchors-cardano";
 *
 * // Create anchor from trace bundle
 * const entry = createAnchorEntryFromBundle(bundle, {
 *   storageUri: "ipfs://QmXyz...",
 * });
 * const metadata = buildAnchorMetadata(entry);
 *
 * // Verify anchor on-chain
 * const provider = createBlockfrostProvider({
 *   projectId: "mainnetXXXXXX",
 *   network: "mainnet",
 * });
 * const result = await verifyAnchor(provider, txHash, expectedRootHash);
 * ```
 *
 * @packageDocumentation
 */

// =============================================================================
// TYPES
// =============================================================================

export type {
  // Core types
  AnchorSchema,
  AnchorType,
  CardanoNetwork,
  AnchorEntry,
  AnchorMetadata,
  AnchorTxResult,
  TxInfo,

  // Verification
  AnchorVerificationResult,
  AnchorParseResult,

  // Provider interfaces
  AnchorChainProvider,
  AnchorChainProviderConfig,
  BlockfrostConfig,
  KoiosConfig,

  // Options
  CreateAnchorEntryOptions,

  // Utility types
  HashString,
  StrictAnchorEntry,
  AnchorEntryInput,
} from "./types.js";

export { POI_METADATA_LABEL } from "./types.js";

// Type guards
export {
  isAnchorType,
  isCardanoNetwork,
  isAnchorSchema,
  isAnchorEntry,
  isAnchorMetadata,
} from "./types.js";

// =============================================================================
// ANCHOR BUILDER
// =============================================================================

export type { ValidationResult } from "./anchor-builder.js";

export {
  buildAnchorMetadata,
  buildBatchAnchorMetadata,
  createAnchorEntryFromBundle,
  createAnchorEntryFromManifest,
  validateAnchorEntry,
  serializeForCardanoCli,
  serializeForCbor,
  extractRawHash,
  normalizeHashWithPrefix,
} from "./anchor-builder.js";

// =============================================================================
// ANCHOR VERIFIER
// =============================================================================

export {
  parseAnchorMetadata,
  verifyAnchor,
  verifyAnchorManifest,
  findAnchorsInTx,
  isValidHashFormat,
  extractAnchorFromMetadata,
} from "./anchor-verifier.js";

// =============================================================================
// PROVIDERS
// =============================================================================

// Blockfrost provider
export {
  createBlockfrostProvider,
  getBlockfrostBaseUrl,
  BlockfrostError,
} from "./providers/blockfrost.js";

// Koios provider
export {
  createKoiosProvider,
  getKoiosBaseUrl,
  KoiosError,
} from "./providers/koios.js";

// =============================================================================
// VERSION
// =============================================================================

export const VERSION = "0.1.0";
