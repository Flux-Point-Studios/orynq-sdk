/**
 * @summary CAIP-2 chain identifier helpers and mappings.
 *
 * This file provides utilities for working with chain identifiers across
 * different formats. Internally, the SDK uses CAIP-2 identifiers (e.g.,
 * "eip155:8453"), but external APIs may use friendly names (e.g., "base-mainnet").
 *
 * CAIP-2 Specification: https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md
 *
 * Used by:
 * - Payment request normalization
 * - Payer chain support detection
 * - Header parsing and generation
 */

import type { ChainId } from "./types/payment.js";

// ---------------------------------------------------------------------------
// Chain ID Constants
// ---------------------------------------------------------------------------

/**
 * Mapping from friendly chain names to CAIP-2 identifiers.
 *
 * These are the canonical internal chain IDs used throughout the SDK.
 */
export const CHAINS = {
  // EVM Chains - Base
  "base-mainnet": "eip155:8453",
  "base-sepolia": "eip155:84532",

  // EVM Chains - Ethereum
  "ethereum-mainnet": "eip155:1",
  "ethereum-sepolia": "eip155:11155111",
  "ethereum-goerli": "eip155:5",

  // EVM Chains - Polygon
  "polygon-mainnet": "eip155:137",
  "polygon-mumbai": "eip155:80001",

  // EVM Chains - Arbitrum
  "arbitrum-mainnet": "eip155:42161",
  "arbitrum-sepolia": "eip155:421614",

  // EVM Chains - Optimism
  "optimism-mainnet": "eip155:10",
  "optimism-sepolia": "eip155:11155420",

  // Cardano Chains
  "cardano-mainnet": "cardano:mainnet",
  "cardano-preprod": "cardano:preprod",
  "cardano-preview": "cardano:preview",
} as const;

/**
 * Type for friendly chain names.
 */
export type ChainName = keyof typeof CHAINS;

/**
 * Type for known CAIP-2 chain IDs.
 */
export type KnownChainId = (typeof CHAINS)[ChainName];

// ---------------------------------------------------------------------------
// Reverse Mappings
// ---------------------------------------------------------------------------

/**
 * Reverse mapping from CAIP-2 identifiers to friendly names.
 * Built at module load time.
 */
export const CHAIN_NAMES: Record<string, ChainName> = Object.fromEntries(
  Object.entries(CHAINS).map(([name, caip2]) => [caip2, name as ChainName])
) as Record<string, ChainName>;

// ---------------------------------------------------------------------------
// Chain Families
// ---------------------------------------------------------------------------

/**
 * Chain family identifiers.
 */
export type ChainFamily = "evm" | "cardano" | "unknown";

/**
 * EVM chain IDs (numeric part of eip155:X).
 */
export const EVM_CHAIN_IDS: Record<string, number> = {
  "eip155:1": 1, // Ethereum Mainnet
  "eip155:5": 5, // Goerli (deprecated)
  "eip155:10": 10, // Optimism
  "eip155:137": 137, // Polygon
  "eip155:8453": 8453, // Base
  "eip155:42161": 42161, // Arbitrum One
  "eip155:11155111": 11155111, // Sepolia
  "eip155:84532": 84532, // Base Sepolia
  "eip155:80001": 80001, // Mumbai
  "eip155:421614": 421614, // Arbitrum Sepolia
  "eip155:11155420": 11155420, // Optimism Sepolia
};

/**
 * Cardano network names.
 */
export const CARDANO_NETWORKS = ["mainnet", "preprod", "preview"] as const;
export type CardanoNetwork = (typeof CARDANO_NETWORKS)[number];

// ---------------------------------------------------------------------------
// Conversion Functions
// ---------------------------------------------------------------------------

/**
 * Convert a friendly chain name to CAIP-2 identifier.
 *
 * @param name - Friendly chain name (e.g., "base-mainnet")
 * @returns CAIP-2 identifier (e.g., "eip155:8453")
 * @throws Error if name is not recognized
 *
 * @example
 * toCAIP2("base-mainnet") // "eip155:8453"
 * toCAIP2("cardano-mainnet") // "cardano:mainnet"
 */
export function toCAIP2(name: string): ChainId {
  // If already CAIP-2 format, return as-is
  if (isCAIP2(name)) {
    return name;
  }

  const chainId = CHAINS[name as ChainName];
  if (!chainId) {
    throw new Error(`Unknown chain name: ${name}. Known chains: ${Object.keys(CHAINS).join(", ")}`);
  }
  return chainId;
}

