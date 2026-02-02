/**
 * @summary CLI command to test x402 protocol compatibility of an endpoint.
 *
 * This command makes a request to an endpoint and analyzes the 402 response
 * to determine if it follows the x402 protocol specification. It also
 * detects Flux protocol responses for comparison.
 *
 * Used by:
 * - The main CLI entry point (index.ts) to register the 'test-x402' command
 * - Developers verifying endpoint compatibility with x402 protocol
 */

import chalk from "chalk";
import type { Command } from "commander";
import { X402_HEADERS } from "@fluxpointstudios/orynq-sdk-core";

/**
 * Register the 'test-x402' command with the CLI program.
 *
 * This command tests whether an endpoint speaks the x402 protocol
 * by analyzing the headers and body of a 402 response.
 *
 * @param program - Commander program instance to register the command on
 *
 * @example
 * ```bash
 * poi test-x402 https://api.example.com/paid-endpoint
 * poi test-x402 https://api.example.com/generate -m POST -b '{"prompt":"test"}'
 * ```
 */
export function registerTestX402Command(program: Command): void {
  program
    .command("test-x402 <url>")
    .description("Test if an endpoint speaks x402 protocol")
    .option("-m, --method <method>", "HTTP method", "POST")
    .option("-b, --body <json>", "Request body as JSON")
    .action(async (url: string, options: TestX402Options) => {
      console.log(chalk.blue("Testing x402 compatibility..."));
      console.log(chalk.gray("  URL:"), url);
      console.log(chalk.gray("  Method:"), options.method);

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
          headers: { "Content-Type": "application/json" },
        };
        if (body !== undefined) {
          fetchInit.body = JSON.stringify(body);
        }
        const res = await fetch(url, fetchInit);

        console.log(chalk.gray("  Status:"), res.status);

        if (res.status !== 402) {
          console.log(chalk.yellow("\nEndpoint did not return 402"));
          console.log(chalk.gray("This might mean:"));
          console.log(chalk.gray("  - Endpoint doesn't require payment"));
          console.log(chalk.gray("  - Wrong URL or method"));
          console.log(chalk.gray("  - Request is already authorized"));

          if (res.ok) {
            console.log(chalk.green("\nRequest succeeded without payment"));
          } else {
            console.log(chalk.red("\nRequest failed with status:"), res.status, res.statusText);
          }
          return;
        }

        // Check for x402 header
        const paymentRequired = res.headers.get(X402_HEADERS.PAYMENT_REQUIRED);

        if (paymentRequired) {
          console.log(chalk.green("\nx402 protocol detected!"));

          try {
            const decoded = decodePaymentRequired(paymentRequired);
            console.log(chalk.gray("\nPayment Requirements:"));
            console.log(chalk.gray("  Version:"), decoded.version ?? "(not specified)");
            console.log(chalk.gray("  Scheme:"), decoded.scheme ?? "(not specified)");
            console.log(chalk.gray("  Network:"), decoded.network ?? "(not specified)");
            console.log(chalk.gray("  Amount:"), decoded.maxAmountRequired ?? decoded.amount ?? "(not specified)");
            console.log(chalk.gray("  Pay To:"), decoded.payTo ?? decoded.recipient ?? "(not specified)");
            console.log(chalk.gray("  Resource:"), decoded.resource ?? "(not specified)");

            if (decoded.timeout) {
              console.log(chalk.gray("  Timeout:"), decoded.timeout, "seconds");
            }
            if (decoded.facilitator) {
              console.log(chalk.gray("  Facilitator:"), JSON.stringify(decoded.facilitator));
            }

            // Show raw decoded data for debugging
            console.log(chalk.gray("\nRaw x402 data:"));
            console.log(chalk.gray(JSON.stringify(decoded, null, 2)));
          } catch (e) {
            console.log(chalk.red("Failed to decode PAYMENT-REQUIRED header"));
            console.log(chalk.gray("  Raw value:"), paymentRequired.substring(0, 100) + "...");
            console.log(chalk.gray("  Error:"), e instanceof Error ? e.message : String(e));
          }
        } else {
          // Check for Flux format
          await checkFluxFormat(res);
        }

        // Print all headers for debugging
        console.log(chalk.gray("\nResponse Headers:"));
        res.headers.forEach((value, key) => {
          console.log(chalk.gray(`  ${key}:`), value.substring(0, 100) + (value.length > 100 ? "..." : ""));
        });
      } catch (error) {
        console.log(chalk.red("Error:"), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
}

/**
 * Options for the test-x402 command.
 */
interface TestX402Options {
  method: string;
  body?: string;
}

/**
 * Decoded x402 PAYMENT-REQUIRED header structure.
 */
interface X402PaymentRequired {
  version?: string;
  scheme?: string;
  network?: string;
  maxAmountRequired?: string;
  amount?: string;
  payTo?: string;
  recipient?: string;
  resource?: string;
  timeout?: number;
  facilitator?: unknown;
}

/**
 * Decode the PAYMENT-REQUIRED header from base64 JSON.
 *
 * @param header - Base64-encoded JSON header value
 * @returns Decoded payment requirement object
 */
function decodePaymentRequired(header: string): X402PaymentRequired {
  // Try base64 decoding first
  try {
    const decoded = Buffer.from(header, "base64").toString("utf-8");
    return JSON.parse(decoded) as X402PaymentRequired;
  } catch {
    // Fall back to treating it as plain JSON
    try {
      return JSON.parse(header) as X402PaymentRequired;
    } catch {
      throw new Error("Header is neither valid base64 nor JSON");
    }
  }
}

/**
 * Check if the response looks like a Flux protocol response.
 *
 * @param res - The 402 response to check
 */
async function checkFluxFormat(res: Response): Promise<void> {
  const contentType = res.headers.get("content-type");

  if (contentType?.includes("application/json")) {
    console.log(chalk.yellow("\nFlux protocol detected (not x402)"));

    try {
      const body = await res.clone().json();

      if (body.invoiceId !== undefined || body.invoice_id !== undefined) {
        console.log(chalk.gray("\nFlux Invoice:"));
        console.log(chalk.gray("  Invoice ID:"), body.invoiceId ?? body.invoice_id);
        console.log(chalk.gray("  Amount:"), body.amount ?? body.amountUnits ?? "(not specified)");
        console.log(chalk.gray("  Currency/Asset:"), body.currency ?? body.asset ?? "(not specified)");
        console.log(chalk.gray("  Chain:"), body.chain ?? body.network ?? "(not specified)");
        console.log(chalk.gray("  Pay To:"), body.payTo ?? body.pay_to ?? body.recipient ?? "(not specified)");

        if (body.expiresAt ?? body.expires_at) {
          console.log(chalk.gray("  Expires At:"), body.expiresAt ?? body.expires_at);
        }
      } else {
        console.log(chalk.gray("\nResponse body (non-standard format):"));
        console.log(chalk.gray(JSON.stringify(body, null, 2)));
      }
    } catch {
      const text = await res.text();
      console.log(chalk.gray("\nResponse body (not parseable JSON):"));
      console.log(chalk.gray(text.substring(0, 500)));
    }
  } else {
    console.log(chalk.red("\nUnknown 402 format"));
    console.log(chalk.gray("  Content-Type:"), contentType ?? "(none)");

    try {
      const text = await res.text();
      console.log(chalk.gray("\nResponse body:"));
      console.log(chalk.gray(text.substring(0, 500)));
    } catch {
      console.log(chalk.gray("  (Could not read response body)"));
    }
  }
}
