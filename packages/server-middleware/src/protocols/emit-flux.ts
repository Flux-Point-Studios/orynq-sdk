/**
 * @summary Flux protocol 402 response emitter.
 *
 * This file provides functions to emit HTTP 402 Payment Required responses
 * in the Flux protocol format. Flux uses JSON body responses with X- prefixed
 * headers to communicate payment requirements.
 *
 * Flux protocol features:
 * - JSON body with payment details
 * - X-Invoice-Id header for tracking
 * - Support for split payments
 * - Chain identifier in friendly format
 *
 * Used by:
 * - Express middleware when emitting 402 responses
 * - Fastify plugin when emitting 402 responses
 */

import { FLUX_HEADERS } from "@fluxpointstudios/poi-sdk-core";
import type { Invoice } from "../invoice-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Flux protocol 402 response body.
 */
export interface FluxResponse {
  /**
   * Invoice identifier for tracking this payment request.
   */
  invoiceId: string;

  /**
   * Payment amount in atomic units as STRING.
   */
  amount: string;

  /**
   * Asset/currency identifier.
   * @example "ADA", "USDC", "ETH"
   */
  currency: string;

  /**
   * Primary recipient address.
   */
  payTo: string;

  /**
   * Chain identifier in friendly format.
   * @example "cardano-mainnet", "base-mainnet"
   */
  chain: string;

  /**
   * ISO 8601 timestamp when the invoice expires.
   */
  expiresAt?: string;

  /**
   * Split payment outputs for multi-recipient payments.
   */
  splits?: FluxSplit[];

  /**
   * Split mode determining how splits relate to the main amount.
   * - "inclusive": splits are subtracted from amount (total = amount)
   * - "additional": splits are added to amount (total = amount + sum(splits))
   */
  splitMode?: "inclusive" | "additional";
}

/**
 * Split payment output in Flux format.
 */
export interface FluxSplit {
  /**
   * Recipient address for this split.
   */
  to: string;

  /**
   * Amount for this split in atomic units.
   */
  amount: string;

  /**
   * Optional role identifier (e.g., "platform", "creator", "referrer").
   */
  role?: string;
}

/**
 * Options for creating Flux 402 responses.
 */
export interface CreateFluxResponseOptions {
  /**
   * Split payment configuration.
   */
  splits?: FluxSplit[];

  /**
   * Split mode.
   * @default "inclusive"
   */
  splitMode?: "inclusive" | "additional";

