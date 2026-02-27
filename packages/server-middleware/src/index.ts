/**
 * @summary Main entry point for @fluxpointstudios/orynq-sdk-server-middleware package.
 *
 * This package provides server middleware for implementing HTTP 402 Payment
 * Required flows with dual-protocol support (Flux and x402). It includes:
 *
 * - Express middleware (requirePayment)
 * - Fastify plugin (fastifyPayment)
 * - Protocol emitters for Flux and x402 402 responses
 * - Chain verifiers for Cardano and EVM payment verification
 * - Invoice storage with in-memory and interface for custom implementations
 * - Idempotency handling for request deduplication
 *
 * Key Features:
 * - Dual-protocol support: emit 402 responses in both Flux and x402 formats
 * - Chain verification: verify payment proofs on Cardano and EVM chains
 * - Invoice management: create, track, and verify payment invoices
 * - Idempotency: prevent duplicate payments with automatic deduplication
 * - CORS configuration: helper for browser-based payment flows
 *
 * Usage (Express):
 * ```typescript
 * import express from "express";
 * import {
 *   requirePayment,
 *   MemoryInvoiceStore,
 *   CardanoVerifier,
 *   cors402,
 * } from "@fluxpointstudios/orynq-sdk-server-middleware";
 *
 * const app = express();
 * const store = new MemoryInvoiceStore();
 * const verifier = new CardanoVerifier({ blockfrostProjectId: "..." });
 *
 * app.get(
 *   "/api/protected",
 *   requirePayment({
 *     price: () => ({
 *       chain: "cardano:mainnet",
 *       asset: "ADA",
 *       amountUnits: "1000000",
 *     }),
 *     payTo: "addr1...",
 *     storage: store,
 *     verifiers: [verifier],
 *   }),
 *   (req, res) => {
 *     res.json({ message: "Paid access granted!" });
 *   }
 * );
 * ```
 *
 * Usage (Fastify):
 * ```typescript
 * import Fastify from "fastify";
 * import {
 *   fastifyPayment,
 *   MemoryInvoiceStore,
 *   EvmVerifier,
 * } from "@fluxpointstudios/orynq-sdk-server-middleware";
 *
 * const fastify = Fastify();
 * const store = new MemoryInvoiceStore();
 * const verifier = new EvmVerifier({ chains: ["eip155:8453"] });
 *
 * fastify.register(fastifyPayment, {
 *   price: () => ({
 *     chain: "eip155:8453",
 *     asset: "USDC",
 *     amountUnits: "1000000",
 *   }),
 *   payTo: "0x...",
 *   storage: store,
 *   verifiers: [verifier],
 *   routes: ["/api/protected/*"],
 * });
 * ```
 */

// ---------------------------------------------------------------------------
// Express Middleware
// ---------------------------------------------------------------------------

export {
  requirePayment,
  cors402,
  type RequirePaymentOptions,
  type PriceConfig,
  type SplitConfig,
  type RequestWithInvoice,
} from "./express.js";

// ---------------------------------------------------------------------------
// Fastify Plugin
// ---------------------------------------------------------------------------

export {
  fastifyPayment,
  type FastifyPaymentPluginOptions,
  type PriceConfig as FastifyPriceConfig,
  type SplitConfig as FastifySplitConfig,
} from "./fastify.js";

// ---------------------------------------------------------------------------
// Invoice Storage
// ---------------------------------------------------------------------------

export {
  MemoryInvoiceStore,
  type Invoice,
  type InvoiceStore,
  type CreateInvoiceParams,
  type InvoiceQuery,
} from "./invoice-store.js";

// ---------------------------------------------------------------------------
// Chain Verifiers
// ---------------------------------------------------------------------------

export {
  CardanoVerifier,
  type CardanoVerifierConfig,
} from "./verifiers/cardano.js";

export { EvmVerifier, type EvmVerifierConfig } from "./verifiers/evm.js";

export {
  type ChainVerifier,
  type VerificationResult,
  findVerifier,
  isChainSupported,
  getSupportedChains,
} from "./verifiers/interface.js";

// ---------------------------------------------------------------------------
// Protocol Emitters
// ---------------------------------------------------------------------------

export {
  createFlux402Response,
  buildFluxResponseBody,
  getFluxHeaders,
  caipToWireChain,
  wireChainToCAIP,
  type FluxResponse,
  type FluxSplit,
  type CreateFluxResponseOptions,
} from "./protocols/emit-flux.js";

export {
  createX402_402Response,
  buildX402Payload,
  encodePayload,
  decodePayload,
  getX402Headers,
  createPaymentResponse,
  type X402PaymentRequired,
  type CreateX402ResponseOptions,
} from "./protocols/emit-x402.js";

// ---------------------------------------------------------------------------
// Request Hash & Idempotency
// ---------------------------------------------------------------------------

export {
  hashRequest,
  hashRequestSync,
  requestsEqual,
  extractPath,
  extractQuery,
  type RequestHashOptions,
} from "./request-hash.js";

export {
  extractIdempotencyKey,
  processIdempotency,
  findDuplicateInvoice,
  isValidIdempotencyKey,
  normalizeIdempotencyKey,
  type IdempotencyConfig,
  type IdempotencyResult,
} from "./idempotency.js";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Package version.
 */
export const VERSION = "0.1.0";
