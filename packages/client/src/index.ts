/**
 * @summary Main entry point for @fluxpointstudios/orynq-sdk-client package.
 *
 * This package provides the PoiClient for making requests to payment-protected
 * APIs with automatic payment handling. It supports both x402 and Flux protocols
 * with features including:
 *
 * - Automatic protocol detection
 * - Payment execution through configured Payer
 * - Budget enforcement (per-request and daily limits)
 * - Idempotency and duplicate payment prevention
 * - NDJSON streaming support
 * - Configurable retry logic
 *
 * Usage:
 * ```typescript
 * import { createPoiClient, PoiClient } from "@fluxpointstudios/orynq-sdk-client";
 *
 * const client = createPoiClient({
 *   baseUrl: "https://api.example.com",
 *   payer: myPayer,
 *   budget: {
 *     maxPerRequest: "5000000",
 *     maxPerDay: "50000000",
 *   },
 * });
 *
 * // Simple request - payment handled automatically
 * const response = await client.request<MyData>("/api/resource");
 *
 * // Streaming request
 * for await (const event of client.stream("/api/stream")) {
 *   console.log(event);
 * }
 * ```
 *
 * Used by:
 * - Application code needing to access paid APIs
 * - Any code requiring automatic payment handling
 */

// ---------------------------------------------------------------------------
// Main Client
// ---------------------------------------------------------------------------

export {
  PoiClient,
  createPoiClient,
  type PoiClientConfig,
  type PoiRequestOptions,
} from "./client.js";

// ---------------------------------------------------------------------------
// HTTP Client
// ---------------------------------------------------------------------------

export {
  HttpClient,
  createHttpClient,
  type HttpClientConfig,
  type ProtocolType,
} from "./http-client.js";

// ---------------------------------------------------------------------------
// Budget Tracking
// ---------------------------------------------------------------------------

export {
  BudgetTracker,
  createBudgetConfig,
  formatAmount,
} from "./budget-tracker.js";

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

export {
  IdempotencyManager,
  generateSimpleIdempotencyKey,
  extractInvoiceIdFromUrl,
} from "./idempotency.js";

// ---------------------------------------------------------------------------
// Retry Logic
// ---------------------------------------------------------------------------

export {
  retryWithPayment,
  retryWithBackoff,
  calculateBackoffDelay,
  createTimeout,
  withTimeout,
  isRetryableError,
  type RetryOptions,
  DEFAULT_RETRY_OPTIONS,
} from "./retry-logic.js";

// ---------------------------------------------------------------------------
// Stream Parsing
// ---------------------------------------------------------------------------

export {
  parseNDJsonStream,
  isNDJsonContentType,
  createDebugTransform,
  collectStream,
} from "./stream-parser.js";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Package version.
 * Updated automatically during build.
 */
export const VERSION = "0.1.0";
