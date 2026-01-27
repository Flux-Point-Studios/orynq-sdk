/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/transport-flux/src/types.ts
 * @summary Flux-specific types matching T-Backend wire format.
 *
 * This file defines the TypeScript interfaces for the Flux payment protocol,
 * which uses JSON invoice bodies and X-* prefixed headers for payment flows.
 *
 * The Flux protocol is used by T-Backend services and follows these conventions:
 * - 402 responses contain JSON body with invoice details
 * - Chain identifiers use dash format (e.g., "cardano-mainnet")
 * - Payment proof is sent via X-Payment header
 * - Invoice ID is tracked via X-Invoice-Id header
 *
 * Used by:
 * - parse.ts for parsing 402 responses into PaymentRequest
 * - apply.ts for applying payment headers to requests
 * - index.ts for the FluxTransport factory
 */

import type { PaymentRequest, PaymentProof } from "@poi-sdk/core";

// ---------------------------------------------------------------------------
// Flux Invoice Format (T-Backend wire format)
// ---------------------------------------------------------------------------

/**
 * T-Backend invoice format as received in 402 response body.
 *
 * This interface represents the JSON structure returned by Flux-compatible
 * servers when payment is required. All monetary amounts are strings to
 * prevent JavaScript precision issues with large numbers.
 */
export interface FluxInvoice {
  /**
   * Unique identifier for this invoice.
   * Used for idempotency and tracking payment status.
   */
  invoiceId: string;

  /**
   * Payment amount in atomic/smallest units as string.
   * Examples: "1000000" for 1 ADA, "1000000000000000000" for 1 ETH
   */
  amount: string;

  /**
   * Asset identifier.
   * - Native assets: "ADA", "ETH"
   * - Tokens: "USDC" or policy.assetHex format
   */
  currency: string;

  /**
   * Number of decimal places for display purposes.
   * ADA = 6, ETH = 18, USDC = 6
   */
  decimals?: number;

  /**
   * Recipient address in chain-native format.
   */
  payTo: string;

  /**
   * Blockchain identifier in wire format.
   * Uses dashes: "cardano-mainnet", "base-mainnet", etc.
   */
  chain: string;

  /**
   * ISO 8601 timestamp when invoice expires.
   * Optional - if not provided, invoice does not expire.
   */
  expiresAt?: string;

  /**
   * Partner/referrer identifier for attribution.
   * Used for tracking referrals and revenue sharing.
   */
  partner?: string;

  /**
   * Split payment outputs for multi-party payments.
   * Each split defines an additional or included payment recipient.
   */
  splits?: Array<{
    /** Recipient address */
    to: string;
    /** Amount in atomic units as string */
    amount: string;
    /** Role identifier (e.g., "platform", "creator", "referrer") */
    role?: string;
    /** Asset identifier; defaults to main currency if omitted */
    currency?: string;
  }>;

  /**
   * Split mode determines how split amounts relate to the main amount:
   * - "inclusive": splits are subtracted from amount (total = amount)
   * - "additional": splits are added to amount (total = amount + sum(splits))
   *
   * Defaults to "additional" if not specified.
   */
  splitMode?: "inclusive" | "additional";

  /**
   * Arbitrary metadata attached to the invoice.
   * Can include service-specific information.
   */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Flux Payment Response
// ---------------------------------------------------------------------------

/**
 * Payment status values in the Flux protocol lifecycle.
 */
export type FluxPaymentStatus =
  | "pending" // Payment initiated but not yet submitted
  | "submitted" // Transaction submitted to network
  | "confirmed" // Transaction confirmed on-chain
  | "consumed" // Payment has been used/claimed
  | "expired" // Invoice timeout exceeded
  | "failed"; // Payment failed (see error field)

/**
 * Response from Flux payment verification endpoints.
 */
export interface FluxPaymentResponse {
  /** Invoice identifier for the payment */
  invoiceId: string;

  /** Current status of the payment */
  status: FluxPaymentStatus;

  /** Transaction hash if submitted to blockchain */
  txHash?: string;

  /** Error message if payment failed */
  error?: string;
}

// ---------------------------------------------------------------------------
// Flux Transport Interface
// ---------------------------------------------------------------------------

/**
 * Transport interface for the Flux payment protocol.
 *
 * Provides methods to:
 * - Detect Flux 402 responses
 * - Parse invoice details from response body
 * - Apply payment proof headers to subsequent requests
 */
export interface FluxTransport {
  /**
   * Check if a response is a Flux 402 Payment Required.
   *
   * Flux 402 responses are identified by:
   * - HTTP 402 status code
   * - JSON content type
   * - Absence of PAYMENT-REQUIRED header (which indicates x402)
   *
   * @param res - Response to check
   * @returns true if response is a Flux 402
   */
  is402(res: Response): boolean;

  /**
   * Parse a Flux 402 response into a PaymentRequest.
   *
   * Extracts invoice details from the JSON body and normalizes
   * to the protocol-neutral PaymentRequest format.
   *
   * @param res - 402 Response to parse
   * @returns Normalized PaymentRequest
   * @throws Error if response cannot be parsed
   */
  parse402(res: Response): Promise<PaymentRequest>;

  /**
   * Apply payment proof to a request.
   *
   * Adds X-Invoice-Id and X-Payment headers to the request
   * for payment verification.
   *
   * @param req - Original request
   * @param proof - Payment proof (txHash, cborHex, etc.)
   * @param invoiceId - Invoice ID being paid
   * @returns New Request with payment headers
   */
  applyPayment(req: Request, proof: PaymentProof, invoiceId: string): Request;
}

// ---------------------------------------------------------------------------
// Configuration Options
// ---------------------------------------------------------------------------

/**
 * Options for applying payment headers.
 */
export interface ApplyPaymentOptions {
  /** Partner/referrer identifier */
  partner?: string;

  /** Payer's wallet address */
  walletAddress?: string;

  /** Blockchain identifier (wire format) */
  chain?: string;

  /** Idempotency key for duplicate detection */
  idempotencyKey?: string;
}