  /**
   * Additional custom fields to include in the response body.
   */
  customFields?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Response Type (Framework Agnostic)
// ---------------------------------------------------------------------------

/**
 * Minimal response interface for framework compatibility.
 * Works with Express, Fastify, and other frameworks.
 */
interface HttpResponse {
  status?(code: number): HttpResponse;
  statusCode?: number;
  setHeader(name: string, value: string | number): void;
  json(body: unknown): void;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Create a Flux 402 Payment Required response.
 *
 * Sets the appropriate HTTP status, headers, and JSON body for the
 * Flux payment protocol.
 *
 * @param invoice - Invoice to include in the response
 * @param res - HTTP response object (Express, Fastify, etc.)
 * @param options - Additional options for the response
 *
 * @example
 * ```typescript
 * app.get("/protected", async (req, res) => {
 *   const invoice = await store.create({
 *     chain: "cardano:mainnet",
 *     asset: "ADA",
 *     amountUnits: "1000000",
 *     payTo: "addr1...",
 *   });
 *
 *   createFlux402Response(invoice, res);
 * });
 * ```
 */
export function createFlux402Response(
  invoice: Invoice,
  res: HttpResponse,
  options: CreateFluxResponseOptions = {}
): void {
  const { splits, splitMode = "inclusive", customFields } = options;

  // Build response body
  const body: FluxResponse = {
    invoiceId: invoice.id,
    amount: invoice.amountUnits,
    currency: invoice.asset,
    payTo: invoice.payTo,
    chain: caipToWireChain(invoice.chain),
  };

  // Add optional fields only if they have values
  if (invoice.expiresAt !== undefined) {
    body.expiresAt = invoice.expiresAt;
  }

  // Add splits if provided
  if (splits && splits.length > 0) {
    body.splits = splits;
    body.splitMode = splitMode;
  }

  // Merge custom fields (without overwriting core fields)
  const responseBody = customFields
    ? { ...customFields, ...body }
    : body;

  // Set status
  if (typeof res.status === "function") {
    res.status(402);
  } else if (res.statusCode !== undefined) {
    res.statusCode = 402;
  }

  // Set headers
  res.setHeader("Content-Type", "application/json");
  res.setHeader(FLUX_HEADERS.INVOICE_ID, invoice.id);
  res.setHeader(FLUX_HEADERS.PAY_TO, invoice.payTo);
  res.setHeader(FLUX_HEADERS.AMOUNT, invoice.amountUnits);
  res.setHeader(FLUX_HEADERS.ASSET, invoice.asset);
  res.setHeader(FLUX_HEADERS.CHAIN, caipToWireChain(invoice.chain));

  if (invoice.expiresAt) {
    const timeoutSeconds = Math.max(
      0,
      Math.floor((new Date(invoice.expiresAt).getTime() - Date.now()) / 1000)
    );
    res.setHeader(FLUX_HEADERS.TIMEOUT, timeoutSeconds);
  }

  // Send response
  res.json(responseBody);
}

/**
 * Build a Flux response body without sending it.
 *
 * Useful when you need to customize the response before sending.
 *
 * @param invoice - Invoice to build response for
 * @param options - Additional options
 * @returns Flux response body object
 */
export function buildFluxResponseBody(
  invoice: Invoice,
  options: CreateFluxResponseOptions = {}
): FluxResponse {
  const { splits, splitMode = "inclusive" } = options;

  const body: FluxResponse = {
    invoiceId: invoice.id,
    amount: invoice.amountUnits,
    currency: invoice.asset,
    payTo: invoice.payTo,
    chain: caipToWireChain(invoice.chain),
  };

  if (invoice.expiresAt !== undefined) {
    body.expiresAt = invoice.expiresAt;
  }

  if (splits && splits.length > 0) {
    body.splits = splits;
    body.splitMode = splitMode;
  }

  return body;
}

/**
 * Get Flux headers for a 402 response.
 *
 * Useful when manually building responses.
 *
 * @param invoice - Invoice to get headers for
 * @returns Object with header name-value pairs
 */
export function getFluxHeaders(invoice: Invoice): Record<string, string | number> {
  const headers: Record<string, string | number> = {
    "Content-Type": "application/json",
    [FLUX_HEADERS.INVOICE_ID]: invoice.id,
    [FLUX_HEADERS.PAY_TO]: invoice.payTo,
    [FLUX_HEADERS.AMOUNT]: invoice.amountUnits,
    [FLUX_HEADERS.ASSET]: invoice.asset,
    [FLUX_HEADERS.CHAIN]: caipToWireChain(invoice.chain),
  };

  if (invoice.expiresAt) {
    const timeoutSeconds = Math.max(
      0,
      Math.floor((new Date(invoice.expiresAt).getTime() - Date.now()) / 1000)
    );
    headers[FLUX_HEADERS.TIMEOUT] = timeoutSeconds;
  }

  return headers;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Convert CAIP-2 chain ID to Flux wire format.
 *
 * @param chain - CAIP-2 chain identifier
 * @returns Friendly chain name for wire protocol
 *
 * @example
 * caipToWireChain("cardano:mainnet") // "cardano-mainnet"
 * caipToWireChain("eip155:8453") // "base-mainnet"
 */
export function caipToWireChain(chain: string): string {
  const mapping: Record<string, string> = {
    "cardano:mainnet": "cardano-mainnet",
    "cardano:preprod": "cardano-preprod",
    "cardano:preview": "cardano-preview",
    "eip155:1": "ethereum-mainnet",
    "eip155:8453": "base-mainnet",
    "eip155:84532": "base-sepolia",
    "eip155:11155111": "ethereum-sepolia",
  };

  return mapping[chain] ?? chain.replace(":", "-");
}

/**
 * Convert Flux wire chain format to CAIP-2.
 *
 * @param wireChain - Friendly chain name from wire protocol
 * @returns CAIP-2 chain identifier
 *
 * @example
 * wireChainToCAIP("cardano-mainnet") // "cardano:mainnet"
 * wireChainToCAIP("base-mainnet") // "eip155:8453"
 */
export function wireChainToCAIP(wireChain: string): string {
  const mapping: Record<string, string> = {
    "cardano-mainnet": "cardano:mainnet",
    "cardano-preprod": "cardano:preprod",
    "cardano-preview": "cardano:preview",
    "ethereum-mainnet": "eip155:1",
    "base-mainnet": "eip155:8453",
    "base-sepolia": "eip155:84532",
    "ethereum-sepolia": "eip155:11155111",
  };

  return mapping[wireChain] ?? wireChain.replace("-", ":");
}
