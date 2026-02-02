/**
 * @summary Central export point for protocol emitters.
 *
 * This file re-exports the Flux and x402 protocol response emitters.
 * Both protocols are used to communicate payment requirements to clients
 * via HTTP 402 responses.
 *
 * Usage:
 * ```typescript
 * import {
 *   createFlux402Response,
 *   createX402_402Response,
 * } from "@fluxpointstudios/orynq-sdk-server-middleware";
 * ```
 */

// Flux protocol exports
export {
  createFlux402Response,
  buildFluxResponseBody,
  getFluxHeaders,
  caipToWireChain,
  wireChainToCAIP,
  type FluxResponse,
  type FluxSplit,
  type CreateFluxResponseOptions,
} from "./emit-flux.js";

// x402 protocol exports
export {
  createX402_402Response,
  buildX402Payload,
  encodePayload,
  decodePayload,
  getX402Headers,
  createPaymentResponse,
  type X402PaymentRequired,
  type CreateX402ResponseOptions,
} from "./emit-x402.js";
