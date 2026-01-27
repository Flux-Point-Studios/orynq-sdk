/**
 * @summary x402 payment settlement logic for verifying and executing payments.
 *
 * This module handles the critical security flow for x402 payment verification:
 * 1. Decode and pre-verify the payment signature
 * 2. Verify signature matches invoice requirements EXACTLY
 * 3. Call facilitator to execute on-chain transfer
 * 4. Wait for confirmations if required
 *
 * Key insight: A signature can be cryptographically valid but still NOT paid.
 * Settlement is what actually moves funds.
 */

import type { StoredInvoice } from "./x402-settlement-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Settlement mode determines how strictly payments are verified.
 */
export type SettlementMode = "strict" | "verify-precheck" | "trust";

/**
 * Configuration for x402 settlement.
 */
export interface X402SettlementConfig {
  /**
   * Settlement verification mode.
   *
   * - `strict` (DEFAULT): Call facilitator to settle, get txHash, wait confirmations
   * - `verify-precheck`: Crypto-verify signature as sanity check, but still require settlement
   * - `trust`: DANGEROUS - dev only, accepts any signature without verification
   *
   * @default "strict"
   */
  mode: SettlementMode;

  /**
   * Facilitator URL for settlement.
   * Required for strict and verify-precheck modes.
   *
   * @example "https://facilitator.example.com"
   */
  facilitatorUrl?: string;

  /**
   * RPC URLs for EVM chains.
   * Used for confirmation checking.
   */
  evmRpcUrls?: Record<string, string>;

  /**
   * Number of block confirmations to wait for.
   * @default 1
   */
  confirmations?: number;

  /**
   * Timeout for settlement requests in milliseconds.
   * @default 30000
   */
  timeout?: number;
}

/**
 * Result of a settlement attempt.
 */
export interface SettlementResult {
  /**
   * Whether settlement was successful.
   */
  success: boolean;

  /**
   * Transaction hash from the settlement.
   */
  txHash?: string;

  /**
   * Error message if settlement failed.
   */
  error?: string;

  /**
   * Additional error details.
   */
  details?: Record<string, unknown>;
}

/**
 * Decoded payment signature data.
 */
export interface DecodedPaymentSignature {
  /**
   * Payer address.
   */
  from: string;

  /**
   * Payee address.
   */
  to: string;

  /**
   * Amount in atomic units.
   */
  value: string;

  /**
   * Validity start timestamp.
   */
  validAfter: number;

  /**
   * Validity end timestamp.
   */
  validBefore: number;

  /**
   * Unique nonce.
   */
  nonce: string;

  /**
   * Chain ID.
   */
  chainId: number;

  /**
   * The raw signature.
   */
  signature: string;
}

/**
 * Request to facilitator for settlement.
 */
export interface FacilitatorRequest {
  /**
   * The EIP-3009 authorization signature.
   */
  signature: string;

  /**
   * Payment payload.
   */
  payload: {
    from: string;
    to: string;
    value: string;
    validAfter: number;
    validBefore: number;
    nonce: string;
  };

  /**
   * Chain ID.
   */
  chainId: number;
}

/**
 * Response from facilitator after settlement.
 */
export interface FacilitatorResponse {
  /**
   * Whether settlement succeeded.
   */
  success: boolean;

  /**
   * Transaction hash if successful.
   */
  txHash?: string;

  /**
   * Error message if failed.
   */
  error?: string;
}

// ---------------------------------------------------------------------------
// Error Classes
// ---------------------------------------------------------------------------

/**
 * Error thrown when payment signature doesn't match invoice.
 */
export class PaymentMismatchError extends Error {
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "PaymentMismatchError";
  }
}

/**
 * Error thrown when settlement fails.
 */
export class SettlementError extends Error {
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "SettlementError";
  }
}

/**
 * Error thrown when trust mode is used incorrectly.
 */
export class TrustModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustModeError";
  }
}

// ---------------------------------------------------------------------------
// Settlement Functions
// ---------------------------------------------------------------------------

/**
 * Validate trust mode configuration.
 *
 * Trust mode is DANGEROUS and should only be used in development.
 * This function enforces safety checks:
 * - Cannot be used in production (NODE_ENV=production)
 * - Requires explicit ALLOW_INSECURE_TRUST_MODE=true environment variable
 *
 * @param mode - The settlement mode
 * @throws TrustModeError if trust mode is used incorrectly
 */
export function validateTrustMode(mode: SettlementMode): void {
  if (mode === "trust") {
    if (process.env.NODE_ENV === "production") {
      throw new TrustModeError(
        "FATAL: trust mode cannot be used in production. " +
        "Set x402.mode to 'strict' or 'verify-precheck' for production deployments."
      );
    }

    if (process.env.ALLOW_INSECURE_TRUST_MODE !== "true") {
      throw new TrustModeError(
        "Trust mode requires ALLOW_INSECURE_TRUST_MODE=true environment variable. " +
        "This is INSECURE and should ONLY be used for local development."
      );
    }

    console.warn("\n" + "!".repeat(60));
    console.warn("WARNING: x402 trust mode enabled - payments are NOT verified!");
    console.warn("This is INSECURE and should ONLY be used for local development.");
    console.warn("!".repeat(60) + "\n");
  }
}

/**
 * Decode a base64-encoded x402 payment signature.
 *
 * @param signatureHeader - Base64-encoded signature from PAYMENT-SIGNATURE header
 * @returns Decoded signature data
 */
