/**
 * @summary x402 protocol-specific type definitions for the transport layer.
 *
 * This file defines types specific to the x402 wire format as used by
 * Coinbase's @x402/* packages. These types represent the raw protocol data
 * before conversion to poi-sdk's protocol-neutral PaymentRequest format.
 *
 * The x402 protocol uses version "1" in the wire format payload.
 *
 * Used by:
 * - parse.ts for decoding PAYMENT-REQUIRED headers
 * - settlement.ts for decoding PAYMENT-RESPONSE headers
 * - index.ts for the X402Transport interface implementation
 */

import type { PaymentRequest, PaymentProof } from "@fluxpointstudios/poi-sdk-core";

// ---------------------------------------------------------------------------
// x402 Raw Protocol Types
// ---------------------------------------------------------------------------

/**
 * Raw x402 payment requirement as received in the PAYMENT-REQUIRED header.
 * This is the decoded JSON structure from the base64-encoded header value.
 *
 * Fields follow the x402 specification (Coinbase standard).
 */
export interface X402PaymentRequired {
  /** x402 protocol version (currently "1") */
  version: string;

  /** Payment scheme identifier (e.g., "exact") */
  scheme: string;

  /**
   * Network identifier in CAIP-2 format.
   * @example "eip155:8453" for Base mainnet
   * @example "eip155:84532" for Base Sepolia
   */
  network: string;

  /**
   * Maximum payment amount required in atomic units.
   * Represented as a string to prevent precision loss.
   */
  maxAmountRequired: string;

  /** Resource identifier (typically the URL path) */
  resource: string;

  /** Human-readable description of what is being paid for */
  description?: string;

  /** MIME type of the content being purchased */
  mimeType?: string;

  /** Payment recipient address */
  payTo: string;

  /** Maximum time in seconds before the payment request expires */
  maxTimeoutSeconds?: number;

  /** Asset address for ERC-20 tokens (omitted for native ETH) */
  asset?: string;

  /** Facilitator configuration for delegated payment processing */
  facilitator?: X402Facilitator;

  /** Additional custom fields from the server */
  extra?: Record<string, unknown>;
}

/**
 * x402 facilitator configuration.
 */
export interface X402Facilitator {
  /** Provider identifier (e.g., "coinbase") */
  provider: string;

  /** Facilitator API endpoint URL */
  endpoint?: string;
}

// ---------------------------------------------------------------------------
// x402 Settlement Types
// ---------------------------------------------------------------------------

/**
 * x402 settlement response from the PAYMENT-RESPONSE header.
 * Contains the result of payment verification.
 */
export interface X402Settlement {
  /** Transaction hash if payment was on-chain */
  txHash?: string;

  /** ISO 8601 timestamp when the payment was settled */
  settledAt?: string;

  /** Whether the payment was successfully processed */
  success: boolean;

  /** Error message if the payment failed */
  error?: string;

  /** Additional response data from the facilitator */
  extra?: Record<string, unknown>;
}

/**
 * Raw x402 payment response as received in the PAYMENT-RESPONSE header.
 * This is the decoded JSON structure before normalization.
 */
export interface X402PaymentResponse {
  /** Whether the payment was successful */
  success: boolean;

  /** Transaction hash if applicable */
  txHash?: string;

  /** Settlement timestamp */
  settledAt?: string;

  /** Error message if failed */
  error?: string;

  /** Network where the payment was processed */
  network?: string;

  /** Additional response fields */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// X402 Transport Interface
// ---------------------------------------------------------------------------

/**
 * x402 transport layer interface for handling payment protocol operations.
 *
 * This interface abstracts the x402 wire protocol operations:
 * - Detecting 402 responses with x402 headers
 * - Parsing payment requirements from headers
 * - Applying payment proofs to requests
 * - Parsing settlement responses
 */
export interface X402Transport {
  /**
   * Check if a response is a 402 Payment Required with x402 headers.
   *
   * @param res - HTTP Response to check
   * @returns true if this is an x402 payment required response
   */
  is402(res: Response): boolean;

  /**
   * Parse a 402 response to extract the payment request.
   *
   * @param res - HTTP Response containing x402 payment headers
   * @returns Protocol-neutral PaymentRequest parsed from x402 headers
   * @throws Error if the response does not contain valid x402 payment headers
   */
  parse402(res: Response): Promise<PaymentRequest>;

  /**
   * Apply a payment proof to an outgoing request.
   *
   * @param req - Original HTTP Request
   * @param proof - Payment proof to attach
   * @returns New Request with payment headers applied
   * @throws Error if the proof type is not supported for x402
   */
  applyPayment(req: Request, proof: PaymentProof): Request;

  /**
   * Parse settlement information from a response after payment.
   *
   * @param res - HTTP Response that may contain settlement headers
   * @returns Settlement information or null if not present
   */
  parseSettlement(res: Response): X402Settlement | null;
}

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/**
 * Type guard to check if an object is a valid X402PaymentRequired.
 *
 * @param value - Value to check
 * @returns true if the value is a valid X402PaymentRequired object
 */
export function isX402PaymentRequired(
  value: unknown
): value is X402PaymentRequired {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  return (
    typeof obj["version"] === "string" &&
    typeof obj["scheme"] === "string" &&
    typeof obj["network"] === "string" &&
    typeof obj["maxAmountRequired"] === "string" &&
    typeof obj["resource"] === "string" &&
    typeof obj["payTo"] === "string"
  );
}

/**
 * Type guard to check if an object is a valid X402PaymentResponse.
 *
 * @param value - Value to check
 * @returns true if the value is a valid X402PaymentResponse object
 */
export function isX402PaymentResponse(
  value: unknown
): value is X402PaymentResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  return typeof obj["success"] === "boolean";
}
