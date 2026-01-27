/**
 * @summary Main PoiClient class with auto-pay functionality.
 *
 * This module provides the PoiClient, the primary interface for making
 * requests to paid APIs. It handles the complete payment flow automatically:
 *
 * 1. Make initial request
 * 2. If 402 returned, detect protocol (x402 or Flux)
 * 3. Parse payment requirements
 * 4. Check budget limits
 * 5. Check for cached payment (idempotency)
 * 6. Execute payment via configured Payer
 * 7. Retry request with payment proof
 * 8. Poll for confirmation if needed
 * 9. Record spend and cache proof
 *
 * Features:
 * - Automatic protocol detection (x402 or Flux)
 * - Budget enforcement (per-request and daily limits)
 * - Idempotency (prevents duplicate payments)
 * - Streaming support (NDJSON)
 * - Customizable retry behavior
 *
 * Used by:
 * - Application code making requests to paid APIs
 * - Any code needing automated payment handling
 */

import type {
  Payer,
  PaymentRequest,
  PaymentProof,
  PaymentStatus,
  BudgetConfig,
  BudgetStore,
  InvoiceCache,
} from "@fluxpointstudios/poi-sdk-core";
import {
  InMemoryBudgetStore,
  InMemoryInvoiceCache,
  FLUX_HEADERS,
} from "@fluxpointstudios/poi-sdk-core";

import { HttpClient } from "./http-client.js";
import { BudgetTracker } from "./budget-tracker.js";
import { IdempotencyManager } from "./idempotency.js";
import { parseNDJsonStream } from "./stream-parser.js";
import { retryWithPayment, type RetryOptions } from "./retry-logic.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for PoiClient.
 */
export interface PoiClientConfig {
  /**
   * Base URL for all requests.
   */
  baseUrl: string;

  /**
   * Payment protocol preference.
   * - "auto": Detect from 402 response (default)
   * - "x402": Use x402 protocol
   * - "flux": Use Flux protocol
   */
  protocol?: "auto" | "x402" | "flux";

  /**
   * Payer implementation for executing payments.
   * Required for automatic payment functionality.
   */
  payer: Payer;

  /**
   * Partner/referrer identifier for attribution.
   * Included in payment headers for revenue sharing.
   */
  partner?: string;

  /**
   * Budget configuration for spending limits.
   * If not provided, no budget limits are enforced.
   */
  budget?: BudgetConfig;

  /**
   * Budget storage backend.
   * Defaults to InMemoryBudgetStore if budget is configured.
   */
  budgetStore?: BudgetStore;

  /**
   * Invoice cache for idempotency.
   * Defaults to InMemoryInvoiceCache.
   */
  invoiceCache?: InvoiceCache;

  /**
   * Request timeout in milliseconds.
   * @default 30000 (30 seconds)
   */
  timeout?: number;

  /**
   * Default headers to include in all requests.
   */
  headers?: Record<string, string>;

  /**
   * Retry options for payment confirmation.
   */
  retryOptions?: RetryOptions;

  /**
   * Callback invoked when a payment is about to be made.
   * Can be used for confirmation prompts or logging.
   * Return false to cancel the payment.
   */
  onPaymentRequired?: (
    request: PaymentRequest
  ) => boolean | Promise<boolean>;

  /**
   * Callback invoked after a payment is confirmed.
   */
  onPaymentConfirmed?: (
    request: PaymentRequest,
    proof: PaymentProof
  ) => void | Promise<void>;
}

/**
 * Request options extending standard RequestInit.
 */
export interface PoiRequestOptions extends Omit<RequestInit, "body"> {
  /**
   * Request body (can be object, will be JSON-stringified).
   */
  body?: unknown;

  /**
   * Skip automatic payment for this request.
   */
  skipPayment?: boolean;

  /**
   * Custom idempotency key (auto-generated if not provided).
   */
  idempotencyKey?: string;
}

// ---------------------------------------------------------------------------
// PoiClient
// ---------------------------------------------------------------------------

