/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/gateway/src/config.ts
 * @summary Configuration types and defaults for the x402 gateway.
 *
 * This file defines the configuration interface for the gateway server,
 * including backend URL, payment settings, and server options. The gateway
 * acts as a bridge between x402 clients and a backend that expects trusted
 * headers for payment verification.
 *
 * Used by:
 * - server.ts for creating the Express gateway server
 * - index.ts for the main entry point
 * - cli.ts for command-line configuration
 */

import type { ChainId } from "@poi-sdk/core";
import type { Request } from "express";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Pricing result returned by the pricing function.
 */
export interface PricingResult {
  /**
   * CAIP-2 chain identifier for the payment.
   * @example "eip155:8453", "cardano:mainnet"
   */
  chain: ChainId;

  /**
   * Asset identifier for the payment.
   * @example "USDC", "ADA", "ETH"
   */
  asset: string;

  /**
   * Amount in atomic units as STRING.
   * Using string to prevent JavaScript precision issues with large numbers.
   * @example "1000000" (1 USDC with 6 decimals)
   */
  amountUnits: string;

  /**
   * Optional number of decimal places for the asset.
   * Used for display purposes.
   */
  decimals?: number;
}

/**
 * Configuration options for the x402 gateway server.
 *
 * The gateway proxies requests to a backend service, handling x402 payment
 * verification and setting trusted headers for the backend to consume.
 */
export interface GatewayConfig {
  /**
   * Backend URL to proxy requests to.
   * All verified requests will be forwarded to this URL.
   * @example "http://localhost:8000"
   */
  backendUrl: string;

  /**
   * Payment recipient address.
   * This address receives payments from clients.
   * Must be valid for the configured chains.
   * @example "0x742d35Cc6634C0532925a3b844Bc9e7595f9fEDb" (EVM)
   * @example "addr1qy..." (Cardano)
   */
  payTo: string;

  /**
   * Supported blockchain chains for payments.
   * Uses CAIP-2 format chain identifiers.
   * @example ["eip155:8453", "cardano:mainnet"]
   */
  chains: ChainId[];

  /**
   * Function to compute the price for a request.
   * Can be async for dynamic pricing based on request parameters.
   *
   * @param req - Express request object
   * @returns Promise resolving to pricing configuration
   *
   * @example
   * ```typescript
   * pricing: async (req) => ({
   *   chain: "eip155:8453",
   *   asset: "USDC",
   *   amountUnits: "1000000", // 1 USDC
   * })
   * ```
   */
  pricing: (req: Request) => Promise<PricingResult>;

  /**
   * Name of the trusted header to set when forwarding to backend.
   * The backend should check for this header to skip payment verification.
   * @default "X-Paid-Verified"
   */
  trustedHeader?: string;

  /**
   * Server port to listen on.
   * @default 3402
   */
  port?: number;

  /**
   * Server host to bind to.
   * @default "0.0.0.0"
   */
  host?: string;

  /**
   * Allowed CORS origins.
   * Set to "*" for all origins or provide an array of allowed origins.
   * @default "*"
   */
  corsOrigins?: string[];

  /**
   * Protocols to support for payment.
   * @default ["flux", "x402"]
   */
  protocols?: Array<"flux" | "x402">;

  /**
   * Invoice expiration time in seconds.
   * @default 300 (5 minutes)
   */
  invoiceExpiresInSeconds?: number;

  /**
   * Enable debug logging.
   * @default false
   */
  debug?: boolean;
}

// ---------------------------------------------------------------------------
// Default Configuration
// ---------------------------------------------------------------------------

/**
 * Default configuration values for the gateway.
 *
 * These defaults provide reasonable settings for most deployments.
 * Required values (backendUrl, payTo, pricing) must be provided explicitly.
 */
export const DEFAULT_CONFIG: Partial<GatewayConfig> = {
  trustedHeader: "X-Paid-Verified",
  port: 3402,
  host: "0.0.0.0",
  chains: ["eip155:8453", "cardano:mainnet"],
  protocols: ["flux", "x402"],
  invoiceExpiresInSeconds: 300,
  debug: false,
};

// ---------------------------------------------------------------------------
// Configuration Validation
// ---------------------------------------------------------------------------

/**
 * Validation error for gateway configuration.
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/**
 * Validate gateway configuration.
 *
 * Throws ConfigurationError if required fields are missing or invalid.
 *
 * @param config - Configuration to validate
 * @throws ConfigurationError if configuration is invalid
 */
export function validateConfig(config: GatewayConfig): void {
  if (!config.backendUrl) {
    throw new ConfigurationError("backendUrl is required");
  }

  try {
    new URL(config.backendUrl);
  } catch {
    throw new ConfigurationError(`Invalid backendUrl: ${config.backendUrl}`);
  }

  if (!config.payTo) {
    throw new ConfigurationError("payTo address is required");
  }

  if (!config.pricing || typeof config.pricing !== "function") {
    throw new ConfigurationError("pricing must be a function");
  }

  if (config.chains && !Array.isArray(config.chains)) {
    throw new ConfigurationError("chains must be an array");
  }

  if (config.chains && config.chains.length === 0) {
    throw new ConfigurationError("At least one chain must be configured");
  }

  if (config.port !== undefined) {
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      throw new ConfigurationError(`Invalid port: ${config.port}`);
    }
  }
}

/**
 * Merge user configuration with defaults.
 *
 * @param config - User-provided configuration
 * @returns Complete configuration with defaults applied
 */
export function mergeConfig(config: GatewayConfig): Required<GatewayConfig> {
  const merged = {
    ...DEFAULT_CONFIG,
    ...config,
  } as Required<GatewayConfig>;

  // Ensure arrays are properly merged (not overwritten)
  if (config.corsOrigins === undefined) {
    merged.corsOrigins = [];
  }

  return merged;
}