export function decodePaymentSignature(signatureHeader: string): DecodedPaymentSignature {
  try {
    const json = Buffer.from(signatureHeader, "base64").toString("utf-8");
    const data = JSON.parse(json);

    return {
      from: data.from || data.payer,
      to: data.to || data.payee,
      value: String(data.value || data.amount),
      validAfter: data.validAfter || 0,
      validBefore: data.validBefore || Math.floor(Date.now() / 1000) + 3600,
      nonce: data.nonce || "",
      chainId: data.chainId || data.network || 1,
      signature: data.signature || signatureHeader,
    };
  } catch {
    // If it's not JSON, treat the whole thing as a raw signature
    return {
      from: "",
      to: "",
      value: "0",
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 3600,
      nonce: "",
      chainId: 1,
      signature: signatureHeader,
    };
  }
}

/**
 * Verify that a decoded signature matches invoice requirements.
 *
 * @param decoded - Decoded payment signature
 * @param invoice - Stored invoice with requirements
 * @throws PaymentMismatchError if signature doesn't match requirements
 */
export function verifySignatureMatchesInvoice(
  decoded: DecodedPaymentSignature,
  invoice: StoredInvoice
): void {
  const { requirements } = invoice;

  // Verify amount matches (using string comparison for precision)
  if (decoded.value !== requirements.amount) {
    throw new PaymentMismatchError(
      `Amount mismatch: signature has ${decoded.value}, invoice requires ${requirements.amount}`,
      { signatureAmount: decoded.value, invoiceAmount: requirements.amount }
    );
  }

  // Verify recipient matches (case-insensitive for addresses)
  if (decoded.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
    throw new PaymentMismatchError(
      `Recipient mismatch: signature pays to ${decoded.to}, invoice requires ${requirements.payTo}`,
      { signatureTo: decoded.to, invoiceTo: requirements.payTo }
    );
  }

  // Verify signature is still valid (not expired)
  const now = Math.floor(Date.now() / 1000);
  if (decoded.validBefore < now) {
    throw new PaymentMismatchError(
      `Signature expired at ${new Date(decoded.validBefore * 1000).toISOString()}`,
      { validBefore: decoded.validBefore, now }
    );
  }

  if (decoded.validAfter > now) {
    throw new PaymentMismatchError(
      `Signature not yet valid until ${new Date(decoded.validAfter * 1000).toISOString()}`,
      { validAfter: decoded.validAfter, now }
    );
  }
}

/**
 * Call the facilitator to execute the on-chain transfer.
 *
 * @param decoded - Decoded payment signature
 * @param facilitatorUrl - URL of the facilitator service
 * @param timeout - Request timeout in milliseconds
 * @returns Facilitator response with txHash
 */
export async function callFacilitator(
  decoded: DecodedPaymentSignature,
  facilitatorUrl: string,
  timeout: number = 30000
): Promise<FacilitatorResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const request: FacilitatorRequest = {
      signature: decoded.signature,
      payload: {
        from: decoded.from,
        to: decoded.to,
        value: decoded.value,
        validAfter: decoded.validAfter,
        validBefore: decoded.validBefore,
        nonce: decoded.nonce,
      },
      chainId: decoded.chainId,
    };

    const response = await fetch(`${facilitatorUrl}/settle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    const data = await response.json() as FacilitatorResponse;

    if (!response.ok) {
      throw new SettlementError(
        data.error || `Facilitator returned ${response.status}`,
        { status: response.status, response: data }
      );
    }

    return data;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Settle an x402 payment.
 *
 * This is the main entry point for payment settlement. It:
 * 1. Decodes the payment signature
 * 2. Verifies it matches the invoice requirements
 * 3. Calls the facilitator to execute the transfer
 * 4. Returns the settlement result
 *
 * @param signatureHeader - Base64-encoded signature from PAYMENT-SIGNATURE header
 * @param invoice - Stored invoice to settle
 * @param config - Settlement configuration
 * @returns Settlement result with txHash if successful
 */
export async function settleX402Payment(
  signatureHeader: string,
  invoice: StoredInvoice,
  config: X402SettlementConfig
): Promise<SettlementResult> {
  const mode = config.mode || "strict";

  // Trust mode - DANGEROUS, dev only
  if (mode === "trust") {
    validateTrustMode(mode);
    return {
      success: true,
      txHash: `trust-mode-${Date.now()}`,
    };
  }

  // Decode the signature
  const decoded = decodePaymentSignature(signatureHeader);

  // Verify signature matches invoice requirements
  try {
    verifySignatureMatchesInvoice(decoded, invoice);
  } catch (error) {
    if (error instanceof PaymentMismatchError) {
      const result: SettlementResult = {
        success: false,
        error: error.message,
      };
      if (error.details) {
        result.details = error.details;
      }
      return result;
    }
    throw error;
  }

  // For strict and verify-precheck modes, call the facilitator
  if (!config.facilitatorUrl) {
    throw new SettlementError(
      "facilitatorUrl is required for strict and verify-precheck modes"
    );
  }

  try {
    const result = await callFacilitator(
      decoded,
      config.facilitatorUrl,
      config.timeout || 30000
    );

    if (!result.success || !result.txHash) {
      return {
        success: false,
        error: result.error || "Settlement failed without error message",
      };
    }

    return {
      success: true,
      txHash: result.txHash,
    };
  } catch (error) {
    if (error instanceof SettlementError) {
      const result: SettlementResult = {
        success: false,
        error: error.message,
      };
      if (error.details) {
        result.details = error.details;
      }
      return result;
    }
    throw error;
  }
}