/**
 * Main client for making requests to paid APIs with automatic payment handling.
 *
 * PoiClient abstracts the complexity of payment-protected APIs by handling:
 * - Protocol detection and negotiation
 * - Payment execution through the configured Payer
 * - Budget enforcement and tracking
 * - Idempotency and duplicate payment prevention
 * - Retry logic for payment confirmation
 *
 * @example
 * ```typescript
 * import { PoiClient } from "@fluxpointstudios/poi-sdk-client";
 * import { createCardanoPayer } from "@fluxpointstudios/poi-sdk-payer-cardano";
 *
 * const client = new PoiClient({
 *   baseUrl: "https://api.example.com",
 *   payer: createCardanoPayer({ wallet: "nami" }),
 *   budget: {
 *     maxPerRequest: "5000000",
 *     maxPerDay: "50000000",
 *   },
 * });
 *
 * // Make a request - payment handled automatically
 * const data = await client.request<MyResponse>("/api/generate", {
 *   method: "POST",
 *   body: { prompt: "Hello, world!" },
 * });
 * ```
 */
export class PoiClient {
  private readonly httpClient: HttpClient;
  private readonly payer: Payer;
  private readonly partner: string | undefined;
  private readonly budgetTracker: BudgetTracker | undefined;
  private readonly idempotencyManager: IdempotencyManager;
  private readonly retryOptions: RetryOptions;
  private readonly onPaymentRequired: PoiClientConfig["onPaymentRequired"] | undefined;
  private readonly onPaymentConfirmed: PoiClientConfig["onPaymentConfirmed"] | undefined;

  /**
   * Create a new PoiClient.
   *
   * @param config - Client configuration
   */
  constructor(config: PoiClientConfig) {
    const httpClientConfig: {
      baseUrl: string;
      preferredProtocol: "auto" | "x402" | "flux";
      defaultHeaders?: Record<string, string>;
      timeout?: number;
    } = {
      baseUrl: config.baseUrl,
      preferredProtocol: config.protocol ?? "auto",
    };
    if (config.headers !== undefined) {
      httpClientConfig.defaultHeaders = config.headers;
    }
    if (config.timeout !== undefined) {
      httpClientConfig.timeout = config.timeout;
    }
    this.httpClient = new HttpClient(httpClientConfig);

    this.payer = config.payer;
    this.partner = config.partner;
    this.retryOptions = config.retryOptions ?? {};
    this.onPaymentRequired = config.onPaymentRequired;
    this.onPaymentConfirmed = config.onPaymentConfirmed;

    // Initialize budget tracker if budget config provided
    if (config.budget) {
      const store = config.budgetStore ?? new InMemoryBudgetStore();
      this.budgetTracker = new BudgetTracker(config.budget, store);
    }

    // Initialize idempotency manager
    const cache = config.invoiceCache ?? new InMemoryInvoiceCache();
    this.idempotencyManager = new IdempotencyManager(cache);
  }