/**
 * Convert a CAIP-2 identifier to friendly chain name.
 *
 * @param caip2 - CAIP-2 identifier (e.g., "eip155:8453")
 * @returns Friendly chain name (e.g., "base-mainnet")
 * @throws Error if CAIP-2 ID is not recognized
 *
 * @example
 * fromCAIP2("eip155:8453") // "base-mainnet"
 * fromCAIP2("cardano:mainnet") // "cardano-mainnet"
 */
export function fromCAIP2(caip2: ChainId): ChainName {
  const name = CHAIN_NAMES[caip2];
  if (!name) {
    throw new Error(`Unknown CAIP-2 chain ID: ${caip2}`);
  }
  return name;
}

/**
 * Try to convert a CAIP-2 identifier to friendly chain name.
 * Returns undefined if not recognized (instead of throwing).
 *
 * @param caip2 - CAIP-2 identifier
 * @returns Friendly chain name or undefined
 */
export function tryFromCAIP2(caip2: ChainId): ChainName | undefined {
  return CHAIN_NAMES[caip2];
}

/**
 * Normalize a chain identifier to CAIP-2 format.
 * Accepts either format as input.
 *
 * @param chain - Chain identifier in any format
 * @returns CAIP-2 identifier
 *
 * @example
 * normalizeChainId("base-mainnet") // "eip155:8453"
 * normalizeChainId("eip155:8453") // "eip155:8453"
 * normalizeChainId("8453") // "eip155:8453" (assumes EVM)
 */
export function normalizeChainId(chain: string): ChainId {
  // Already CAIP-2 format
  if (isCAIP2(chain)) {
    return chain;
  }

  // Friendly name
  if (chain in CHAINS) {
    return CHAINS[chain as ChainName];
  }

  // Numeric EVM chain ID
  const numericId = parseInt(chain, 10);
  if (!isNaN(numericId) && numericId > 0) {
    return `eip155:${numericId}`;
  }

  throw new Error(`Unable to normalize chain identifier: ${chain}`);
}

// ---------------------------------------------------------------------------
// Validation Functions
// ---------------------------------------------------------------------------

/**
 * Check if a string is in CAIP-2 format.
 *
 * @param value - String to check
 * @returns true if value matches CAIP-2 pattern
 *
 * @example
 * isCAIP2("eip155:8453") // true
 * isCAIP2("cardano:mainnet") // true
 * isCAIP2("base-mainnet") // false
 */
export function isCAIP2(value: string): boolean {
  // CAIP-2 format: namespace:reference
  // namespace: [-a-z0-9]{3,8}
  // reference: [-a-zA-Z0-9]{1,32}
  return /^[-a-z0-9]{3,8}:[-a-zA-Z0-9]{1,32}$/.test(value);
}

/**
 * Check if a chain ID is a known chain.
 *
 * @param chain - Chain identifier (any format)
 * @returns true if chain is known
 */
export function isKnownChain(chain: string): boolean {
  if (chain in CHAINS) return true;
  if (chain in CHAIN_NAMES) return true;
  return false;
}

/**
 * Check if a chain ID is an EVM chain.
 *
 * @param chain - CAIP-2 chain identifier
 * @returns true if chain is EVM-based
 */
export function isEvmChain(chain: ChainId): boolean {
  return chain.startsWith("eip155:");
}

/**
 * Check if a chain ID is a Cardano chain.
 *
 * @param chain - CAIP-2 chain identifier
 * @returns true if chain is Cardano
 */
export function isCardanoChain(chain: ChainId): boolean {
  return chain.startsWith("cardano:");
}

/**
 * Get the chain family for a chain ID.
 *
 * @param chain - CAIP-2 chain identifier
 * @returns Chain family identifier
 */
export function getChainFamily(chain: ChainId): ChainFamily {
  if (isEvmChain(chain)) return "evm";
  if (isCardanoChain(chain)) return "cardano";
  return "unknown";
}

// ---------------------------------------------------------------------------
// EVM-Specific Utilities
// ---------------------------------------------------------------------------

/**
 * Extract the numeric chain ID from an EVM CAIP-2 identifier.
 *
 * @param chain - CAIP-2 chain identifier (eip155:X)
 * @returns Numeric chain ID
 * @throws Error if not an EVM chain
 *
 * @example
 * getEvmChainId("eip155:8453") // 8453
 */
export function getEvmChainId(chain: ChainId): number {
  if (!isEvmChain(chain)) {
    throw new Error(`Not an EVM chain: ${chain}`);
  }
  const id = parseInt(chain.split(":")[1] ?? "", 10);
  if (isNaN(id)) {
    throw new Error(`Invalid EVM chain ID: ${chain}`);
  }
  return id;
}

