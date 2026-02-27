/**
 * @summary Main entry point for @fluxpointstudios/orynq-sdk-transport-x402 package.
 *
 * This package provides the x402 protocol transport layer implementation,
 * wrapping Coinbase's @x402/* packages for the x402 wire format. It handles:
 *
 * - Detection of 402 responses with x402 headers
 * - Parsing PAYMENT-REQUIRED headers into protocol-neutral PaymentRequest
 * - Applying PAYMENT-SIGNATURE headers to requests with payment proofs
 * - Parsing PAYMENT-RESPONSE headers for settlement information
 *
 * The transport layer abstracts the wire protocol details, allowing client
 * code to work with orynq-sdk's unified PaymentRequest and PaymentProof types.
 *
 * Usage:
 * ```typescript
 * import { createX402Transport } from "@fluxpointstudios/orynq-sdk-transport-x402";
 *
 * const transport = createX402Transport();
 *
 * // Check for 402 response
 * if (transport.is402(response)) {
 *   const request = await transport.parse402(response);
 *   // ... process payment ...
 *   const paidRequest = transport.applyPayment(originalRequest, proof);
 *   const result = await fetch(paidRequest);
 *   const settlement = transport.parseSettlement(result);
 * }
 * ```
 *
 * Used by:
 * - @fluxpointstudios/orynq-sdk-client for automatic payment handling
 * - Custom client implementations needing x402 support
 */

import { X402_HEADERS } from "@fluxpointstudios/orynq-sdk-core";
import type { PaymentRequest, PaymentProof } from "@fluxpointstudios/orynq-sdk-core";

import { parse402Response, parsePaymentRequired, x402ToPaymentRequest } from "./parse.js";
import {
  applyPaymentHeaders,
  applyPaymentToRequest,
  createPaymentHeaders,
  createPaymentSignatureHeader,
  createPaymentSignatureHeaderEncoded,
} from "./apply.js";
import {
  parseSettlement,
  parsePaymentResponse,
  x402ResponseToSettlement,
  isPaymentSettled,
  getSettlementTxHash,
} from "./settlement.js";
import type {
  X402Transport,
  X402Settlement,
  X402PaymentRequired,
  X402PaymentResponse,
  X402Facilitator,
} from "./types.js";
import { isX402PaymentRequired, isX402PaymentResponse } from "./types.js";

// ---------------------------------------------------------------------------
// Transport Factory
// ---------------------------------------------------------------------------

/**
 * Create an x402 transport instance.
 *
 * The transport provides a unified interface for handling x402 protocol
 * operations including request detection, parsing, and header manipulation.
 *
 * @returns X402Transport instance
 *
 * @example
 * ```typescript
 * import { createX402Transport } from "@fluxpointstudios/orynq-sdk-transport-x402";
 *
 * const transport = createX402Transport();
 *
 * // In a fetch wrapper or interceptor:
 * async function fetchWithPayment(url: string, options?: RequestInit) {
 *   let response = await fetch(url, options);
 *
 *   if (transport.is402(response)) {
 *     const paymentRequest = await transport.parse402(response);
 *     const proof = await processPayment(paymentRequest);
 *     const request = new Request(url, options);
 *     const paidRequest = transport.applyPayment(request, proof);
 *     response = await fetch(paidRequest);
 *
 *     const settlement = transport.parseSettlement(response);
 *     if (settlement && !settlement.success) {
 *       throw new Error(`Payment failed: ${settlement.error}`);
 *     }
 *   }
 *
 *   return response;
 * }
 * ```
 */
export function createX402Transport(): X402Transport {
  return {
    /**
     * Check if a response is a 402 Payment Required with x402 headers.
     *
     * A response is considered an x402 payment requirement if:
     * 1. The status code is 402 (Payment Required)
     * 2. The PAYMENT-REQUIRED header is present
     *
     * @param res - HTTP Response to check
     * @returns true if this is an x402 payment required response
     */
    is402(res: Response): boolean {
      return res.status === 402 && res.headers.has(X402_HEADERS.PAYMENT_REQUIRED);
    },

    /**
     * Parse a 402 response to extract the payment request.
     *
     * Decodes the base64-encoded JSON from the PAYMENT-REQUIRED header
     * and converts it to orynq-sdk's protocol-neutral PaymentRequest format.
     *
     * @param res - HTTP Response containing x402 payment headers
     * @returns Protocol-neutral PaymentRequest with protocol: "x402"
     * @throws Error if the response does not contain valid x402 payment headers
     */
    async parse402(res: Response): Promise<PaymentRequest> {
      const paymentRequest = parse402Response(res);

      if (!paymentRequest) {
        throw new Error(
          `Cannot parse x402 payment request: missing ${X402_HEADERS.PAYMENT_REQUIRED} header`
        );
      }

      return paymentRequest;
    },

    /**
     * Apply a payment proof to an outgoing request.
     *
     * Creates a new Request with the PAYMENT-SIGNATURE header containing
     * the payment proof. Only x402-signature proofs are supported.
     *
     * @param req - Original HTTP Request
     * @param proof - Payment proof (must be x402-signature type)
     * @returns New Request with payment headers applied
     * @throws Error if the proof type is not "x402-signature"
     */
    applyPayment(req: Request, proof: PaymentProof): Request {
      return applyPaymentToRequest(req, proof);
    },

    /**
     * Parse settlement information from a response after payment.
     *
     * Extracts and decodes the PAYMENT-RESPONSE header if present.
     * Returns null if no settlement header is found.
     *
     * @param res - HTTP Response that may contain settlement headers
     * @returns Settlement information or null if not present
     */
    parseSettlement(res: Response): X402Settlement | null {
      return parseSettlement(res);
    },
  };
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

// Types
export type {
  X402Transport,
  X402Settlement,
  X402PaymentRequired,
  X402PaymentResponse,
  X402Facilitator,
};

// Type guards
export { isX402PaymentRequired, isX402PaymentResponse };

// Parse utilities
export { parse402Response, parsePaymentRequired, x402ToPaymentRequest };

// Apply utilities
export {
  applyPaymentHeaders,
  applyPaymentToRequest,
  createPaymentHeaders,
  createPaymentSignatureHeader,
  createPaymentSignatureHeaderEncoded,
};

// Settlement utilities
export {
  parseSettlement,
  parsePaymentResponse,
  x402ResponseToSettlement,
  isPaymentSettled,
  getSettlementTxHash,
};

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Package version.
 * Updated automatically during build.
 */
export const VERSION = "0.0.0";
