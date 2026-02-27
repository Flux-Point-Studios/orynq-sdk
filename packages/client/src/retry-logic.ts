/**
 * @summary Payment retry logic with polling and exponential backoff.
 *
 * This module provides utilities for retrying requests after payment,
 * handling the case where payment confirmation may be delayed on the
 * blockchain. It implements exponential backoff with jitter to avoid
 * thundering herd problems.
 *
 * Features:
 * - Configurable retry attempts and intervals
 * - Exponential backoff with random jitter
 * - Payment status polling for async confirmations
 * - Timeout handling
 *
 * Used by:
 * - PoiClient for automatic payment retry
 * - Any component needing robust payment confirmation
 */

import type {
  PaymentRequest,
  PaymentProof,
  PaymentStatus,
} from "@fluxpointstudios/orynq-sdk-core";
import { PaymentTimeoutError, PaymentFailedError } from "@fluxpointstudios/orynq-sdk-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for retry behavior.
 */
export interface RetryOptions {
  /**
   * Maximum time to wait for payment confirmation in milliseconds.
   * @default 30000 (30 seconds)
   */
  maxWaitMs?: number;

  /**
   * Base interval between poll attempts in milliseconds.
   * Actual interval increases with exponential backoff.
   * @default 2000 (2 seconds)
   */
  pollIntervalMs?: number;

  /**
   * Maximum number of retry attempts.
   * @default 5
   */
  maxRetries?: number;

  /**
   * Jitter factor (0-1) to randomize retry intervals.
   * @default 0.25 (25% randomization)
   */
  jitterFactor?: number;

  /**
   * Callback invoked on each retry attempt.
   * Useful for logging or progress updates.
   */
  onRetry?: (attempt: number, status?: PaymentStatus) => void;
}

/**
 * Default retry options.
 */
export const DEFAULT_RETRY_OPTIONS: Required<
  Omit<RetryOptions, "onRetry">
> = {
  maxWaitMs: 30000,
  pollIntervalMs: 2000,
  maxRetries: 5,
  jitterFactor: 0.25,
};

// ---------------------------------------------------------------------------
// Retry Logic
// ---------------------------------------------------------------------------

/**
 * Retry a request after payment with status polling.
 *
 * This function handles the flow where:
 * 1. Initial request returns 402 (already have payment request and proof)
 * 2. We retry with payment headers attached
 * 3. If still 402, poll payment status until confirmed
 * 4. Continue retrying until success or timeout
 *
 * @param fetchFn - Function that performs the fetch with payment headers
 * @param request - The original payment request (for error context)
 * @param proof - The payment proof (for reference)
 * @param pollStatus - Function to poll payment status by invoice ID
 * @param options - Retry configuration options
 * @returns Promise resolving to successful Response
 * @throws PaymentTimeoutError if confirmation times out
 * @throws PaymentFailedError if payment fails or expires
 *
 * @example
 * ```typescript
 * const response = await retryWithPayment(
 *   () => fetch(request),
 *   paymentRequest,
 *   paymentProof,
 *   async (invoiceId) => {
 *     const res = await fetch(`/api/status/${invoiceId}`);
 *     return res.json();
 *   },
 *   { maxWaitMs: 60000, maxRetries: 10 }
 * );
 * ```
 */
