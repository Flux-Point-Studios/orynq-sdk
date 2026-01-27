/**
 * @summary Main entry point for @fluxpointstudios/poi-sdk-gateway package.
 *
 * This package provides an x402 gateway server that bridges x402 clients to
 * a backend service (T-Backend) without requiring modifications to the backend.
 * The gateway handles x402 payment verification and sets trusted headers for
 * the backend to consume.
 *
 * Architecture:
 * ```
 * Browser/Client
 *      |
 *      v (x402 protocol)
 * +------------------+
 * |  x402 Gateway    |  <-- This package
 * |  (Node/Express)  |
 * +--------+---------+
 *          | (internal: X-Paid-Verified: 1)
 *          v
 * +------------------+
 * |   T-Backend      |  <-- Existing backend (unchanged)
 * +------------------+
 * ```
 *
 * Key Features:
 * - Proxies x402 requests to T-Backend
 * - Sets X-Paid-Verified: 1 header for trusted forwarding
 * - Generates deterministic invoiceIds for idempotency
 * - Supports both x402 and Flux protocols
 * - CORS configured for browser x402 clients
 * - Environment variable configuration for deployment
 *
 * Usage:
 * ```typescript
 * import { startGateway } from "@fluxpointstudios/poi-sdk-gateway";
 *
 * await startGateway({
 *   backendUrl: "http://localhost:8000",
 *   payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f9fEDb",
 *   chains: ["eip155:8453"],
 *   pricing: async (req) => ({
 *     chain: "eip155:8453",
 *     asset: "USDC",
 *     amountUnits: "1000000", // 1 USDC
 *   }),
 * });
 * ```
 *
 * CLI Usage:
 * ```bash
 * export BACKEND_URL=http://localhost:8000
 * export PAY_TO=0x...
 * npx poi-gateway
 * ```
 */

// ---------------------------------------------------------------------------
// Server Exports
// ---------------------------------------------------------------------------

export { createGatewayServer, startGateway, type GatewayServer } from "./server.js";

// ---------------------------------------------------------------------------
// Forward Middleware Exports
// ---------------------------------------------------------------------------

export {
  createForwardMiddleware,
  createSimpleForwardHandler,
  type GatewayRequest,
  type ForwardEventHandlers,
} from "./forward.js";

// ---------------------------------------------------------------------------
// Invoice Bridge Exports
// ---------------------------------------------------------------------------

export {
  generateInvoiceId,
  generateInvoiceIdSync,
  extractSettlementInfo,
  parseSettlementHeader,
  isValidInvoiceId,
  normalizeInvoiceId,
  type SettlementInfo,
  type X402ResponseData,
} from "./invoice-bridge.js";

// ---------------------------------------------------------------------------
// Configuration Exports
// ---------------------------------------------------------------------------

export {
  type GatewayConfig,
  type PricingResult,
  type X402SettlementConfig,
  DEFAULT_CONFIG,
  ConfigurationError,
  validateConfig,
  mergeConfig,
} from "./config.js";

// ---------------------------------------------------------------------------
// x402 Settlement Exports
// ---------------------------------------------------------------------------

export {
  type StoredInvoice,
  type PaymentRequirements,
  type SplitOutput,
  type InvoiceStatus,
  type X402SettlementStore,
  MemoryX402SettlementStore,
} from "./x402-settlement-store.js";

export {
  type SettlementMode,
  type SettlementResult,
  type DecodedPaymentSignature,
  type FacilitatorRequest,
  type FacilitatorResponse,
  settleX402Payment,
  decodePaymentSignature,
  verifySignatureMatchesInvoice,
  callFacilitator,
  validateTrustMode,
  PaymentMismatchError,
  SettlementError,
  TrustModeError,
} from "./x402-settler.js";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Package version.
 * Updated automatically during build.
 */
export const VERSION = "0.0.0";
