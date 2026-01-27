/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/core/src/types/errors.ts
 * @summary Custom error classes for payment-related failures.
 *
 * This file defines a hierarchy of typed errors for precise error handling
 * in payment flows. Each error type carries relevant context for debugging
 * and programmatic error handling.
 *
 * Used by:
 * - Payer implementations to signal specific failure modes
 * - Middleware to catch and handle payment errors
 * - Client code to provide meaningful error messages to users
 */

import type { PaymentRequest, PaymentProof } from "./payment.js";

// ---------------------------------------------------------------------------
// Base Payment Error
// ---------------------------------------------------------------------------

/**
 * Base class for all payment-related errors.
 *
 * Provides common functionality including error code and optional cause.
 */
export abstract class PaymentError extends Error {
  /** Machine-readable error code for programmatic handling */
  abstract readonly code: string;

  /** Original error that caused this error, if any */
  readonly cause?: Error | undefined;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = this.constructor.name;
    this.cause = cause;

    // Maintains proper stack trace for where our error was thrown (V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Convert to a plain object for serialization.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      cause: this.cause?.message,
    };
  }
}

// ---------------------------------------------------------------------------
// Payment Required Error
// ---------------------------------------------------------------------------

/**
 * Error thrown when a resource requires payment (HTTP 402).
 *
 * Contains the payment request that must be fulfilled to access the resource.
 */
export class PaymentRequiredError extends PaymentError {
  readonly code = "PAYMENT_REQUIRED" as const;

  /** The payment request that must be fulfilled */
  readonly request: PaymentRequest;

  /** The protocol that sent this requirement */
  readonly protocol: "flux" | "x402";

  constructor(
    request: PaymentRequest,
    message = "Payment required to access this resource"
  ) {
    super(message);
    this.request = request;
    this.protocol = request.protocol;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      request: this.request,
      protocol: this.protocol,
    };
  }
}

// ---------------------------------------------------------------------------
// Budget Exceeded Error
// ---------------------------------------------------------------------------

/**
 * Error thrown when a payment would exceed configured budget limits.
 */
export class BudgetExceededError extends PaymentError {
  readonly code = "BUDGET_EXCEEDED" as const;

  /** The requested amount in atomic units */
  readonly requestedAmount: string;

  /** The current budget limit in atomic units */
  readonly budgetLimit: string;

  /** The already-spent amount in atomic units */
  readonly spentAmount: string;

  /** Budget period (e.g., "daily", "per-request") */
  readonly period: string;

  constructor(
    requestedAmount: string,
    budgetLimit: string,
    spentAmount: string,
    period = "daily"
  ) {
    const remaining = BigInt(budgetLimit) - BigInt(spentAmount);
    super(
      `Budget exceeded: requested ${requestedAmount}, ` +
        `but only ${remaining.toString()} remaining of ${budgetLimit} ${period} limit`
    );
    this.requestedAmount = requestedAmount;
    this.budgetLimit = budgetLimit;
    this.spentAmount = spentAmount;
    this.period = period;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      requestedAmount: this.requestedAmount,
      budgetLimit: this.budgetLimit,
      spentAmount: this.spentAmount,
      period: this.period,
    };
  }
}

// ---------------------------------------------------------------------------
// Insufficient Balance Error
// ---------------------------------------------------------------------------

/**
 * Error thrown when wallet balance is insufficient for the payment.
 */
export class InsufficientBalanceError extends PaymentError {
  readonly code = "INSUFFICIENT_BALANCE" as const;

  /** The required amount in atomic units */
  readonly requiredAmount: string;

  /** The available balance in atomic units */
  readonly availableBalance: string;

  /** The asset that is insufficient */
  readonly asset: string;

  /** The chain where the balance is insufficient */
  readonly chain: string;

  constructor(
    requiredAmount: string,
    availableBalance: string,
    asset: string,
    chain: string
  ) {
    const deficit = BigInt(requiredAmount) - BigInt(availableBalance);
    super(
      `Insufficient ${asset} balance on ${chain}: ` +
        `need ${requiredAmount}, have ${availableBalance} (short by ${deficit.toString()})`
    );
    this.requiredAmount = requiredAmount;
    this.availableBalance = availableBalance;
    this.asset = asset;
    this.chain = chain;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      requiredAmount: this.requiredAmount,
      availableBalance: this.availableBalance,
      asset: this.asset,
      chain: this.chain,
    };
  }
}

// ---------------------------------------------------------------------------
// Invoice Expired Error
// ---------------------------------------------------------------------------

/**
 * Error thrown when attempting to pay an expired invoice.
 */
export class InvoiceExpiredError extends PaymentError {
  readonly code = "INVOICE_EXPIRED" as const;

  /** The expired invoice ID */
  readonly invoiceId: string;

  /** When the invoice expired (ISO 8601) */
  readonly expiredAt?: string | undefined;

