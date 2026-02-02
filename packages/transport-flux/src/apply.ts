/**
 * @summary Apply Flux payment headers (X-Invoice-Id, X-Payment, etc.) to requests.
 *
 * This file handles applying payment proof and metadata headers to outgoing
 * requests in the Flux protocol format. The Flux protocol uses X-* prefixed
 * headers for payment information.
 *
 * Header mapping:
 * - X-Invoice-Id: Invoice being paid
 * - X-Payment: Payment proof (txHash or CBOR)
 * - X-Partner: Partner/referrer attribution
 * - X-Wallet-Address: Payer's wallet address
 * - X-Chain: Blockchain identifier
 * - X-Idempotency-Key: Request deduplication
 *
 * Used by:
 * - index.ts FluxTransport.applyPayment() method
 * - Client implementations for payment retry logic
 */

import { FLUX_HEADERS, type PaymentProof } from "@fluxpointstudios/poi-sdk-core";
import type { ApplyPaymentOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Payment Header Creation
// ---------------------------------------------------------------------------

/**
 * Create the payment header value from a PaymentProof.
 *
 * Extracts the appropriate proof string based on proof kind:
 * - cardano-txhash: Use the transaction hash
 * - cardano-signed-cbor: Use the CBOR hex
 * - evm-txhash: Use the transaction hash
 *
 * @param proof - Payment proof to convert
 * @returns Header value string
 * @throws Error if proof kind is not supported for Flux
 *
 * @example
 * const proof = { kind: "cardano-txhash", txHash: "abc123..." };
 * const header = createPaymentHeader(proof);
 * // header === "abc123..."
 */
export function createPaymentHeader(proof: PaymentProof): string {
  switch (proof.kind) {
    case "cardano-txhash":
      return proof.txHash;

    case "cardano-signed-cbor":
      return proof.cborHex;

    case "evm-txhash":
      return proof.txHash;

    case "x402-signature":
      // x402 signature proofs are not natively supported by Flux,
      // but we can pass the signature for compatibility
      throw new Error(
        `Unsupported proof kind for Flux transport: ${proof.kind}. ` +
          `Flux expects transaction hashes or signed CBOR, not x402 signatures.`
      );

    default:
      // Exhaustive check - TypeScript will error if a case is missing
      throw new Error(
        `Unsupported proof kind for Flux transport: ${(proof as PaymentProof).kind}`
      );
  }
}

// ---------------------------------------------------------------------------
// Header Application
// ---------------------------------------------------------------------------

/**
 * Apply payment headers to a Headers object.
 *
 * Sets the X-Invoice-Id and X-Payment headers, plus optional
 * metadata headers (partner, wallet address, chain, idempotency key).
 *
 * @param headers - Headers object to modify (mutated in place)
 * @param proof - Payment proof to apply
 * @param invoiceId - Invoice ID being paid
 * @param options - Optional additional headers
 * @returns The modified Headers object
 *
 * @example
 * const headers = new Headers();
 * const proof = { kind: "cardano-txhash", txHash: "abc123..." };
 * applyPaymentHeaders(headers, proof, "inv_456", {
 *   partner: "ref_789",
 *   walletAddress: "addr1...",
 * });
 */
export function applyPaymentHeaders(
  headers: Headers,
  proof: PaymentProof,
  invoiceId: string,
  options?: ApplyPaymentOptions
): Headers {
  // Required headers
  headers.set(FLUX_HEADERS.INVOICE_ID, invoiceId);
  headers.set(FLUX_HEADERS.PAYMENT, createPaymentHeader(proof));

  // Optional metadata headers
  if (options?.partner) {
    headers.set(FLUX_HEADERS.PARTNER, options.partner);
  }

  if (options?.walletAddress) {
    headers.set(FLUX_HEADERS.WALLET_ADDRESS, options.walletAddress);
  }

  if (options?.chain) {
    headers.set(FLUX_HEADERS.CHAIN, options.chain);
  }

  if (options?.idempotencyKey) {
    headers.set(FLUX_HEADERS.IDEMPOTENCY_KEY, options.idempotencyKey);
  }

  return headers;
}

// ---------------------------------------------------------------------------
// Request Modification
// ---------------------------------------------------------------------------

/**
 * Create a new Request with payment headers applied.
 *
 * Creates a copy of the request with payment proof headers added.
 * The original request is not modified.
 *
 * @param req - Original request
 * @param proof - Payment proof to apply
 * @param invoiceId - Invoice ID being paid
 * @param options - Optional additional headers
 * @returns New Request with payment headers
 *
 * @example
 * const req = new Request("https://api.example.com/resource");
 * const proof = { kind: "cardano-txhash", txHash: "abc123..." };
 * const paidReq = applyPaymentToRequest(req, proof, "inv_456");
 * // paidReq has X-Invoice-Id and X-Payment headers set
 */
export function applyPaymentToRequest(
  req: Request,
  proof: PaymentProof,
  invoiceId: string,
  options?: ApplyPaymentOptions
): Request {
  // Create new Headers from existing request headers
  const headers = new Headers(req.headers);

  // Apply payment headers
  applyPaymentHeaders(headers, proof, invoiceId, options);

  // Create and return new Request with modified headers
  return new Request(req, { headers });
}

// ---------------------------------------------------------------------------
// Header Utilities
// ---------------------------------------------------------------------------

/**
 * Check if a request has payment headers applied.
 *
 * @param req - Request to check
 * @returns true if X-Invoice-Id and X-Payment are present
 */
export function hasPaymentHeaders(req: Request): boolean {
  return (
    req.headers.has(FLUX_HEADERS.INVOICE_ID) &&
    req.headers.has(FLUX_HEADERS.PAYMENT)
  );
}

/**
 * Extract payment information from request headers.
 *
 * @param req - Request to extract from
 * @returns Object with invoiceId and payment, or null if not present
 */
export function extractPaymentFromRequest(
  req: Request
): { invoiceId: string; payment: string } | null {
  const invoiceId = req.headers.get(FLUX_HEADERS.INVOICE_ID);
  const payment = req.headers.get(FLUX_HEADERS.PAYMENT);

  if (!invoiceId || !payment) {
    return null;
  }

  return { invoiceId, payment };
}

/**
 * Remove payment headers from a request.
 *
 * Creates a new request without payment headers.
 * Useful for retrying without payment proof.
 *
 * @param req - Request to strip
 * @returns New Request without payment headers
 */
export function stripPaymentHeaders(req: Request): Request {
  const headers = new Headers(req.headers);

  // Remove all Flux payment-related headers
  headers.delete(FLUX_HEADERS.INVOICE_ID);
  headers.delete(FLUX_HEADERS.PAYMENT);
  headers.delete(FLUX_HEADERS.PARTNER);
  headers.delete(FLUX_HEADERS.WALLET_ADDRESS);
  headers.delete(FLUX_HEADERS.CHAIN);
  headers.delete(FLUX_HEADERS.IDEMPOTENCY_KEY);

  return new Request(req, { headers });
}
