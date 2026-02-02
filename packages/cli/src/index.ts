/**
 * @summary Main entry point for the @fluxpointstudios/orynq-sdk-cli package.
 *
 * This is a developer tool CLI for testing x402 and Flux 402 payment flows.
 * It provides commands for inspecting invoices, executing payments, checking
 * balances, and testing protocol compatibility.
 *
 * Available commands:
 * - poi invoice <url>   - Get payment invoice for an endpoint
 * - poi pay <json>      - Pay an invoice manually
 * - poi status <id>     - Check payment status
 * - poi balance <addr>  - Check wallet balance
 * - poi call <url>      - Make request with auto-pay
 * - poi test-x402 <url> - Test x402 compatibility
 *
 * Used by:
 * - Developers testing 402 payment-protected APIs
 * - CI/CD pipelines for integration testing
 * - Debugging payment flow issues
 */

import { Command } from "commander";
import chalk from "chalk";
import {
  registerInvoiceCommand,
  registerPayCommand,
  registerStatusCommand,
  registerBalanceCommand,
  registerCallCommand,
  registerTestX402Command,
} from "./commands/index.js";

/**
 * Package version - should match package.json.
 */
const VERSION = "0.0.1";

/**
 * Create and configure the CLI program.
 */
function createProgram(): Command {
  const program = new Command();

  program
    .name("poi")
    .description("orynq-sdk CLI - Testing tool for 402 payment flows")
    .version(VERSION);

  // Register all commands
  registerInvoiceCommand(program);
  registerPayCommand(program);
  registerStatusCommand(program);
  registerBalanceCommand(program);
  registerCallCommand(program);
  registerTestX402Command(program);

  return program;
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const program = createProgram();

  // Parse command line arguments
  await program.parseAsync(process.argv);

  // Show help if no command provided
  if (!process.argv.slice(2).length) {
    console.log(chalk.cyan("\norynq-sdk CLI"));
    console.log(chalk.gray("Testing tool for x402 and Flux payment flows\n"));
    program.outputHelp();
  }
}

// Run the CLI
main().catch((error) => {
  console.error(chalk.red("Fatal error:"), error instanceof Error ? error.message : String(error));
  process.exit(1);
});
