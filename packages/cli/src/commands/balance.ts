/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/cli/src/commands/balance.ts
 * @summary CLI command to check wallet balances on supported chains.
 *
 * This command queries the blockchain to check ETH and USDC balances
 * for a given address. Useful for verifying funds before making payments.
 *
 * Used by:
 * - The main CLI entry point (index.ts) to register the 'balance' command
 * - Developers checking wallet balances before testing payments
 */

import chalk from "chalk";
import type { Command } from "commander";
import { createPublicClient, http, formatUnits, type Chain, type PublicClient, type Transport } from "viem";
import { base, baseSepolia, mainnet, polygon, arbitrum, optimism } from "viem/chains";

/**
 * Mapping of CAIP-2 chain IDs to viem chain configurations.
 */
const CHAINS: Record<string, Chain> = {
  "eip155:1": mainnet,
  "eip155:8453": base,
  "eip155:84532": baseSepolia,
  "eip155:137": polygon,
  "eip155:42161": arbitrum,
  "eip155:10": optimism,
};

/**
 * USDC contract addresses by chain.
 */
const USDC: Record<string, `0x${string}`> = {
  "eip155:1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "eip155:137": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  "eip155:42161": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  "eip155:10": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
};

/**
 * ERC-20 balanceOf ABI for reading token balances.
 */
const ERC20_BALANCE_ABI = [
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "function",
  },
] as const;

/**
 * Register the 'balance' command with the CLI program.
 *
 * This command checks the balance of native tokens (ETH) or ERC-20 tokens
 * (USDC) for a given address on a specified chain.
 *
 * @param program - Commander program instance to register the command on
 *
 * @example
 * ```bash
 * poi balance 0x1234...5678
 * poi balance 0x1234...5678 -c eip155:8453 -a USDC
 * poi balance 0x1234...5678 -c eip155:84532 -a ETH --rpc https://sepolia.base.org
 * ```
 */
export function registerBalanceCommand(program: Command): void {
  program
    .command("balance <address>")
    .description("Check wallet balance")
    .option("-c, --chain <chain>", "Chain ID (CAIP-2)", "eip155:8453")
    .option("-a, --asset <asset>", "Asset (ETH, USDC)", "USDC")
    .option("--rpc <url>", "RPC URL (optional)")
    .action(async (address: string, options: BalanceOptions) => {
      // Validate address format
      if (!address.startsWith("0x") || address.length !== 42) {
        console.log(chalk.red("Error: Invalid address format"));
        console.log(chalk.gray("  Expected: 0x followed by 40 hex characters"));
        process.exit(1);
      }

      const chain = CHAINS[options.chain];
      if (!chain) {
        console.log(chalk.red("Unknown chain:"), options.chain);
        console.log(chalk.gray("Supported chains:"));
        for (const [caip2, c] of Object.entries(CHAINS)) {
          console.log(chalk.gray(`  ${caip2} (${c.name})`));
        }
        process.exit(1);
      }

      console.log(chalk.blue("Checking balance..."));
      console.log(chalk.gray("  Address:"), address);
      console.log(chalk.gray("  Chain:"), options.chain, `(${chain.name})`);
      console.log(chalk.gray("  Asset:"), options.asset);

      try {
        const client = createPublicClient({
          chain,
          transport: http(options.rpc),
        });

        if (options.asset === "ETH" || options.asset === "native") {
          await checkNativeBalance(client, address as `0x${string}`);
        } else if (options.asset === "USDC") {
          await checkUsdcBalance(client, address as `0x${string}`, options.chain);
        } else {
          console.log(chalk.red("Unknown asset:"), options.asset);
          console.log(chalk.gray("Supported assets: ETH, native, USDC"));
          process.exit(1);
        }
      } catch (error) {
        console.log(chalk.red("Error:"), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
}

/**
 * Options for the balance command.
 */
interface BalanceOptions {
  chain: string;
  asset: string;
  rpc?: string;
}

/**
 * Check and display native token balance (ETH).
 *
 * @param client - Viem public client
 * @param address - Wallet address to check
 */
async function checkNativeBalance(
  client: PublicClient<Transport, Chain>,
  address: `0x${string}`
): Promise<void> {
  const balance = await client.getBalance({ address });
  const formatted = formatUnits(balance, 18);

  console.log(chalk.green("\nBalance:"), formatted, "ETH");
  console.log(chalk.gray("  Raw (wei):"), balance.toString());
}

/**
 * Check and display USDC balance.
 *
 * @param client - Viem public client
 * @param address - Wallet address to check
 * @param chainId - CAIP-2 chain identifier
 */
async function checkUsdcBalance(
  client: PublicClient<Transport, Chain>,
  address: `0x${string}`,
  chainId: string
): Promise<void> {
  const contractAddress = USDC[chainId];
  if (!contractAddress) {
    console.log(chalk.red("USDC not available on this chain"));
    console.log(chalk.gray("Chains with USDC support:"));
    for (const [caip2] of Object.entries(USDC)) {
      const chain = CHAINS[caip2];
      console.log(chalk.gray(`  ${caip2} (${chain?.name ?? "unknown"})`));
    }
    process.exit(1);
  }

  const balance = await client.readContract({
    address: contractAddress,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [address],
  }) as bigint;

  // USDC has 6 decimals
  const formatted = formatUnits(balance, 6);

  console.log(chalk.green("\nBalance:"), formatted, "USDC");
  console.log(chalk.gray("  Raw (atomic):"), String(balance));
  console.log(chalk.gray("  Contract:"), contractAddress);
}
