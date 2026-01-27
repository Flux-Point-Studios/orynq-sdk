/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/gateway/src/cli.ts
 * @summary Command-line interface for the x402 gateway server.
 *
 * This file provides a CLI entry point for running the gateway server
 * using environment variables for configuration. It is invoked via the
 * `poi-gateway` command after installation.
 *
 * Environment Variables:
 * - BACKEND_URL: Backend URL to proxy to (required)
 * - PAY_TO: Payment recipient address (required)
 * - CHAINS: Comma-separated list of supported chains (default: "eip155:8453")
 * - PORT: Server port (default: 3402)
 * - HOST: Server host (default: "0.0.0.0")
 * - CORS_ORIGINS: Comma-separated list of allowed CORS origins
 * - PRICE_AMOUNT: Default price in atomic units (default: "1000000")
 * - PRICE_ASSET: Default asset for pricing (default: "USDC")
 * - TRUSTED_HEADER: Header name for trusted verification (default: "X-Paid-Verified")
 * - DEBUG: Enable debug logging (default: false)
 *
 * Usage:
 * ```bash
 * # Minimal configuration
 * export BACKEND_URL=http://localhost:8000
 * export PAY_TO=0x742d35Cc6634C0532925a3b844Bc9e7595f9fEDb
 * npx poi-gateway
 *
 * # Full configuration
 * export BACKEND_URL=http://localhost:8000
 * export PAY_TO=0x742d35Cc6634C0532925a3b844Bc9e7595f9fEDb
 * export CHAINS=eip155:8453,eip155:84532
 * export PORT=3402
 * export PRICE_AMOUNT=2000000
 * export PRICE_ASSET=USDC
 * export DEBUG=true
 * npx poi-gateway
 * ```
 */

import type { ChainId } from "@poi-sdk/core";
import { startGateway } from "./server.js";
import type { GatewayConfig, PricingResult } from "./config.js";

// ---------------------------------------------------------------------------
// Environment Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a comma-separated string into an array.
 */
function parseCommaSeparated(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse a boolean from environment variable.
 */
function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) {
    return defaultValue;
  }
  return value.toLowerCase() === "true" || value === "1";
}

/**
 * Parse an integer from environment variable.
 */
function parseInteger(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Main function for CLI entry point.
 *
 * Reads configuration from environment variables and starts the gateway server.
 */
export async function main(): Promise<void> {
  console.log("[Gateway] Starting x402 Gateway...");

  // Read environment variables
  const backendUrl = process.env["BACKEND_URL"];
  const payTo = process.env["PAY_TO"];
  const chainsEnv = process.env["CHAINS"];
  const portEnv = process.env["PORT"];
  const hostEnv = process.env["HOST"];
  const corsOriginsEnv = process.env["CORS_ORIGINS"];
  const priceAmountEnv = process.env["PRICE_AMOUNT"];
  const priceAssetEnv = process.env["PRICE_ASSET"];
  const priceChainEnv = process.env["PRICE_CHAIN"];
  const trustedHeaderEnv = process.env["TRUSTED_HEADER"];
  const debugEnv = process.env["DEBUG"];

  // Validate required variables
  if (!backendUrl) {
    console.error("[Gateway] Error: BACKEND_URL environment variable is required");
    console.error("[Gateway] Example: export BACKEND_URL=http://localhost:8000");
    process.exit(1);
  }

  if (!payTo) {
    console.error("[Gateway] Error: PAY_TO environment variable is required");
    console.error("[Gateway] Example: export PAY_TO=0x742d35Cc6634C0532925a3b844Bc9e7595f9fEDb");
    process.exit(1);
  }

  // Parse configuration
  const chains = chainsEnv
    ? (parseCommaSeparated(chainsEnv) as ChainId[])
    : (["eip155:8453"] as ChainId[]);

  const port = parseInteger(portEnv, 3402);
  const host = hostEnv ?? "0.0.0.0";
  const corsOrigins = parseCommaSeparated(corsOriginsEnv);
  const priceAmount = priceAmountEnv ?? "1000000";
  const priceAsset = priceAssetEnv ?? "USDC";
  const priceChain = (priceChainEnv ?? chains[0] ?? "eip155:8453") as ChainId;
  const trustedHeader = trustedHeaderEnv ?? "X-Paid-Verified";
  const debug = parseBoolean(debugEnv, false);

  // Create pricing function
  const pricing = async (): Promise<PricingResult> => ({
    chain: priceChain,
    asset: priceAsset,
    amountUnits: priceAmount,
  });

  // Build configuration
  const config: GatewayConfig = {
    backendUrl,
    payTo,
    chains,
    pricing,
    port,
    host,
    corsOrigins,
    trustedHeader,
    debug,
  };

  // Log configuration
  console.log("[Gateway] Configuration:");
  console.log(`  Backend URL: ${backendUrl}`);
  console.log(`  Pay To: ${payTo}`);
  console.log(`  Chains: ${chains.join(", ")}`);
  console.log(`  Port: ${port}`);
  console.log(`  Host: ${host}`);
  console.log(`  Price: ${priceAmount} ${priceAsset} on ${priceChain}`);
  console.log(`  Trusted Header: ${trustedHeader}`);
  console.log(`  Debug: ${debug}`);

  if (corsOrigins.length > 0) {
    console.log(`  CORS Origins: ${corsOrigins.join(", ")}`);
  } else {
    console.log("  CORS Origins: * (all origins)");
  }

  // Start the gateway
  try {
    await startGateway(config);
    console.log("[Gateway] Gateway started successfully");
  } catch (error) {
    console.error("[Gateway] Failed to start gateway:", error);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Run if invoked directly
// ---------------------------------------------------------------------------

// Check if this module is being run directly
const isMainModule =
  typeof require !== "undefined" && require.main === module;

// For ESM, we check if the script path matches
const isESMMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("cli.ts"));

if (isMainModule || isESMMain) {
  main().catch((error) => {
    console.error("[Gateway] Unhandled error:", error);
    process.exit(1);
  });
}
