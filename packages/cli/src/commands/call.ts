/**
 * @summary CLI command to make requests with automatic payment handling.
 *
 * This command provides a full end-to-end flow for making paid API requests.
 * It automatically detects 402 responses, executes payment, and retries
 * the request with payment proof attached.
 *
 * Used by:
 * - The main CLI entry point (index.ts) to register the 'call' command
 * - Developers testing the complete auto-pay flow
 */

import chalk from "chalk";
import type { Command } from "commander";
import { createPoiClient } from "@fluxpointstudios/poi-sdk-client";
import { createEvmPayer } from "@fluxpointstudios/poi-sdk-payer-evm-direct";
import { readFileSync, existsSync } from "node:fs";

/**
 * Register the 'call' command with the CLI program.
 *
 * This command makes a request to a paid API endpoint with automatic
 * payment handling. It uses the PoiClient to detect 402 responses,
 * execute payments, and retry with payment proof.
 *
 * @param program - Commander program instance to register the command on
 *
 * @example
 * ```bash
 * # Using environment variable (RECOMMENDED)
 * export POI_PRIVATE_KEY=0x...
 * poi call https://api.example.com/generate -b '{"prompt":"hello"}'
 *
 * # Using key file
 * poi call https://api.example.com/resource --key-file ./key.txt -m POST --partner myapp
 *
 * # Direct key (NOT RECOMMENDED - stored in shell history)
 * poi call https://api.example.com/expensive -k 0xkey --max-per-request 5000000
 * ```
 */
export function registerCallCommand(program: Command): void {
  program
    .command("call <url>")
    .description("Make a request with automatic payment handling")
    .option("-m, --method <method>", "HTTP method", "POST")
    .option("-b, --body <json>", "Request body as JSON")
    .option("-k, --key <privateKey>", "Private key (INSECURE: stored in shell history, use POI_PRIVATE_KEY env var instead)")
    .option("--key-file <path>", "Path to file containing private key (more secure than --key)")
    .option("--partner <partner>", "Partner ID for attribution")
    .option("--max-per-request <amount>", "Max amount per request (atomic units)")
    .option("--rpc <url>", "RPC URL for EVM chain")
    .action(async (url: string, options: CallOptions) => {
      const privateKey = resolvePrivateKey(options);

      if (!privateKey) {
        console.log(chalk.red("Error: Private key required for auto-pay"));
        console.log(chalk.gray("\n  Provide a private key using one of these methods (in order of security):"));
        console.log(chalk.gray(`    1. Environment variable: export ${PRIVATE_KEY_ENV_VAR}=0x...`));
        console.log(chalk.gray("    2. Key file: --key-file ./path/to/key.txt"));
        console.log(chalk.gray("    3. Direct (insecure): --key 0x..."));
        process.exit(1);
      }

      // Validate key format
      if (!privateKey.startsWith("0x") || privateKey.length !== 66) {
        console.log(chalk.red("Error: Invalid private key format"));
        console.log(chalk.gray("  Expected: 0x followed by 64 hex characters"));
        process.exit(1);
      }

      // Parse URL to get base and endpoint
      let urlObj: URL;
      try {
        urlObj = new URL(url);
      } catch {
        console.log(chalk.red("Error: Invalid URL"));
        process.exit(1);
      }

      const baseUrl = `${urlObj.protocol}//${urlObj.host}`;
      const endpoint = urlObj.pathname + urlObj.search;

      // Parse body if provided
      let body: unknown;
      if (options.body) {
        try {
          body = JSON.parse(options.body);
        } catch {
          console.log(chalk.red("Error: Invalid JSON body"));
          process.exit(1);
        }
      }

      console.log(chalk.blue("Making request to:"), url);
      console.log(chalk.gray("  Method:"), options.method);
      if (body !== undefined) {
        console.log(chalk.gray("  Body:"), JSON.stringify(body).substring(0, 100) + "...");
      }
      if (options.partner) {
        console.log(chalk.gray("  Partner:"), options.partner);
      }

      try {
        // Create the EVM payer
        const payerConfig: { rpcUrls?: Record<string, string> } = {};
        if (options.rpc) {
          payerConfig.rpcUrls = {};
        }
        const payer = createEvmPayer(privateKey as `0x${string}`, payerConfig);

        // Build client config with proper optional property handling
        type ClientConfig = Parameters<typeof createPoiClient>[0];
        const clientConfig: ClientConfig = {
          baseUrl,
          payer,
          onPaymentRequired: (request) => {
            console.log(chalk.yellow("\nPayment required:"));
            console.log(chalk.gray("  Chain:"), request.chain);
            console.log(chalk.gray("  Asset:"), request.asset);
            console.log(chalk.gray("  Amount:"), request.amountUnits);
            console.log(chalk.gray("  Pay To:"), request.payTo);
            console.log(chalk.yellow("Executing payment..."));
            return true; // Auto-approve in CLI
          },
          onPaymentConfirmed: (_request, proof) => {
            console.log(chalk.green("\nPayment confirmed:"));
            console.log(chalk.gray("  Proof Type:"), proof.kind);
            if (proof.kind === "evm-txhash") {
              console.log(chalk.gray("  TX Hash:"), proof.txHash);
            }
          },
        };

        if (options.partner) {
          clientConfig.partner = options.partner;
        }
        if (options.maxPerRequest) {
          clientConfig.budget = { maxPerRequest: options.maxPerRequest };
        }

        // Create the PoI client with auto-pay
        const client = createPoiClient(clientConfig);

        // Make the request
        const result = await client.request(endpoint, {
          method: options.method,
          body,
        });

        console.log(chalk.green("\nSuccess!"));
        console.log(chalk.gray("Response:"));
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        console.log(chalk.red("\nError:"), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
}

/**
 * Options for the call command.
 */
interface CallOptions {
  method: string;
  body?: string;
  key?: string;
  keyFile?: string;
  partner?: string;
  maxPerRequest?: string;
  rpc?: string;
}

/**
 * Environment variable name for private key.
 */
const PRIVATE_KEY_ENV_VAR = "POI_PRIVATE_KEY";

/**
 * Resolve the private key from various sources.
 * Priority: 1) --key-file, 2) --key, 3) POI_PRIVATE_KEY env var
 *
 * @param options - Command options
 * @returns The resolved private key or undefined
 */
function resolvePrivateKey(options: CallOptions): string | undefined {
  // Priority 1: Key file (most secure for CLI usage)
  if (options.keyFile) {
    if (!existsSync(options.keyFile)) {
      console.log(chalk.red(`Error: Key file not found: ${options.keyFile}`));
      process.exit(1);
    }
    try {
      const key = readFileSync(options.keyFile, "utf-8").trim();
      return key;
    } catch (error) {
      console.log(chalk.red(`Error reading key file: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  }

  // Priority 2: Direct key argument (warn about shell history)
  if (options.key) {
    console.log(chalk.yellow("⚠️  Warning: Private key passed via --key flag is stored in shell history."));
    console.log(chalk.yellow("   Consider using POI_PRIVATE_KEY env var or --key-file instead."));
    return options.key;
  }

  // Priority 3: Environment variable (recommended)
  const envKey = process.env[PRIVATE_KEY_ENV_VAR];
  if (envKey) {
    return envKey;
  }

  return undefined;
}