export async function retryWithPayment(
  fetchFn: () => Promise<Response>,
  request: PaymentRequest,
  _proof: PaymentProof,
  pollStatus: (invoiceId: string) => Promise<PaymentStatus>,
  options: RetryOptions = {}
): Promise<Response> {
  const {
    maxWaitMs = DEFAULT_RETRY_OPTIONS.maxWaitMs,
    pollIntervalMs = DEFAULT_RETRY_OPTIONS.pollIntervalMs,
    maxRetries = DEFAULT_RETRY_OPTIONS.maxRetries,
    jitterFactor = DEFAULT_RETRY_OPTIONS.jitterFactor,
    onRetry,
  } = options;

  const startTime = Date.now();

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Invoke retry callback if provided
    if (onRetry && attempt > 0) {
      onRetry(attempt);
    }

    // Make the request
    const res = await fetchFn();

    // Success - return immediately
    if (res.ok) {
      return res;
    }

    // If not a 402, this is a different kind of error
    if (res.status !== 402) {
      return res;
    }

    // Still 402 - payment not yet confirmed
    // Only poll if we have an invoice ID
    if (request.invoiceId) {
      try {
        const status = await pollStatus(request.invoiceId);

        // Invoke retry callback with status
        if (onRetry) {
          onRetry(attempt, status);
        }

        // Check if payment has reached a terminal state
        if (
          status.status === "confirmed" ||
          status.status === "consumed"
        ) {
          // Payment confirmed, retry the request immediately
          continue;
        }

        if (status.status === "failed") {
          throw new PaymentFailedError(
            request,
            status.error ?? "Payment failed",
            status.txHash
          );
        }

        if (status.status === "expired") {
          throw new PaymentFailedError(
            request,
            "Invoice expired before payment could be confirmed"
          );
        }
      } catch (pollError) {
        // If polling fails, continue with backoff anyway
        // The payment may still be processing
        if (
          pollError instanceof PaymentFailedError ||
          pollError instanceof PaymentTimeoutError
        ) {
          throw pollError;
        }
        // Log but continue for network errors in status polling
        console.warn("Payment status poll failed:", pollError);
      }
    }

    // Check if we've exceeded the total timeout
    const elapsed = Date.now() - startTime;
    if (elapsed >= maxWaitMs) {
      throw new PaymentTimeoutError(request, "confirm", maxWaitMs);
    }

    // Calculate delay with exponential backoff and jitter
    const baseDelay = pollIntervalMs * Math.pow(2, attempt);
    const jitter = baseDelay * jitterFactor * Math.random();
    const delay = Math.min(baseDelay + jitter, maxWaitMs - elapsed);

    if (delay > 0) {
      await sleep(delay);
    }
  }

  // Exhausted all retries
  throw new PaymentTimeoutError(request, "confirm", maxWaitMs);
}

/**
 * Simple retry with exponential backoff for general requests.
 *
 * This is a simpler version without payment-specific logic,
 * useful for retrying general network requests.
 *
 * @template T - Response type
 * @param fn - Async function to retry
 * @param options - Retry options
 * @returns Promise resolving to the function result
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: Pick<
    RetryOptions,
    "maxRetries" | "pollIntervalMs" | "jitterFactor" | "onRetry"
  > = {}
): Promise<T> {
  const {
    maxRetries = 3,
    pollIntervalMs = 1000,
    jitterFactor = 0.25,
    onRetry,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === maxRetries) {
        throw lastError;
      }

      if (onRetry) {
        onRetry(attempt);
      }

      // Exponential backoff with jitter
      const baseDelay = pollIntervalMs * Math.pow(2, attempt);
      const jitter = baseDelay * jitterFactor * Math.random();
      await sleep(baseDelay + jitter);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError ?? new Error("Retry failed");
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Sleep for a specified duration.
 *
 * @param ms - Duration in milliseconds
 * @returns Promise that resolves after the delay
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay with jitter.
 *
 * @param attempt - Current attempt number (0-indexed)
 * @param baseMs - Base delay in milliseconds
 * @param jitterFactor - Jitter factor (0-1)
 * @returns Delay in milliseconds
 */
export function calculateBackoffDelay(
  attempt: number,
  baseMs: number,
  jitterFactor: number = 0.25
): number {
  const exponential = baseMs * Math.pow(2, attempt);
  const jitter = exponential * jitterFactor * Math.random();
  return exponential + jitter;
}

/**
 * Create a timeout promise that rejects after a specified duration.
 *
 * @param ms - Timeout duration in milliseconds
 * @param message - Error message for timeout
 * @returns Promise that rejects with TimeoutError after delay
 */
export function createTimeout<T>(
  ms: number,
  message: string = "Operation timed out"
): Promise<T> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

/**
 * Race a promise against a timeout.
 *
 * @template T - Result type
 * @param promise - Promise to race
 * @param timeoutMs - Timeout in milliseconds
 * @param message - Optional timeout error message
 * @returns Promise result or throws on timeout
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message?: string
): Promise<T> {
  return Promise.race([promise, createTimeout<T>(timeoutMs, message)]);
}

/**
 * Determine if an error is retryable.
 *
 * Network errors and certain HTTP status codes are typically retryable.
 *
 * @param error - Error to check
 * @returns true if the error is likely retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    // Network errors
    if (
      error.name === "TypeError" ||
      error.message.includes("network") ||
      error.message.includes("fetch") ||
      error.message.includes("ECONNRESET") ||
      error.message.includes("ETIMEDOUT")
    ) {
      return true;
    }
  }

  // HTTP status based retry (if error contains status)
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error
  ) {
    const status = (error as { status: number }).status;
    // Retry on 502, 503, 504 (gateway/service unavailable)
    if (status === 502 || status === 503 || status === 504) {
      return true;
    }
    // Retry on 429 (rate limited)
    if (status === 429) {
      return true;
    }
  }

  return false;
}