  constructor(invoiceId: string, expiredAt?: string) {
    const atStr = expiredAt ? ` at ${expiredAt}` : "";
    super(`Invoice ${invoiceId} has expired${atStr}`);
    this.invoiceId = invoiceId;
    this.expiredAt = expiredAt;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      invoiceId: this.invoiceId,
      expiredAt: this.expiredAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Duplicate Payment Error
// ---------------------------------------------------------------------------

/**
 * Error thrown when attempting to pay an invoice that has already been paid.
 */
export class DuplicatePaymentError extends PaymentError {
  readonly code = "DUPLICATE_PAYMENT" as const;

  /** The invoice ID that was already paid */
  readonly invoiceId: string;

  /** The existing payment proof */
  readonly existingProof?: PaymentProof | undefined;

  constructor(invoiceId: string, existingProof?: PaymentProof) {
    super(`Invoice ${invoiceId} has already been paid`);
    this.invoiceId = invoiceId;
    this.existingProof = existingProof;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      invoiceId: this.invoiceId,
      existingProof: this.existingProof,
    };
  }
}

// ---------------------------------------------------------------------------
// Payment Failed Error
// ---------------------------------------------------------------------------

/**
 * Error thrown when a payment transaction fails.
 */
export class PaymentFailedError extends PaymentError {
  readonly code = "PAYMENT_FAILED" as const;

  /** The payment request that failed */
  readonly request: PaymentRequest;

  /** The failure reason from the network/provider */
  readonly reason?: string | undefined;

  /** Transaction hash if it was submitted but failed */
  readonly txHash?: string | undefined;

  constructor(
    request: PaymentRequest,
    reason?: string,
    txHash?: string,
    cause?: Error
  ) {
    super(reason ?? "Payment transaction failed", cause);
    this.request = request;
    this.reason = reason;
    this.txHash = txHash;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      request: this.request,
      reason: this.reason,
      txHash: this.txHash,
    };
  }
}

// ---------------------------------------------------------------------------
// Payment Timeout Error
// ---------------------------------------------------------------------------

/**
 * Error thrown when a payment operation times out.
 */
export class PaymentTimeoutError extends PaymentError {
  readonly code = "PAYMENT_TIMEOUT" as const;

  /** The payment request that timed out */
  readonly request: PaymentRequest;

  /** The operation that timed out */
  readonly operation: "sign" | "submit" | "confirm";

  /** Timeout duration in milliseconds */
  readonly timeoutMs: number;

  constructor(
    request: PaymentRequest,
    operation: "sign" | "submit" | "confirm",
    timeoutMs: number
  ) {
    super(`Payment ${operation} timed out after ${timeoutMs}ms`);
    this.request = request;
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      request: this.request,
      operation: this.operation,
      timeoutMs: this.timeoutMs,
    };
  }
}

// ---------------------------------------------------------------------------
// Chain Not Supported Error
// ---------------------------------------------------------------------------

/**
 * Error thrown when a requested chain is not supported.
 */
export class ChainNotSupportedError extends PaymentError {
  readonly code = "CHAIN_NOT_SUPPORTED" as const;

  /** The unsupported chain ID */
  readonly chain: string;

  /** List of supported chains, if available */
  readonly supportedChains?: readonly string[] | undefined;

  constructor(chain: string, supportedChains?: readonly string[]) {
    const supported = supportedChains
      ? `. Supported: ${supportedChains.join(", ")}`
      : "";
    super(`Chain ${chain} is not supported${supported}`);
    this.chain = chain;
    this.supportedChains = supportedChains;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      chain: this.chain,
      supportedChains: this.supportedChains,
    };
  }
}

// ---------------------------------------------------------------------------
// Asset Not Supported Error
// ---------------------------------------------------------------------------

/**
 * Error thrown when a requested asset is not supported on a chain.
 */
export class AssetNotSupportedError extends PaymentError {
  readonly code = "ASSET_NOT_SUPPORTED" as const;

  /** The unsupported asset identifier */
  readonly asset: string;

  /** The chain where the asset is not supported */
  readonly chain: string;

  constructor(asset: string, chain: string) {
    super(`Asset ${asset} is not supported on ${chain}`);
    this.asset = asset;
    this.chain = chain;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      asset: this.asset,
      chain: this.chain,
    };
  }
}

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/**
 * Type guard to check if an error is a PaymentError.
 */
export function isPaymentError(error: unknown): error is PaymentError {
  return error instanceof PaymentError;
}

/**
 * Type guard to check if an error is a PaymentRequiredError.
 */
export function isPaymentRequiredError(
  error: unknown
): error is PaymentRequiredError {
  return error instanceof PaymentRequiredError;
}

/**
 * Type guard to check if an error is a BudgetExceededError.
 */
export function isBudgetExceededError(
  error: unknown
): error is BudgetExceededError {
  return error instanceof BudgetExceededError;
}

/**
 * Type guard to check if an error is an InsufficientBalanceError.
 */
export function isInsufficientBalanceError(
  error: unknown
): error is InsufficientBalanceError {
  return error instanceof InsufficientBalanceError;
}

/**
 * Type guard to check if an error is retryable.
 */
export function isRetryableError(error: unknown): boolean {
  if (!isPaymentError(error)) return false;
  // Timeouts and some failures may be retryable
  return (
    error instanceof PaymentTimeoutError ||
    (error instanceof PaymentFailedError &&
      error.reason?.includes("network") === true)
  );
}
