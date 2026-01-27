/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/cli/src/commands/status.ts
 * @summary CLI command to check the status of a payment by invoice ID.
 *
 * This command queries the payment status API to check whether a payment
 * has been confirmed, is still pending, or has failed.
 *
 * Used by:
 * - The main CLI entry point (index.ts) to register the 'status' command
 * - Developers tracking payment confirmation after submission
 */

import chalk from "chalk";
import type { Command } from "commander";

/**
 * Register the 'status' command with the CLI program.
 *
 * This command checks the payment status for a given invoice ID
 * by querying the payment status API endpoint.
 *
 * @param program - Commander program instance to register the command on
 *
 * @example
 * ```bash
 * poi status inv_abc123
 * poi status inv_abc123 -u https://custom-api.example.com
 * ```
 */
export function registerStatusCommand(program: Command): void {
  program
    .command("status <invoice-id>")
    .description("Check payment status for an invoice")
    .option("-u, --url <url>", "API base URL", "https://api-v2.fluxpointstudios.com")
    .action(async (invoiceId: string, options: StatusOptions) => {
      console.log(chalk.blue("Checking status for:"), invoiceId);
      console.log(chalk.gray("  API:"), options.url);

      try {
        const res = await fetch(`${options.url}/payments/status/${invoiceId}`);

        if (!res.ok) {
          if (res.status === 404) {
            console.log(chalk.yellow("\nInvoice not found"));
            console.log(chalk.gray("  The invoice may have expired or not been created yet"));
          } else {
            console.log(chalk.red("Error:"), res.status, res.statusText);
            const text = await res.text();
            if (text) {
              console.log(chalk.gray(text));
            }
          }
          return;
        }

        const status = (await res.json()) as PaymentStatusResponse;

        console.log(chalk.green("\nPayment Status:"));
        console.log(chalk.gray("  Invoice ID:"), status.invoiceId ?? invoiceId);
        console.log(chalk.gray("  Status:"), formatStatus(status.status));

        if (status.txHash) {
          console.log(chalk.gray("  TX Hash:"), status.txHash);
        }
        if (status.chain) {
          console.log(chalk.gray("  Chain:"), status.chain);
        }
        if (status.amount) {
          console.log(chalk.gray("  Amount:"), status.amount);
        }
        if (status.asset) {
          console.log(chalk.gray("  Asset:"), status.asset);
        }
        if (status.settledAt) {
          console.log(chalk.gray("  Settled At:"), status.settledAt);
        }
        if (status.expiresAt) {
          console.log(chalk.gray("  Expires At:"), status.expiresAt);
        }
        if (status.error) {
          console.log(chalk.red("  Error:"), status.error);
        }
      } catch (error) {
        console.log(chalk.red("Error:"), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
}

/**
 * Options for the status command.
 */
interface StatusOptions {
  url: string;
}

/**
 * Response from the payment status API.
 */
interface PaymentStatusResponse {
  invoiceId?: string;
  status: string;
  txHash?: string;
  chain?: string;
  amount?: string;
  asset?: string;
  settledAt?: string;
  expiresAt?: string;
  error?: string;
}

/**
 * Format a payment status with appropriate color.
 *
 * @param status - The status string to format
 * @returns Colorized status string
 */
function formatStatus(status: string): string {
  switch (status.toLowerCase()) {
    case "confirmed":
    case "consumed":
    case "settled":
    case "completed":
      return chalk.green(status);
    case "pending":
    case "submitted":
    case "processing":
      return chalk.yellow(status);
    case "failed":
    case "expired":
    case "rejected":
    case "cancelled":
      return chalk.red(status);
    default:
      return status;
  }
}
