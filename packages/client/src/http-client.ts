/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/client/src/http-client.ts
 * @summary Fetch wrapper with protocol detection and payment header handling.
 *
 * This module provides the HttpClient class that wraps fetch operations with
 * automatic protocol detection for 402 Payment Required responses. It supports
 * both x402 and Flux protocols, detecting which is in use based on response
 * headers and body format.
 *
 * Features:
 * - Automatic protocol detection from 402 responses
 * - Parsing payment requirements from either protocol
 * - Applying payment proofs with correct headers
 * - Default header management
 *
 * Used by:
 * - PoiClient for all HTTP operations
 * - Any component needing protocol-aware HTTP
 */

import { createX402Transport } from "@poi-sdk/transport-x402";
import { createFluxTransport } from "@poi-sdk/transport-flux";
import type { X402Transport, X402Settlement } from "@poi-sdk/transport-x402";
import type { FluxTransport } from "@poi-sdk/transport-flux";
import type { PaymentRequest, PaymentProof } from "@poi-sdk/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for the HTTP client.
 */
export interface HttpClientConfig {
  /**
   * Base URL for all requests.
   * Will be prepended to relative endpoints.
   */
  baseUrl: string;

  /**
   * Preferred protocol for payment detection.
   * - "auto": Detect from response (default)
   * - "x402": Expect x402 protocol only
   * - "flux": Expect Flux protocol only
   */
  preferredProtocol?: "auto" | "x402" | "flux";

  /**
   * Default headers to include in all requests.
   */
  defaultHeaders?: Record<string, string>;

  /**
   * Request timeout in milliseconds.
   * @default 30000 (30 seconds)
   */
  timeout?: number;
}

/**
 * Protocol type identifiers.
 */
export type ProtocolType = "x402" | "flux";

// ---------------------------------------------------------------------------
// HTTP Client
// ---------------------------------------------------------------------------

/**
 * HTTP client with automatic payment protocol detection.
 *
 * The HttpClient wraps standard fetch operations and provides methods for:
 * - Detecting which payment protocol a 402 response uses
 * - Parsing payment requirements from responses
 * - Applying payment proofs to requests
 *
 * @example
 * ```typescript
 * const client = new HttpClient({
 *   baseUrl: "https://api.example.com",
 *   defaultHeaders: { "X-API-Key": "secret" }
 * });
 *
 * // Make a request
 * const response = await client.fetch("/resource");
 *
 * // Check for payment requirement
 * if (response.status === 402) {
 *   const protocol = await client.detectProtocol(response);
 *   const paymentRequest = await client.parse402(response);
 *   // ... process payment ...
 * }
 * ```
 */
export class HttpClient {
  private readonly config: Required<HttpClientConfig>;
  private readonly x402Transport: X402Transport;
  private readonly fluxTransport: FluxTransport;

