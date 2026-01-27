/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/core/src/index.ts
 * @summary Main entry point for @poi-sdk/core package.
 *
 * This package provides the core types, interfaces, and utilities for the
 * poi-sdk dual-protocol commerce layer. It supports both Flux and x402
 * payment protocols with zero external dependencies.
 *
 * Key features:
 * - Protocol-neutral payment request/proof types
 * - Payer and Signer interfaces for wallet integration
 * - Budget tracking and invoice caching interfaces
 * - CAIP-2 chain identifier utilities
 * - RFC 8785 canonical JSON for deterministic hashing
 * - SHA256 utilities for idempotency key generation
 *
 * Usage:
 * ```typescript
 * import {
 *   PaymentRequest,
 *   Payer,
 *   CHAINS,
 *   canonicalize,
 *   generateIdempotencyKey,
 * } from "@poi-sdk/core";
 * ```
 *
 * Subpath exports:
 * - @poi-sdk/core/types - Type definitions only
 * - @poi-sdk/core/chains - Chain utilities only
 * - @poi-sdk/core/utils - Utility functions only
 */

// ---------------------------------------------------------------------------
// Type Exports
// ---------------------------------------------------------------------------

// Payment types
export type {
  ChainId,
  SplitOutput,
  PaymentSplits,
  PaymentFacilitator,
  PaymentRequest,
  CardanoTxHashProof,
  CardanoSignedCborProof,
  EvmTxHashProof,
  X402SignatureProof,
  PaymentProof,
  PaymentAttempt,
  PaymentStatusValue,
  PaymentStatus,
} from "./types/payment.js";

export {
  isCardanoTxHashProof,
  isCardanoSignedCborProof,
  isEvmTxHashProof,
  isX402SignatureProof,
  isCardanoProof,
  isEvmProof,
} from "./types/payment.js";

// Payer types
export type {
  Signer,
  Payer,
  ProviderType,
  NodePayerConfig,
  BrowserPayerConfig,
  PayerFactory,
  PayerRegistry,
} from "./types/payer.js";

// Error types
export {
  PaymentError,
  PaymentRequiredError,
  BudgetExceededError,
  InsufficientBalanceError,
  InvoiceExpiredError,
  DuplicatePaymentError,
  PaymentFailedError,
  PaymentTimeoutError,
  ChainNotSupportedError,
  AssetNotSupportedError,
  isPaymentError,
  isPaymentRequiredError,
  isBudgetExceededError,
  isInsufficientBalanceError,
  isRetryableError,
} from "./types/errors.js";

// Stream types
export type {
  BaseStreamEvent,
  PaymentRequiredEvent,
  PaymentReceivedEvent,
  PaymentConfirmedEvent,
  ContentChunkEvent,
  ProgressEvent,
  CompleteEvent,
  ErrorEvent,
  MetadataEvent,
  HeartbeatEvent,
  NDJsonEvent,
} from "./types/stream.js";

export {
  isPaymentRequiredEvent,
  isPaymentReceivedEvent,
  isPaymentConfirmedEvent,
  isContentChunkEvent,
  isProgressEvent,
  isCompleteEvent,
  isErrorEvent,
  isMetadataEvent,
  isHeartbeatEvent,
  isPaymentEvent,
  parseNDJsonLine,
  serializeNDJsonEvent,
  parseNDJsonStream,
} from "./types/stream.js";

// Budget types
export type {
  BudgetConfig,
  AssetBudgetConfig,
  ChainBudgetConfig,
  BudgetThresholdInfo,
  BudgetStore,
  BudgetSummary,
  InvoiceCache,
} from "./types/budget.js";

export { InMemoryBudgetStore, InMemoryInvoiceCache } from "./types/budget.js";

// Header types
export type {
  X402HeaderName,
  FluxHeaderName,
  PaymentHeaderName,
  ContentType,
} from "./types/headers.js";

export {
  X402_HEADERS,
  FLUX_HEADERS,
  PAYMENT_HEADERS,
  CONTENT_TYPES,
  isPaymentRequired,
  detectProtocol,
  extractPaymentHeaders,
} from "./types/headers.js";

// ---------------------------------------------------------------------------
// Chain Exports
// ---------------------------------------------------------------------------

export type {
  ChainName,
  KnownChainId,
  ChainFamily,
  CardanoNetwork,
  ChainInfo,
} from "./chains.js";

export {
  CHAINS,
  CHAIN_NAMES,
  EVM_CHAIN_IDS,
  CARDANO_NETWORKS,
  toCAIP2,
  fromCAIP2,
  tryFromCAIP2,
  normalizeChainId,
  isCAIP2,
  isKnownChain,
  isEvmChain,
  isCardanoChain,
  getChainFamily,
  getEvmChainId,
  evmChainId,
  getCardanoNetwork,
  cardanoChainId,
  isCardanoTestnet,
  getChainInfo,
  getAllChains,
  getChainsByFamily,
} from "./chains.js";

// ---------------------------------------------------------------------------
// Utility Exports
// ---------------------------------------------------------------------------

// Canonical JSON
export type { JsonValue, CanonicalizeOptions } from "./utils/canonical-json.js";

export {
  canonicalize,
  parseCanonical,
  canonicalEquals,
  normalizeJson,
  sortObjectKeys,
  isCanonical,
} from "./utils/canonical-json.js";

// Hash utilities
export type { IdempotencyKeyOptions } from "./utils/hash.js";

export {
  sha256,
  sha256String,
  sha256Hex,
  sha256StringHex,
  generateIdempotencyKey,
  bytesToHex,
  hexToBytes,
  isValidHex,
  bytesToBase64,
  base64ToBytes,
  bytesToBase64Url,
  base64UrlToBytes,
  generateContentHash,
  verifyContentHash,
} from "./utils/hash.js";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Package version.
 * Updated automatically during build.
 */
export const VERSION = "0.1.0";
