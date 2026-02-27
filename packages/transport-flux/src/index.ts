/**
 * @summary Main entry point for @fluxpointstudios/orynq-sdk-transport-flux package.
 *
 * This package provides the FluxTransport implementation for handling
 * T-Backend style wire format in the orynq-sdk payment layer. The Flux
 * protocol uses JSON invoice bodies and X-* prefixed headers.
 *
 * Key features:
 * - Detect Flux 402 Payment Required responses
 * - Parse JSON invoice body into PaymentRequest format
 * - Apply payment proof headers (X-Invoice-Id, X-Payment, etc.)
 * - Convert chain formats (dash <-> CAIP-2)
 *
 * Usage:
 * ```typescript
 * import { createFluxTransport } from "@fluxpointstudios/orynq-sdk-transport-flux";
 *
 * const flux = createFluxTransport();
 *
 * // Check for 402
 * if (flux.is402(response)) {
 *   const request = await flux.parse402(response);
 *   // ... handle payment ...
 *   const paidReq = flux.applyPayment(originalReq, proof, request.invoiceId);
 *   const result = await fetch(paidReq);
 * }
 * ```
 *
 * Used by:
 * - @fluxpointstudios/orynq-sdk-client for automatic payment flow
 * - Direct integration with Flux/T-Backend services
 */

import { type PaymentRequest, type PaymentProof } from "@fluxpointstudios/orynq-sdk-core";
import { parse402Response } from "./parse.js";
import { applyPaymentToRequest } from "./apply.js";
import type { FluxTransport, ApplyPaymentOptions } from "./types.js";

// ---------------------------------------------------------------------------
// FluxTransport Factory
// ---------------------------------------------------------------------------

/**
 * Create a FluxTransport instance.
 *
 * The FluxTransport handles the Flux (T-Backend) wire format for payment
 * requests and responses. It provides methods to:
 *
 * 1. Detect Flux 402 responses (vs x402 or other protocols)
 * 2. Parse invoice details from JSON response body
 * 3. Apply payment proof headers to retry requests
 *
 * @returns FluxTransport instance
 *
 * @example
 * const flux = createFluxTransport();
 *
 * const response = await fetch("https://api.example.com/paid-resource");
 *
 * if (flux.is402(response)) {
 *   // Parse the payment requirement
 *   const request = await flux.parse402(response);
 *   console.log(`Payment required: ${request.amountUnits} ${request.asset}`);
 *
 *   // ... execute payment and get proof ...
 *
 *   // Retry with payment
 *   const paidReq = flux.applyPayment(
 *     new Request("https://api.example.com/paid-resource"),
 *     proof,
 *     request.invoiceId!
 *   );
 *   const result = await fetch(paidReq);
 * }
 */
export function createFluxTransport(): FluxTransport {
  return {
    /**
     * Check if a response is a Flux 402 Payment Required.
     *
     * Flux 402 responses are identified by:
     * - HTTP 402 status code
     * - JSON content type (application/json)
     * - Absence of PAYMENT-REQUIRED header (which indicates x402)
     *
     * @param res - Response to check
     * @returns true if response is a Flux 402
     */
    is402(res: Response): boolean {
      // Must be HTTP 402 status
      if (res.status !== 402) {
        return false;
      }

      // Must NOT have x402's PAYMENT-REQUIRED header
      // This distinguishes Flux from x402 protocol
      if (res.headers.has("PAYMENT-REQUIRED")) {
        return false;
      }

      // Must have JSON content type
      const contentType = res.headers.get("content-type");
      if (!contentType?.includes("application/json")) {
        return false;
      }

      return true;
    },

    /**
     * Parse a Flux 402 response into a PaymentRequest.
     *
     * Extracts invoice details from the JSON body and normalizes
     * to the protocol-neutral PaymentRequest format. Chain identifiers
     * are converted from dash format to CAIP-2.
     *
     * @param res - 402 Response to parse
     * @returns Normalized PaymentRequest
     * @throws Error if response cannot be parsed
     */
    async parse402(res: Response): Promise<PaymentRequest> {
      const request = await parse402Response(res);

      if (!request) {
        throw new Error(
          "Failed to parse Flux 402 response. " +
            "Expected JSON body with invoiceId, amount, currency, payTo, and chain fields."
        );
      }

      return request;
    },

    /**
     * Apply payment proof to a request.
     *
     * Creates a new Request with X-Invoice-Id and X-Payment headers
     * set for payment verification. The original request is not modified.
     *
     * @param req - Original request to clone and modify
     * @param proof - Payment proof (txHash, cborHex, etc.)
     * @param invoiceId - Invoice ID being paid
     * @returns New Request with payment headers applied
     */
    applyPayment(
      req: Request,
      proof: PaymentProof,
      invoiceId: string
    ): Request {
      return applyPaymentToRequest(req, proof, invoiceId);
    },
  };
}

// ---------------------------------------------------------------------------
// Extended Transport with Options
// ---------------------------------------------------------------------------

/**
 * Extended FluxTransport with additional options support.
 */
export interface ExtendedFluxTransport extends FluxTransport {
  /**
   * Apply payment proof to a request with additional options.
   *
   * @param req - Original request
   * @param proof - Payment proof
   * @param invoiceId - Invoice ID being paid
   * @param options - Additional header options
   * @returns New Request with all headers applied
   */
  applyPaymentWithOptions(
    req: Request,
    proof: PaymentProof,
    invoiceId: string,
    options: ApplyPaymentOptions
  ): Request;
}

/**
 * Create an extended FluxTransport with additional options support.
 *
 * This variant provides an additional method for applying payment headers
 * with partner attribution, wallet address, and other metadata.
 *
 * @returns ExtendedFluxTransport instance
 */
export function createExtendedFluxTransport(): ExtendedFluxTransport {
  const base = createFluxTransport();

  return {
    ...base,

    applyPaymentWithOptions(
      req: Request,
      proof: PaymentProof,
      invoiceId: string,
      options: ApplyPaymentOptions
    ): Request {
      return applyPaymentToRequest(req, proof, invoiceId, options);
    },
  };
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

// Types
export type {
  FluxInvoice,
  FluxPaymentResponse,
  FluxPaymentStatus,
  FluxTransport,
  ApplyPaymentOptions,
} from "./types.js";

// Parse utilities
export {
  parseFluxInvoice,
  parse402Response,
  looksLikeFluxResponse,
  extractInvoiceIdFromHeaders,
} from "./parse.js";

// Apply utilities
export {
  createPaymentHeader,
  applyPaymentHeaders,
  applyPaymentToRequest,
  hasPaymentHeaders,
  extractPaymentFromRequest,
  stripPaymentHeaders,
} from "./apply.js";