/**
 * Create an EVM CAIP-2 identifier from a numeric chain ID.
 *
 * @param chainId - Numeric EVM chain ID
 * @returns CAIP-2 identifier
 *
 * @example
 * evmChainId(8453) // "eip155:8453"
 */
export function evmChainId(chainId: number): ChainId {
  return `eip155:${chainId}`;
}

// ---------------------------------------------------------------------------
// Cardano-Specific Utilities
// ---------------------------------------------------------------------------

/**
 * Extract the network name from a Cardano CAIP-2 identifier.
 *
 * @param chain - CAIP-2 chain identifier (cardano:X)
 * @returns Network name (mainnet, preprod, preview)
 * @throws Error if not a Cardano chain
 *
 * @example
 * getCardanoNetwork("cardano:mainnet") // "mainnet"
 */
export function getCardanoNetwork(chain: ChainId): CardanoNetwork {
  if (!isCardanoChain(chain)) {
    throw new Error(`Not a Cardano chain: ${chain}`);
  }
  const network = chain.split(":")[1] as CardanoNetwork;
  if (!CARDANO_NETWORKS.includes(network)) {
    throw new Error(`Invalid Cardano network: ${network}`);
  }
  return network;
}

/**
 * Create a Cardano CAIP-2 identifier from a network name.
 *
 * @param network - Network name (mainnet, preprod, preview)
 * @returns CAIP-2 identifier
 *
 * @example
 * cardanoChainId("mainnet") // "cardano:mainnet"
 */
export function cardanoChainId(network: CardanoNetwork): ChainId {
  return `cardano:${network}`;
}

/**
 * Check if a Cardano chain is a testnet.
 *
 * @param chain - CAIP-2 chain identifier
 * @returns true if chain is preprod or preview
 */
export function isCardanoTestnet(chain: ChainId): boolean {
  const network = getCardanoNetwork(chain);
  return network === "preprod" || network === "preview";
}

// ---------------------------------------------------------------------------
// Chain Info
// ---------------------------------------------------------------------------

/**
 * Information about a chain.
 */
export interface ChainInfo {
  /** CAIP-2 identifier */
  chainId: ChainId;
  /** Friendly name */
  name: ChainName;
  /** Chain family */
  family: ChainFamily;
  /** Whether this is a testnet */
  testnet: boolean;
  /** Native asset symbol */
  nativeAsset: string;
  /** Native asset decimals */
  nativeDecimals: number;
  /** Block explorer URL template */
  explorerUrl?: string | undefined;
}

/**
 * Get information about a chain.
 *
 * @param chain - Chain identifier (any format)
 * @returns Chain information
 * @throws Error if chain is not recognized
 */
export function getChainInfo(chain: string): ChainInfo {
  const chainId = normalizeChainId(chain);
  const name = fromCAIP2(chainId);
  const family = getChainFamily(chainId);

  // Determine testnet status
  const testnet =
    name.includes("sepolia") ||
    name.includes("goerli") ||
    name.includes("mumbai") ||
    name.includes("preprod") ||
    name.includes("preview");

  // Native asset info by family
  const nativeAsset = family === "cardano" ? "ADA" : "ETH";
  const nativeDecimals = family === "cardano" ? 6 : 18;

  // Explorer URLs
  const explorerUrls: Partial<Record<ChainName, string>> = {
    "base-mainnet": "https://basescan.org/tx/{txHash}",
    "base-sepolia": "https://sepolia.basescan.org/tx/{txHash}",
    "ethereum-mainnet": "https://etherscan.io/tx/{txHash}",
    "ethereum-sepolia": "https://sepolia.etherscan.io/tx/{txHash}",
    "cardano-mainnet": "https://cardanoscan.io/transaction/{txHash}",
    "cardano-preprod": "https://preprod.cardanoscan.io/transaction/{txHash}",
  };

  return {
    chainId,
    name,
    family,
    testnet,
    nativeAsset,
    nativeDecimals,
    explorerUrl: explorerUrls[name],
  };
}

/**
 * Get all known chains.
 *
 * @returns Array of chain information
 */
export function getAllChains(): ChainInfo[] {
  return Object.keys(CHAINS).map((name) => getChainInfo(name));
}

/**
 * Get all chains for a specific family.
 *
 * @param family - Chain family to filter by
 * @returns Array of chain information
 */
export function getChainsByFamily(family: ChainFamily): ChainInfo[] {
  return getAllChains().filter((chain) => chain.family === family);
}
