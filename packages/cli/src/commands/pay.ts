/**
 * @summary CLI command to manually pay an invoice using a configured payer.
 *
 * This command takes a JSON payment request (typically obtained from the
 * 'invoice' command) and executes the payment using the specified payer.
 * Currently supports EVM direct payments via private key.
 *
 * Used by:
 * - The main CLI entry point (index.ts) to register the 'pay' command
 * - Developers testing payment execution flows
 */

import chalk from "chalk";
import type { Command } from "commander";
import type { PaymentRequest } from "@fluxpointstudios/orynq-sdk-core";
import { createEvmPayer } from "@fluxpointstudios/orynq-sdk-payer-evm-direct";
import { readFileSync, existsSync } from "node:fs";

/**
 * Register the 'pay' command with the CLI program.
 *
 * This command executes a payment for a given invoice. The invoice must be
 * provided as a JSON string (typically copy-pasted from the 'invoice' command).
 *
 * @param program - Commander program instance to register the command on
 *
 * @example
 * ```bash
 * # Using environment variable (RECOMMENDED)
 * export POI_PRIVATE_KEY=0x...
 * poi pay '{"protocol":"flux","chain":"eip155:8453","asset":"USDC","amountUnits":"1000000","payTo":"0x..."}'
 *
 * # Using key file
 * poi pay '{"..."}' --key-file ./my-key.txt --rpc https://mainnet.base.org
 *
 * # Direct key (NOT RECOMMENDED - stored in shell history)
 * poi pay '{"..."}' -k 0xprivatekey
 * ```
 */
export function registerPayCommand(program: Command): void {
  program
    .command("pay <invoice-json>")
    .description("Pay an invoice manually")
    .option("-p, --payer <type>", "Payer type (evm-direct)", "evm-direct")
    .option("-k, --key <privateKey>", "Private key (INSECURE: stored in shell history, use POI_PRIVATE_KEY env var instead)")
    .option("--key-file <path>", "Path to file containing private key (more secure than --key)")
    .option("--rpc <url>", "RPC URL for EVM chain")
    .action(async (invoiceJson: string, options: PayOptions) => {
      // Parse the invoice JSON
      let request: PaymentRequest;
      try {
        request = JSON.parse(invoiceJson) as PaymentRequest;
      } catch {
        console.log(chalk.red("Error: Invalid invoice JSON"));
        process.exit(1);
      }

      // Validate required fields
      if (!request.chain || !request.amountUnits || !request.payTo) {
        console.log(chalk.red("Error: Invoice must have chain, amountUnits, and payTo"));
        process.exit(1);
      }

      console.log(chalk.blue("Paying invoice..."));
      console.log(chalk.gray("  Protocol:"), request.protocol ?? "(unknown)");
      console.log(chalk.gray("  Chain:"), request.chain);
      console.log(chalk.gray("  Asset:"), request.asset);
      console.log(chalk.gray("  Amount:"), request.amountUnits);
      console.log(chalk.gray("  Pay To:"), request.payTo);

      if (options.payer === "evm-direct") {
        await handleEvmDirectPayment(request, options);
      } else {
        console.log(chalk.red(`Unknown payer type: ${options.payer}`));
        console.log(chalk.gray("Supported payers: evm-direct"));
        process.exit(1);
      }
    });
}

/**
 * Options for the pay command.
 */
interface PayOptions {
  payer: string;
  key?: string;
  keyFile?: string;
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
function resolvePrivateKey(options: PayOptions): string | undefined {
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

/**
 * Handle payment using the EVM direct payer.
 *
 * Creates a ViemPayer with the provided private key and executes
 * the payment, displaying the resulting transaction hash.
 *
 * @param request - The payment request to execute
 * @param options - Command options including private key and RPC URL
 */
async function handleEvmDirectPayment(request: PaymentRequest, options: PayOptions): Promise<void> {
  const privateKey = resolvePrivateKey(options);

  if (!privateKey) {
    console.log(chalk.red("Error: Private key required for evm-direct payer"));
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

  try {
    const payerConfig: { rpcUrls?: Record<string, string> } = {};
    if (options.rpc) {
      payerConfig.rpcUrls = { [request.chain]: options.rpc };
    }
    const payer = createEvmPayer(privateKey as `0x${string}`, payerConfig);

    // Check if payer supports this request
    if (!payer.supports(request)) {
      console.log(chalk.red("Error: Payer does not support this payment"));
      console.log(chalk.gray("  Chain:"), request.chain);
      console.log(chalk.gray("  Asset:"), request.asset);
      console.log(chalk.gray("  Check that the chain and asset are supported"));
      process.exit(1);
    }

    console.log(chalk.yellow("\nSubmitting transaction..."));

    const proof = await payer.pay(request);

    console.log(chalk.green("\nPayment successful!"));
    console.log(chalk.gray("  Proof Type:"), proof.kind);

    if (proof.kind === "evm-txhash") {
      console.log(chalk.gray("  TX Hash:"), proof.txHash);

      // Generate block explorer link based on chain
      const explorerUrl = getExplorerUrl(request.chain, proof.txHash);
      if (explorerUrl) {
        console.log(chalk.gray("  Explorer:"), explorerUrl);
      }
    }
  } catch (error) {
    console.log(chalk.red("\nPayment failed:"), error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * Get the block explorer URL for a transaction.
 *
 * @param chain - CAIP-2 chain identifier
 * @param txHash - Transaction hash
 * @returns Explorer URL or undefined if chain not recognized
 */
function getExplorerUrl(chain: string, txHash: string): string | undefined {
  const explorers: Record<string, string> = {
    "eip155:1": "https://etherscan.io/tx/",
    "eip155:8453": "https://basescan.org/tx/",
    "eip155:84532": "https://sepolia.basescan.org/tx/",
    "eip155:137": "https://polygonscan.com/tx/",
    "eip155:42161": "https://arbiscan.io/tx/",
    "eip155:10": "https://optimistic.etherscan.io/tx/",
  };

  const baseUrl = explorers[chain];
  if (baseUrl) {
    return baseUrl + txHash;
  }
  return undefined;
}
