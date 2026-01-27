/**
 * @summary Parse x402 PAYMENT-REQUIRED headers into protocol-neutral PaymentRequest.
 *
 * This file handles the decoding and transformation of x402 wire format data
 * from the PAYMENT-REQUIRED header (base64-encoded JSON) into poi-sdk's
 * protocol-neutral PaymentRequest structure.
 *
 * Used by:
 * - index.ts X402Transport.parse402() implementation
 * - Client code that needs to manually parse x402 responses
 */

import { X402_HEADERS } from "@fluxpointstudios/poi-sdk-core";
import type { PaymentRequest, PaymentFacilitator } from "@fluxpointstudios/poi-sdk-core";
import type { X402PaymentRequired } from "./types.js";
import { isX402PaymentRequired } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default asset symbol for native ETH payments.
 */
const DEFAULT_NATIVE_ASSET = "ETH";

/**
 * Default decimals for native ETH.
 */
const DEFAULT_ETH_DECIMALS = 18;

/**
 * Known asset decimals by common symbols/addresses.
 */
const KNOWN_DECIMALS: Record<string, number> = {
  // Native assets
  ETH: 18,
  // Common stablecoins (6 decimals)
  USDC: 6,
  USDT: 6,
  // Base mainnet USDC
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": 6,
  // Base Sepolia USDC
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e": 6,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a base64-encoded x402 PAYMENT-REQUIRED header value into a PaymentRequest.
 *
 * The header value is expected to be base64-encoded JSON following the x402
 * specification (version "1"). This function decodes and validates the data,
 * then converts it to the protocol-neutral PaymentRequest format.
 *
 * @param header - Base64-encoded JSON string from PAYMENT-REQUIRED header
 * @returns Protocol-neutral PaymentRequest with protocol: "x402"
 * @throws Error if the header cannot be decoded or is invalid
 *
 * @example
 * ```typescript
 * const header = response.headers.get("PAYMENT-REQUIRED");
 * if (header) {
 *   const request = parsePaymentRequired(header);
 *   console.log(`Pay ${request.amountUnits} to ${request.payTo}`);
 * }
 * ```
 */
export function parsePaymentRequired(header: string): PaymentRequest {
  // Decode base64 to JSON string
  let jsonString: string;
  try {
    jsonString = decodeBase64(header);
  } catch (err) {
    throw new Error(
      `Failed to decode x402 PAYMENT-REQUIRED header: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Parse JSON
  let rawData: unknown;
  try {
    rawData = JSON.parse(jsonString);
  } catch (err) {
    throw new Error(
      `Failed to parse x402 PAYMENT-REQUIRED JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Validate structure
  if (!isX402PaymentRequired(rawData)) {
    throw new Error(
      "Invalid x402 PAYMENT-REQUIRED header: missing required fields (version, scheme, network, maxAmountRequired, resource, payTo)"
    );
  }

  // Convert to PaymentRequest
  return x402ToPaymentRequest(rawData);
}

/**
 * Parse x402 payment requirement from a 402 HTTP Response.
 *
 * Convenience function that extracts the PAYMENT-REQUIRED header and parses it.
 * Returns null if the header is not present.
 *
 * @param res - HTTP Response to extract payment requirement from
 * @returns PaymentRequest or null if header not present
 * @throws Error if header is present but invalid
 *
 * @example
 * ```typescript
 * const response = await fetch(url);
 * if (response.status === 402) {
 *   const request = parse402Response(response);
 *   if (request) {
 *     // Handle x402 payment requirement
 *   }
 * }
 * ```
 */
export function parse402Response(res: Response): PaymentRequest | null {
  const header = res.headers.get(X402_HEADERS.PAYMENT_REQUIRED);
  if (!header) {
    return null;
  }
  return parsePaymentRequired(header);
}

/**
 * Parse x402 raw data into PaymentRequest format.
 *
 * This function is useful when you have already decoded and validated
 * the x402 payment requirement data.
 *
 * @param raw - Validated X402PaymentRequired object
 * @returns Protocol-neutral PaymentRequest
 */
export function x402ToPaymentRequest(raw: X402PaymentRequired): PaymentRequest {
  // Determine the asset identifier
  const asset = raw.asset ?? DEFAULT_NATIVE_ASSET;

  // Determine decimals (for display purposes)
  const decimals = getAssetDecimals(asset);

  // Build the payment request, only including optional fields if they have values
  // This is required due to exactOptionalPropertyTypes in tsconfig
  const paymentRequest: PaymentRequest = {
    protocol: "x402",
    version: raw.version,
    chain: raw.network, // Already in CAIP-2 format
    asset,
    amountUnits: raw.maxAmountRequired,
    decimals,
    payTo: raw.payTo,
    raw, // Preserve original data for advanced use cases
  };

  // Add optional fields only if they have defined values
  if (raw.maxTimeoutSeconds !== undefined) {
    paymentRequest.timeoutSeconds = raw.maxTimeoutSeconds;
  }

  // Convert facilitator if present and has valid endpoint
  if (raw.facilitator) {
    const facilitator: PaymentFacilitator = {
      provider: raw.facilitator.provider,
    };
    if (raw.facilitator.endpoint !== undefined) {
      facilitator.url = raw.facilitator.endpoint;
    }
    paymentRequest.facilitator = facilitator;
  }

  return paymentRequest;
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Decode a base64 string to UTF-8 text.
 * Works in both Node.js and browser environments.
 *
 * @param base64 - Base64-encoded string
 * @returns Decoded UTF-8 string
 */
function decodeBase64(base64: string): string {
  // Handle URL-safe base64 (replace - with + and _ with /)
  const normalized = base64.replace(/-/g, "+").replace(/_/g, "/");

  // Node.js environment
  if (typeof Buffer !== "undefined") {
    return Buffer.from(normalized, "base64").toString("utf-8");
  }

  // Browser environment
  if (typeof atob !== "undefined") {
    const binaryString = atob(normalized);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }

  throw new Error("No base64 decoding function available in this environment");
}

/**
 * Get the decimal places for a known asset.
 *
 * @param asset - Asset identifier (symbol or contract address)
 * @returns Number of decimals, defaults to 18 for unknown assets
 */
function getAssetDecimals(asset: string): number {
  // Check known assets (case-insensitive for symbols)
  const upperAsset = asset.toUpperCase();
  if (upperAsset in KNOWN_DECIMALS) {
    return KNOWN_DECIMALS[upperAsset]!;
  }

  // Check contract addresses (case-sensitive)
  if (asset in KNOWN_DECIMALS) {
    return KNOWN_DECIMALS[asset]!;
  }

  // Default to 18 decimals (ETH standard)
  return DEFAULT_ETH_DECIMALS;
}
