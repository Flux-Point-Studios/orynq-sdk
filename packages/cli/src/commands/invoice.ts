/**
 * @summary CLI command to fetch and display payment invoices from 402-protected endpoints.
 *
 * This command makes a request to the specified URL and parses the 402 response
 * to display the payment invoice details. It supports both x402 and Flux protocols.
 *
 * Used by:
 * - The main CLI entry point (index.ts) to register the 'invoice' command
 * - Developers testing payment-protected endpoints
 */

import chalk from "chalk";
import type { Command } from "commander";
import type { PaymentRequest } from "@fluxpointstudios/poi-sdk-core";
import { createX402Transport } from "@fluxpointstudios/poi-sdk-transport-x402";
import { createFluxTransport } from "@fluxpointstudios/poi-sdk-transport-flux";

/**
 * Register the 'invoice' command with the CLI program.
 *
 * This command fetches the payment invoice from an endpoint that returns 402.
 * It auto-detects the protocol (x402 or Flux) and displays the payment requirements.
 *
 * @param program - Commander program instance to register the command on
 *
 * @example
 * ```bash
 * poi invoice https://api.example.com/paid-endpoint
 * poi invoice https://api.example.com/generate -m POST -b '{"prompt":"hello"}'
 * poi invoice https://api.example.com/resource -H "Authorization:Bearer token"
 * ```
 */
export function registerInvoiceCommand(program: Command): void {
  program
    .command("invoice <url>")
    .description("Get payment invoice for an endpoint")
    .option("-m, --method <method>", "HTTP method", "POST")
    .option("-b, --body <json>", "Request body as JSON")
    .option("-H, --header <header>", "Request header (key:value)", collect, [])
    .action(async (url: string, options: InvoiceOptions) => {
      console.log(chalk.blue("Fetching invoice from:"), url);

      // Build request headers from CLI options
      const headers: Record<string, string> = {};
      for (const h of options.header) {
        const colonIndex = h.indexOf(":");
        if (colonIndex > 0) {
          const key = h.substring(0, colonIndex).trim();
          const value = h.substring(colonIndex + 1).trim();
          headers[key] = value;
        }
      }

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

      try {
        const fetchInit: RequestInit = {
          method: options.method,
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
        };
        if (body !== undefined) {
          fetchInit.body = JSON.stringify(body);
        }
        const res = await fetch(url, fetchInit);

        if (res.status !== 402) {
          console.log(chalk.yellow("Response status:"), res.status);
          if (res.ok) {
            console.log(chalk.green("No payment required!"));
          } else {
            console.log(chalk.red("Request failed:"), res.statusText);
            const text = await res.text();
            if (text) {
              console.log(chalk.gray(text));
            }
          }
          return;
        }

        // Detect and parse protocol
        const x402Transport = createX402Transport();
        const fluxTransport = createFluxTransport();

        if (x402Transport.is402(res)) {
          console.log(chalk.cyan("Protocol:"), "x402");
          const request = await x402Transport.parse402(res);
          printPaymentRequest(request);
        } else if (fluxTransport.is402(res)) {
          console.log(chalk.cyan("Protocol:"), "Flux");
          const request = await fluxTransport.parse402(res);
          printPaymentRequest(request);
        } else {
          console.log(chalk.red("Unknown 402 format"));
          const text = await res.text();
          console.log(chalk.gray(text));
        }
      } catch (error) {
        console.log(chalk.red("Error:"), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
}

/**
 * Options for the invoice command.
 */
interface InvoiceOptions {
  method: string;
  body?: string;
  header: string[];
}

/**
 * Print a payment request in a human-readable format.
 *
 * @param request - The parsed payment request to display
 */
function printPaymentRequest(request: PaymentRequest): void {
  console.log(chalk.green("\nPayment Request:"));
  console.log(chalk.gray("  Invoice ID:"), request.invoiceId ?? "(none)");
  console.log(chalk.gray("  Protocol:"), request.protocol);
  console.log(chalk.gray("  Chain:"), request.chain);
  console.log(chalk.gray("  Asset:"), request.asset);
  console.log(chalk.gray("  Amount:"), request.amountUnits, "(atomic units)");
  if (request.decimals !== undefined) {
    const humanAmount = formatAmount(request.amountUnits, request.decimals);
    console.log(chalk.gray("  Amount (human):"), humanAmount);
  }
  console.log(chalk.gray("  Pay To:"), request.payTo);
  if (request.timeoutSeconds !== undefined) {
    console.log(chalk.gray("  Expires In:"), request.timeoutSeconds, "seconds");
  }
  if (request.partner !== undefined) {
    console.log(chalk.gray("  Partner:"), request.partner);
  }
  if (request.splits !== undefined) {
    console.log(chalk.gray("  Split Mode:"), request.splits.mode);
    console.log(chalk.gray("  Splits:"));
    for (const output of request.splits.outputs) {
      console.log(chalk.gray("    -"), output.role ?? "recipient", ":", output.to, "=", output.amountUnits);
    }
  }
}

/**
 * Format an atomic amount to human-readable format.
 *
 * @param amountUnits - Amount in atomic units as string
 * @param decimals - Number of decimal places
 * @returns Formatted amount string
 */
function formatAmount(amountUnits: string, decimals: number): string {
  const amount = BigInt(amountUnits);
  const divisor = BigInt(10 ** decimals);
  const whole = amount / divisor;
  const fraction = amount % divisor;
  const fractionStr = fraction.toString().padStart(decimals, "0");
  return `${whole}.${fractionStr}`;
}

/**
 * Collect multiple occurrences of an option into an array.
 *
 * Used by Commander to handle repeated -H flags.
 *
 * @param value - The new value to add
 * @param previous - Previously collected values
 * @returns Updated array with new value
 */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}
