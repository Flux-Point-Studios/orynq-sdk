/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/core/src/types/index.ts
 * @summary Central export point for all type definitions in @poi-sdk/core.
 *
 * This file re-exports all types, interfaces, and type guards from the types
 * subdirectory. It provides a single import point for consumers who need
 * type definitions without the full utility implementations.
 *
 * Usage:
 * ```typescript
 * import type { PaymentRequest, Payer, BudgetConfig } from "@poi-sdk/core/types";
 * import { PaymentRequiredError, isPaymentError } from "@poi-sdk/core/types";
 * ```
 */

// ---------------------------------------------------------------------------
// Payment Types
// ---------------------------------------------------------------------------

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
} from "./payment.js";

export {
  isCardanoTxHashProof,
  isCardanoSignedCborProof,
  isEvmTxHashProof,
  isX402SignatureProof,
  isCardanoProof,
  isEvmProof,
} from "./payment.js";

// ---------------------------------------------------------------------------
// Payer Types
// ---------------------------------------------------------------------------

export type {
  Signer,
  Payer,
  ProviderType,
  NodePayerConfig,
  BrowserPayerConfig,
  PayerFactory,
  PayerRegistry,
} from "./payer.js";

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

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
} from "./errors.js";

// ---------------------------------------------------------------------------
// Stream Types
// ---------------------------------------------------------------------------

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
} from "./stream.js";

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
} from "./stream.js";

// ---------------------------------------------------------------------------
// Budget Types
// ---------------------------------------------------------------------------

export type {
  BudgetConfig,
  AssetBudgetConfig,
  ChainBudgetConfig,
  BudgetThresholdInfo,
  BudgetStore,
  BudgetSummary,
  InvoiceCache,
} from "./budget.js";

export { InMemoryBudgetStore, InMemoryInvoiceCache } from "./budget.js";

// ---------------------------------------------------------------------------
// Header Types
// ---------------------------------------------------------------------------

export type {
  X402HeaderName,
  FluxHeaderName,
  PaymentHeaderName,
  ContentType,
} from "./headers.js";

export {
  X402_HEADERS,
  FLUX_HEADERS,
  PAYMENT_HEADERS,
  CONTENT_TYPES,
  isPaymentRequired,
  detectProtocol,
  extractPaymentHeaders,
} from "./headers.js";
