/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/cli/src/commands/call.ts
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
import { createPoiClient } from "@poi-sdk/client";
import { createEvmPayer } from "@poi-sdk/payer-evm-direct";

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
 * poi call https://api.example.com/generate -k 0xprivatekey -b '{"prompt":"hello"}'
 * poi call https://api.example.com/resource -k 0xkey -m POST --partner myapp
 * poi call https://api.example.com/expensive -k 0xkey --max-per-request 5000000
 * ```
 */
export function registerCallCommand(program: Command): void {
  program
    .command("call <url>")
    .description("Make a request with automatic payment handling")
    .option("-m, --method <method>", "HTTP method", "POST")
    .option("-b, --body <json>", "Request body as JSON")
    .option("-k, --key <privateKey>", "Private key for payment (0x...)")
    .option("--partner <partner>", "Partner ID for attribution")
    .option("--max-per-request <amount>", "Max amount per request (atomic units)")
    .option("--rpc <url>", "RPC URL for EVM chain")
    .action(async (url: string, options: CallOptions) => {
      if (!options.key) {
        console.log(chalk.red("Error: --key required for auto-pay"));
        console.log(chalk.gray("  Provide a private key with 0x prefix"));
        process.exit(1);
      }

      // Validate key format
      if (!options.key.startsWith("0x") || options.key.length !== 66) {
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
        const payer = createEvmPayer(options.key as `0x${string}`, payerConfig);

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
  partner?: string;
  maxPerRequest?: string;
  rpc?: string;
}
