/**
 * @summary Apply payment proofs to outgoing requests via PAYMENT-SIGNATURE header.
 *
 * This file handles attaching x402 payment authorization to HTTP requests.
 * The x402 protocol uses the PAYMENT-SIGNATURE header to carry cryptographic
 * proof of payment authorization.
 *
 * Used by:
 * - index.ts X402Transport.applyPayment() implementation
 * - Client code that needs to manually attach payment headers
 */

import { X402_HEADERS, isX402SignatureProof } from "@fluxpointstudios/orynq-sdk-core";
import type { PaymentProof, X402SignatureProof } from "@fluxpointstudios/orynq-sdk-core";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create the PAYMENT-SIGNATURE header value from a payment proof.
 *
 * For x402 protocol, only x402-signature proofs are supported. The signature
 * is passed directly as the header value.
 *
 * @param proof - Payment proof to convert to header value
 * @returns Header value string (the signature)
 * @throws Error if the proof type is not supported for x402
 *
 * @example
 * ```typescript
 * const proof: X402SignatureProof = {
 *   kind: "x402-signature",
 *   signature: "0x1234...",
 *   payload: "..."
 * };
 * const headerValue = createPaymentSignatureHeader(proof);
 * headers.set("PAYMENT-SIGNATURE", headerValue);
 * ```
 */
export function createPaymentSignatureHeader(proof: PaymentProof): string {
  if (!isX402SignatureProof(proof)) {
    throw new Error(
      `Unsupported proof type for x402: "${proof.kind}". ` +
        `x402 protocol requires "x402-signature" proof type.`
    );
  }

  // Return the signature directly
  // The x402 spec expects the raw signature in the header
  return proof.signature;
}

/**
 * Create the PAYMENT-SIGNATURE header value with optional payload encoding.
 *
 * This function encodes the signature and optional payload as a base64-encoded
 * JSON object for more complex payment flows.
 *
 * @param proof - x402 signature proof
 * @returns Base64-encoded JSON header value
 *
 * @example
 * ```typescript
 * const proof: X402SignatureProof = {
 *   kind: "x402-signature",
 *   signature: "0x1234...",
 *   payload: "{\"amount\":\"1000000\"}"
 * };
 * const headerValue = createPaymentSignatureHeaderEncoded(proof);
 * ```
 */
export function createPaymentSignatureHeaderEncoded(
  proof: X402SignatureProof
): string {
  const data: Record<string, string> = {
    signature: proof.signature,
  };

  if (proof.payload) {
    data["payload"] = proof.payload;
  }

  const json = JSON.stringify(data);
  return encodeBase64(json);
}

/**
 * Apply payment headers to an existing Headers object.
 *
 * Mutates the headers object in place and returns it for chaining.
 *
 * @param headers - Headers object to modify
 * @param proof - Payment proof to apply
 * @returns The modified Headers object
 * @throws Error if the proof type is not supported for x402
 *
 * @example
 * ```typescript
 * const headers = new Headers();
 * applyPaymentHeaders(headers, proof);
 * // headers now contains PAYMENT-SIGNATURE
 * ```
 */
export function applyPaymentHeaders(
  headers: Headers,
  proof: PaymentProof
): Headers {
  const signatureValue = createPaymentSignatureHeader(proof);
  headers.set(X402_HEADERS.PAYMENT_SIGNATURE, signatureValue);
  return headers;
}

/**
 * Create a new Headers object with payment headers applied.
 *
 * Non-mutating version that creates a new Headers object.
 *
 * @param existingHeaders - Optional existing headers to copy
 * @param proof - Payment proof to apply
 * @returns New Headers object with payment signature
 * @throws Error if the proof type is not supported for x402
 *
 * @example
 * ```typescript
 * const headers = createPaymentHeaders(request.headers, proof);
 * const newRequest = new Request(request, { headers });
 * ```
 */
export function createPaymentHeaders(
  existingHeaders: Headers | HeadersInit | undefined,
  proof: PaymentProof
): Headers {
  const headers = new Headers(existingHeaders);
  return applyPaymentHeaders(headers, proof);
}

/**
 * Create a Request with payment headers applied.
 *
 * Creates a new Request object with the payment signature header added.
 * The original request is not modified.
 *
 * @param req - Original HTTP Request
 * @param proof - Payment proof to apply
 * @returns New Request with payment headers
 * @throws Error if the proof type is not supported for x402
 *
 * @example
 * ```typescript
 * const paidRequest = applyPaymentToRequest(originalRequest, proof);
 * const response = await fetch(paidRequest);
 * ```
 */
export function applyPaymentToRequest(req: Request, proof: PaymentProof): Request {
  const headers = new Headers(req.headers);
  applyPaymentHeaders(headers, proof);
  return new Request(req, { headers });
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Encode a string to base64.
 * Works in both Node.js and browser environments.
 *
 * @param str - UTF-8 string to encode
 * @returns Base64-encoded string
 */
function encodeBase64(str: string): string {
  // Node.js environment
  if (typeof Buffer !== "undefined") {
    return Buffer.from(str, "utf-8").toString("base64");
  }

  // Browser environment
  if (typeof btoa !== "undefined") {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    return btoa(binary);
  }

  throw new Error("No base64 encoding function available in this environment");
}