  /**
   * Create a new HttpClient.
   *
   * @param config - Client configuration
   */
  constructor(config: HttpClientConfig) {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/$/, ""), // Remove trailing slash
      preferredProtocol: config.preferredProtocol ?? "auto",
      defaultHeaders: config.defaultHeaders ?? {},
      timeout: config.timeout ?? 30000,
    };

    this.x402Transport = createX402Transport();
    this.fluxTransport = createFluxTransport();
  }

  /**
   * Get the configured base URL.
   */
  get baseUrl(): string {
    return this.config.baseUrl;
  }

  /**
   * Perform a fetch request with default configuration.
   *
   * @param endpoint - Relative or absolute URL
   * @param options - Standard RequestInit options
   * @returns Promise resolving to Response
   */
  async fetch(endpoint: string, options?: RequestInit): Promise<Response> {
    const url = this.resolveUrl(endpoint);
    const headers = this.mergeHeaders(options?.headers);

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.timeout
    );

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: options?.signal ?? controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Create a Request object with default configuration.
   *
   * @param endpoint - Relative or absolute URL
   * @param options - Standard RequestInit options
   * @returns Request object
   */
  createRequest(endpoint: string, options?: RequestInit): Request {
    const url = this.resolveUrl(endpoint);
    const headers = this.mergeHeaders(options?.headers);

    return new Request(url, {
      ...options,
      headers,
    });
  }

  /**
   * Detect which payment protocol a 402 response uses.
   *
   * Protocol detection is based on:
   * - x402: PAYMENT-REQUIRED header present
   * - Flux: JSON body without PAYMENT-REQUIRED header
   *
   * @param res - HTTP Response to analyze
   * @returns Protocol type or null if not a valid 402
   */
  detectProtocol(res: Response): ProtocolType | null {
    // If a specific protocol is configured, use it
    if (this.config.preferredProtocol !== "auto") {
      if (res.status === 402) {
        return this.config.preferredProtocol;
      }
      return null;
    }

    // Auto-detect based on response characteristics
    if (this.x402Transport.is402(res)) {
      return "x402";
    }

    if (this.fluxTransport.is402(res)) {
      return "flux";
    }

    // Fallback: just check if it's a 402
    if (res.status === 402) {
      // Default to flux for JSON 402 responses without specific headers
      const contentType = res.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        return "flux";
      }
    }

    return null;
  }

  /**
   * Check if a response is a 402 Payment Required.
   *
   * @param res - HTTP Response to check
   * @returns true if this is a payment required response
   */
  is402(res: Response): boolean {
    return res.status === 402 && this.detectProtocol(res) !== null;
  }

  /**
   * Parse a 402 response to extract payment request details.
   *
   * Automatically detects the protocol and uses the appropriate parser.
   *
   * @param res - 402 Response to parse
   * @returns PaymentRequest with normalized fields
   * @throws Error if response cannot be parsed
   */
  async parse402(res: Response): Promise<PaymentRequest> {
    const protocol = this.detectProtocol(res);

    if (protocol === "x402") {
      return this.x402Transport.parse402(res);
    }

    if (protocol === "flux") {
      // Clone the response so the body can be read
      return this.fluxTransport.parse402(res.clone());
    }

    throw new Error(
      `Cannot parse 402 response: unknown protocol. ` +
        `Status: ${res.status}, Content-Type: ${res.headers.get("content-type")}`
    );
  }

  /**
   * Apply a payment proof to a request.
   *
   * Creates a new Request with the appropriate payment headers based on
   * the detected or specified protocol.
   *
   * @param req - Original Request to clone
   * @param proof - Payment proof to attach
   * @param protocol - Protocol type ("x402" or "flux")
   * @param invoiceId - Invoice ID (required for Flux protocol)
   * @returns New Request with payment headers
   */
  applyPayment(
    req: Request,
    proof: PaymentProof,
    protocol: ProtocolType,
    invoiceId?: string
  ): Request {
    if (protocol === "x402") {
      return this.x402Transport.applyPayment(req, proof);
    }

    if (protocol === "flux") {
      if (!invoiceId) {
        throw new Error(
          "Invoice ID is required for Flux protocol payment"
        );
      }
      return this.fluxTransport.applyPayment(req, proof, invoiceId);
    }

    throw new Error(`Unknown protocol: ${protocol as string}`);
  }

  /**
   * Parse settlement information from a response (x402 only).
   *
   * @param res - Response that may contain settlement info
   * @returns Settlement info or null
   */
  parseSettlement(res: Response): X402Settlement | null {
    return this.x402Transport.parseSettlement(res);
  }

  /**
   * Resolve a possibly relative endpoint to a full URL.
   *
   * @param endpoint - Relative or absolute URL
   * @returns Full URL string
   */
  resolveUrl(endpoint: string): string {
    // If already absolute, return as-is
    if (
      endpoint.startsWith("http://") ||
      endpoint.startsWith("https://")
    ) {
      return endpoint;
    }

    // Ensure endpoint starts with /
    const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;

    return `${this.config.baseUrl}${path}`;
  }

  /**
   * Merge provided headers with default headers.
   *
   * @param headers - Headers to merge (various formats)
   * @returns Headers object
   */
  private mergeHeaders(
    headers?: HeadersInit
  ): Headers {
    const merged = new Headers(this.config.defaultHeaders);

    if (!headers) {
      return merged;
    }

    // Handle different HeadersInit types
    if (headers instanceof Headers) {
      headers.forEach((value, key) => merged.set(key, value));
    } else if (Array.isArray(headers)) {
      headers.forEach(([key, value]) => {
        if (key !== undefined && value !== undefined) {
          merged.set(key, value);
        }
      });
    } else {
      Object.entries(headers).forEach(([key, value]) => {
        if (value !== undefined) {
          merged.set(key, value);
        }
      });
    }

    return merged;
  }

  /**
   * Get the transport instances for advanced use.
   */
  getTransports(): { x402: X402Transport; flux: FluxTransport } {
    return {
      x402: this.x402Transport,
      flux: this.fluxTransport,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory Function
// ---------------------------------------------------------------------------

/**
 * Create an HttpClient instance.
 *
 * @param config - Client configuration
 * @returns HttpClient instance
 */
export function createHttpClient(config: HttpClientConfig): HttpClient {
  return new HttpClient(config);
}