  /**
   * Make a request with automatic payment handling.
   *
   * If the endpoint requires payment (returns 402), the client will:
   * 1. Parse the payment requirement
   * 2. Check budget limits
   * 3. Execute payment via the configured Payer
   * 4. Retry the request with payment proof
   *
   * @template T - Expected response type
   * @param endpoint - API endpoint (relative to baseUrl or absolute)
   * @param options - Request options
   * @returns Promise resolving to parsed response body
   * @throws BudgetExceededError if payment would exceed budget
   * @throws PaymentFailedError if payment fails
   * @throws PaymentTimeoutError if payment confirmation times out
   */
  async request<T = unknown>(
    endpoint: string,
    options?: PoiRequestOptions
  ): Promise<T> {
    const response = await this.fetchWithPayment(endpoint, options);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Request failed: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * Make a streaming request with automatic payment handling.
   *
   * Returns an async generator that yields parsed NDJSON objects.
   * Payment is handled before streaming begins.
   *
   * @template T - Type of streamed objects
   * @param endpoint - API endpoint
   * @param options - Request options
   * @yields Parsed objects from the NDJSON stream
   */
  async *stream<T = unknown>(
    endpoint: string,
    options?: PoiRequestOptions
  ): AsyncGenerator<T, void, undefined> {
    const response = await this.fetchWithPayment(endpoint, options);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Stream request failed: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    if (!response.body) {
      throw new Error("Response has no body for streaming");
    }

    yield* parseNDJsonStream<T>(response.body);
  }

  /**
   * Get the payment request for an endpoint without paying.
   *
   * Useful for checking price or payment details before committing.
   *
   * @param endpoint - API endpoint
   * @param options - Request options
   * @returns PaymentRequest if payment required, null otherwise
   */
  async getPaymentRequest(
    endpoint: string,
    options?: PoiRequestOptions
  ): Promise<PaymentRequest | null> {
    const { body, ...fetchOptions } = options ?? {};
    const requestBody = body !== undefined ? JSON.stringify(body) : undefined;

    const createRequestOptions: RequestInit = { ...fetchOptions };
    if (requestBody !== undefined) {
      createRequestOptions.body = requestBody;
    }
    const request = this.httpClient.createRequest(endpoint, createRequestOptions);

    const fetchRequestOptions: RequestInit = {
      method: request.method,
      headers: Object.fromEntries(request.headers),
    };
    if (requestBody !== undefined) {
      fetchRequestOptions.body = requestBody;
    }
    const response = await this.httpClient.fetch(request.url, fetchRequestOptions);

    if (!this.httpClient.is402(response)) {
      return null;
    }

    return this.httpClient.parse402(response);
  }

  /**
   * Check if an endpoint requires payment.
   *
   * Makes a lightweight request to check for 402 status.
   *
   * @param endpoint - API endpoint
   * @returns true if endpoint requires payment
   */
  async checkPaymentRequired(endpoint: string): Promise<boolean> {
    const response = await this.httpClient.fetch(endpoint, {
      method: "HEAD",
    });

    return response.status === 402;
  }

  /**
   * Get the configured base URL.
   */
  get baseUrl(): string {
    return this.httpClient.baseUrl;
  }

  /**
   * Get remaining daily budget for an asset.
   *
   * @param chain - CAIP-2 chain identifier
   * @param asset - Asset identifier
   * @returns Remaining budget or null if no budget configured
   */
  async getRemainingBudget(
    chain: string,
    asset: string
  ): Promise<bigint | null> {
    if (!this.budgetTracker) {
      return null;
    }
    return this.budgetTracker.getRemainingDailyBudget(chain, asset);
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Perform a fetch with automatic payment handling.
   */
  private async fetchWithPayment(
    endpoint: string,
    options?: PoiRequestOptions
  ): Promise<Response> {
    const {
      body,
      skipPayment,
      idempotencyKey: providedKey,
      ...fetchOptions
    } = options ?? {};

    // Prepare request body
    const requestBody =
      body !== undefined ? JSON.stringify(body) : undefined;
    const method = fetchOptions.method ?? "GET";

    // Generate idempotency key
    const url = this.httpClient.resolveUrl(endpoint);
    const idempotencyKey =
      providedKey ?? (await this.idempotencyManager.generateKey(method, url, body));

    // Check for cached payment by idempotency key
    const cachedProof =
      await this.idempotencyManager.checkByIdempotencyKey(idempotencyKey);

    // Build headers including idempotency key
    const headers = new Headers(fetchOptions.headers);
    headers.set(FLUX_HEADERS.IDEMPOTENCY_KEY, idempotencyKey);
    if (this.partner) {
      headers.set(FLUX_HEADERS.PARTNER, this.partner);
    }

    // Create the initial request
    const requestInit: RequestInit = {
      ...fetchOptions,
      method,
      headers: Object.fromEntries(headers),
    };
    if (requestBody !== undefined) {
      requestInit.body = requestBody;
    }

    // Make initial request
    let response = await this.httpClient.fetch(endpoint, requestInit);

    // If not a 402 or payments skipped, return as-is
    if (!this.httpClient.is402(response) || skipPayment) {
      return response;
    }

    // Parse the payment requirement
    const paymentRequest = await this.httpClient.parse402(response);
    const protocol = this.httpClient.detectProtocol(response);

    if (!protocol) {
      throw new Error("Could not detect payment protocol from 402 response");
    }

    // Check for cached payment by invoice ID
    let proof: PaymentProof | null = null;
    if (paymentRequest.invoiceId) {
      proof = await this.idempotencyManager.checkPaid(paymentRequest.invoiceId);
    }

    // If we have a cached proof (by key or invoice), use it
    if (!proof && cachedProof) {
      proof = cachedProof;
    }

    // If no cached proof, need to make a payment
    if (!proof) {
      // Invoke pre-payment callback
      if (this.onPaymentRequired) {
        const shouldPay = await this.onPaymentRequired(paymentRequest);
        if (!shouldPay) {
          throw new Error("Payment cancelled by onPaymentRequired callback");
        }
      }

      // Check budget before paying
      if (this.budgetTracker) {
        await this.budgetTracker.checkBudget(
          paymentRequest.chain,
          paymentRequest.asset,
          BigInt(paymentRequest.amountUnits)
        );
      }

      // Check if payer supports this payment
      if (!this.payer.supports(paymentRequest)) {
        throw new Error(
          `Payer does not support payment: chain=${paymentRequest.chain}, asset=${paymentRequest.asset}`
        );
      }

      // Execute payment
      proof = await this.payer.pay(paymentRequest);

      // Cache the proof
      if (paymentRequest.invoiceId) {
        await this.idempotencyManager.recordPaid(paymentRequest.invoiceId, proof);
      }
      await this.idempotencyManager.recordByIdempotencyKey(idempotencyKey, proof);

      // Record the spend
      if (this.budgetTracker) {
        await this.budgetTracker.recordSpend(
          paymentRequest.chain,
          paymentRequest.asset,
          BigInt(paymentRequest.amountUnits)
        );
      }

      // Invoke post-payment callback
      if (this.onPaymentConfirmed) {
        await this.onPaymentConfirmed(paymentRequest, proof);
      }
    }

    // Create a request with payment headers
    const paidRequest = this.httpClient.createRequest(endpoint, requestInit);
    const paidRequestWithPayment = this.httpClient.applyPayment(
      paidRequest,
      proof,
      protocol,
      paymentRequest.invoiceId
    );

    // Create a fetch function for retries
    const fetchWithPaymentHeaders = async (): Promise<Response> => {
      return fetch(paidRequestWithPayment.clone());
    };

    // Retry with payment, polling for confirmation if needed
    response = await retryWithPayment(
      fetchWithPaymentHeaders,
      paymentRequest,
      proof,
      (invoiceId) => this.pollPaymentStatus(invoiceId),
      this.retryOptions
    );

    return response;
  }

  /**
   * Poll payment status from the server.
   *
   * This is a default implementation that can be overridden
   * for custom status endpoints.
   */
  private async pollPaymentStatus(invoiceId: string): Promise<PaymentStatus> {
    // Try common status endpoint patterns
    const statusEndpoints = [
      `/api/status/${invoiceId}`,
      `/status/${invoiceId}`,
      `/invoice/${invoiceId}/status`,
    ];

    for (const endpoint of statusEndpoints) {
      try {
        const response = await this.httpClient.fetch(endpoint, {
          method: "GET",
        });

        if (response.ok) {
          const status = (await response.json()) as Partial<PaymentStatus>;
          const result: PaymentStatus = {
            invoiceId,
            status: status.status ?? "pending",
          };
          if (status.txHash !== undefined) {
            result.txHash = status.txHash;
          }
          if (status.error !== undefined) {
            result.error = status.error;
          }
          if (status.settledAt !== undefined) {
            result.settledAt = status.settledAt;
          }
          return result;
        }
      } catch {
        // Try next endpoint
        continue;
      }
    }

    // Default to pending if we can't poll status
    return {
      invoiceId,
      status: "pending",
    };
  }
}

// ---------------------------------------------------------------------------
// Factory Function
// ---------------------------------------------------------------------------

/**
 * Create a PoiClient instance.
 *
 * Convenience factory function for creating a configured client.
 *
 * @param config - Client configuration
 * @returns PoiClient instance
 *
 * @example
 * ```typescript
 * import { createPoiClient } from "@fluxpointstudios/poi-sdk-client";
 *
 * const client = createPoiClient({
 *   baseUrl: "https://api.example.com",
 *   payer: myPayer,
 * });
 * ```
 */
export function createPoiClient(config: PoiClientConfig): PoiClient {
  return new PoiClient(config);
}
