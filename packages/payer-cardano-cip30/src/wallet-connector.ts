/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-cardano-cip30/src/wallet-connector.ts
 * @summary CIP-30 wallet connection utilities for Cardano browser wallets.
 *
 * This file provides type definitions and helper functions for connecting to
 * CIP-30 compliant Cardano wallets (Nami, Eternl, Lace, Vespr, Flint, Typhon).
 *
 * CIP-30 Specification: https://cips.cardano.org/cips/cip30/
 *
 * Used by:
 * - cip30-payer.ts for wallet API access
 * - index.ts for convenience factory functions
 * - Application code for wallet discovery and connection
 */

// ---------------------------------------------------------------------------
// CIP-30 Type Definitions
// ---------------------------------------------------------------------------

/**
 * Data signature result from signData method.
 * Contains the signature and the public key used for signing.
 */
export interface DataSignature {
  /** CBOR-encoded signature */
  signature: string;
  /** CBOR-encoded public key */
  key: string;
}

/**
 * CIP-30 wallet API (before enabling).
 *
 * This interface represents the wallet object available on window.cardano[walletName]
 * before the dApp has been granted permission to access wallet functionality.
 */
export interface Cip30WalletApi {
  /**
   * Request permission to connect to the wallet.
   * Opens the wallet extension popup for user approval.
   *
   * @returns Promise resolving to the enabled wallet API
   * @throws If user rejects the connection or wallet is locked
   */
  enable(): Promise<Cip30EnabledWalletApi>;

  /**
   * Check if the dApp is already connected to this wallet.
   *
   * @returns Promise resolving to true if already connected
   */
  isEnabled(): Promise<boolean>;

  /** CIP-30 API version supported by this wallet */
  apiVersion: string;

  /** Human-readable wallet name */
  name: string;

  /** Base64-encoded wallet icon (data URI) */
  icon: string;
}

/**
 * CIP-30 enabled wallet API (after user grants permission).
 *
 * This interface represents the full wallet API available after calling enable().
 * All methods return hex-encoded CBOR data unless otherwise specified.
 */
export interface Cip30EnabledWalletApi {
  /**
   * Get the network ID the wallet is connected to.
   *
   * @returns Promise resolving to network ID:
   *   - 0 = Testnet (preprod, preview)
   *   - 1 = Mainnet
   */
  getNetworkId(): Promise<number>;

  /**
   * Get the wallet's UTxOs.
   *
   * @param amount - Optional CBOR-encoded Value to filter UTxOs that satisfy the amount
   * @param paginate - Optional pagination parameters
   * @returns Promise resolving to array of CBOR-encoded UTxOs, or undefined if none
   */
  getUtxos(
    amount?: string,
    paginate?: { page: number; limit: number }
  ): Promise<string[] | undefined>;

  /**
   * Get the total balance of the wallet.
   *
   * @returns Promise resolving to CBOR-encoded Value (lovelace + multiassets)
   */
  getBalance(): Promise<string>;

  /**
   * Get all used addresses in the wallet.
   *
   * @returns Promise resolving to array of CBOR-encoded addresses
   */
  getUsedAddresses(): Promise<string[]>;

  /**
   * Get unused addresses in the wallet.
   * Some wallets may not support this and return an empty array.
   *
   * @returns Promise resolving to array of CBOR-encoded addresses
   */
  getUnusedAddresses(): Promise<string[]>;

  /**
   * Get the wallet's change address.
   *
   * @returns Promise resolving to CBOR-encoded address
   */
  getChangeAddress(): Promise<string>;

  /**
   * Get the wallet's reward addresses (staking addresses).
   *
   * @returns Promise resolving to array of CBOR-encoded reward addresses
   */
  getRewardAddresses(): Promise<string[]>;

  /**
   * Sign a transaction with the wallet's keys.
   *
   * @param tx - CBOR-encoded unsigned transaction
   * @param partialSign - If true, only sign with keys the wallet controls
   *                      (allows multi-sig scenarios)
   * @returns Promise resolving to CBOR-encoded transaction witness set
   * @throws If user rejects the signing request
   */
  signTx(tx: string, partialSign?: boolean): Promise<string>;

  /**
   * Sign arbitrary data (CIP-8 message signing).
   *
   * @param addr - CBOR-encoded address to sign with
   * @param payload - Hex-encoded data to sign
   * @returns Promise resolving to data signature
   * @throws If user rejects the signing request
   */
  signData(addr: string, payload: string): Promise<DataSignature>;

  /**
   * Submit a signed transaction to the network.
   *
   * @param tx - CBOR-encoded signed transaction
   * @returns Promise resolving to the transaction hash (hex-encoded)
   * @throws If transaction submission fails
   */
  submitTx(tx: string): Promise<string>;

  /**
   * Get collateral UTxOs for smart contract transactions.
   * Optional in CIP-30 - not all wallets implement this.
   *
   * @param params - Optional filter parameters
   * @returns Promise resolving to array of CBOR-encoded UTxOs, or undefined
   */
  getCollateral?(params?: {
    amount?: string;
  }): Promise<string[] | undefined>;

  /**
   * Experimental API endpoints (wallet-specific).
   * May include features like getExtensions, experimental methods, etc.
   */
  experimental?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Wallet Names
// ---------------------------------------------------------------------------

/**
 * Supported CIP-30 wallet identifiers.
 *
 * These correspond to the property names on window.cardano where each
 * wallet injects its API object.
 */
export type WalletName =
  | "nami"
  | "eternl"
  | "lace"
  | "vespr"
  | "flint"
  | "typhon"
  | "gerowallet"
  | "nufi"
  | "yoroi"
  | "begin";

/**
 * All known wallet names for iteration.
 */
export const KNOWN_WALLETS: readonly WalletName[] = [
  "nami",
  "eternl",
  "lace",
  "vespr",
  "flint",
  "typhon",
  "gerowallet",
  "nufi",
  "yoroi",
  "begin",
] as const;

/**
 * Human-readable wallet display names.
 */
export const WALLET_DISPLAY_NAMES: Record<WalletName, string> = {
  nami: "Nami",
  eternl: "Eternl",
  lace: "Lace",
  vespr: "Vespr",
  flint: "Flint",
  typhon: "Typhon",
  gerowallet: "GeroWallet",
  nufi: "NuFi",
  yoroi: "Yoroi",
  begin: "Begin",
};

// ---------------------------------------------------------------------------
// Window Type Augmentation
// ---------------------------------------------------------------------------

/**
 * Cardano window object containing wallet APIs.
 */
export interface CardanoWindow {
  nami?: Cip30WalletApi;
  eternl?: Cip30WalletApi;
  lace?: Cip30WalletApi;
  vespr?: Cip30WalletApi;
  flint?: Cip30WalletApi;
  typhon?: Cip30WalletApi;
  gerowallet?: Cip30WalletApi;
  nufi?: Cip30WalletApi;
  yoroi?: Cip30WalletApi;
  begin?: Cip30WalletApi;
  [key: string]: Cip30WalletApi | undefined;
}

// Note: MeshJS already provides global type declarations for window.cardano.
// We use CardanoWindow as a more specific typing for our use case, but
// access window.cardano through runtime checks rather than augmenting Window.

// ---------------------------------------------------------------------------
// Wallet Discovery
// ---------------------------------------------------------------------------

/**
 * Information about an available wallet.
 */
export interface WalletInfo {
  /** Wallet identifier (key on window.cardano) */
  name: WalletName;
  /** Human-readable display name */
  displayName: string;
  /** CIP-30 API version */
  apiVersion: string;
  /** Base64-encoded icon (data URI) */
  icon: string;
}

/**
 * Get list of available CIP-30 wallets in the browser.
 *
 * This function checks window.cardano for installed wallet extensions.
 * Returns an empty array in non-browser environments.
 *
 * @returns Promise resolving to array of available wallet names
 *
 * @example
 * const wallets = await getAvailableWallets();
 * if (wallets.includes("nami")) {
 *   const api = await connectWallet("nami");
 * }
 */
export async function getAvailableWallets(): Promise<WalletName[]> {
  // Check for browser environment
  if (typeof window === "undefined" || !window.cardano) {
    return [];
  }

  const wallets: WalletName[] = [];

  for (const walletName of KNOWN_WALLETS) {
    if (window.cardano[walletName]) {
      wallets.push(walletName);
    }
  }

  return wallets;
}

/**
 * Get detailed information about available wallets.
 *
 * @returns Promise resolving to array of wallet info objects
 *
 * @example
 * const wallets = await getWalletInfo();
 * wallets.forEach(w => console.log(`${w.displayName}: v${w.apiVersion}`));
 */
export async function getWalletInfo(): Promise<WalletInfo[]> {
  if (typeof window === "undefined" || !window.cardano) {
    return [];
  }

  const wallets: WalletInfo[] = [];

  for (const walletName of KNOWN_WALLETS) {
    const wallet = window.cardano[walletName];
    if (wallet) {
      wallets.push({
        name: walletName,
        displayName: WALLET_DISPLAY_NAMES[walletName],
        apiVersion: wallet.apiVersion,
        icon: wallet.icon,
      });
    }
  }

  return wallets;
}

/**
 * Check if a specific wallet is available.
 *
 * @param name - Wallet name to check
 * @returns true if wallet is installed
 */
export function isWalletAvailable(name: WalletName): boolean {
  if (typeof window === "undefined" || !window.cardano) {
    return false;
  }
  return !!window.cardano[name];
}

/**
 * Check if already connected to a specific wallet.
 *
 * @param name - Wallet name to check
 * @returns Promise resolving to true if already connected
 */
export async function isWalletConnected(name: WalletName): Promise<boolean> {
  if (typeof window === "undefined" || !window.cardano) {
    return false;
  }

  const wallet = window.cardano[name] as Cip30WalletApi | undefined;
  if (!wallet) {
    return false;
  }

  try {
    // MeshJS types don't include isEnabled but CIP-30 does
    if (typeof wallet.isEnabled === "function") {
      return await wallet.isEnabled();
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Wallet Connection
// ---------------------------------------------------------------------------

/**
 * Error thrown when wallet connection fails.
 */
export class WalletConnectionError extends Error {
  /** Error code for programmatic handling */
  readonly code: string;
  /** The wallet that failed to connect */
  readonly wallet: WalletName;

  constructor(wallet: WalletName, message: string, code = "WALLET_CONNECTION_FAILED") {
    super(message);
    this.name = "WalletConnectionError";
    this.wallet = wallet;
    this.code = code;
  }
}

/**
 * Connect to a CIP-30 wallet and get the enabled API.
 *
 * This opens the wallet extension popup for user approval if not already connected.
 *
 * @param name - Wallet name to connect to
 * @returns Promise resolving to the enabled wallet API
 * @throws WalletConnectionError if wallet is not available or user rejects connection
 *
 * @example
 * try {
 *   const api = await connectWallet("nami");
 *   const balance = await api.getBalance();
 *   console.log("Connected! Balance:", balance);
 * } catch (error) {
 *   if (error instanceof WalletConnectionError) {
 *     console.error("Failed to connect:", error.message);
 *   }
 * }
 */
export async function connectWallet(name: WalletName): Promise<Cip30EnabledWalletApi> {
  // Check for browser environment
  if (typeof window === "undefined") {
    throw new WalletConnectionError(
      name,
      "Cardano wallets are only available in browser environments",
      "NOT_IN_BROWSER"
    );
  }

  // Check for cardano object
  if (!window.cardano) {
    throw new WalletConnectionError(
      name,
      "No Cardano wallets detected. Please install a CIP-30 compatible wallet extension.",
      "NO_WALLETS_DETECTED"
    );
  }

  // Check for specific wallet - cast to our interface since MeshJS types differ slightly
  const wallet = window.cardano[name] as Cip30WalletApi | undefined;
  if (!wallet) {
    const available = await getAvailableWallets();
    const availableStr = available.length > 0 ? available.join(", ") : "none";
    throw new WalletConnectionError(
      name,
      `Wallet "${name}" not found. Available wallets: ${availableStr}`,
      "WALLET_NOT_FOUND"
    );
  }

  // Attempt to enable
  try {
    const enabledApi = await wallet.enable();
    return enabledApi as Cip30EnabledWalletApi;
  } catch (error) {
    // Handle user rejection or other errors
    const message =
      error instanceof Error ? error.message : "User rejected connection or wallet is locked";
    throw new WalletConnectionError(name, `Failed to connect to ${name}: ${message}`, "ENABLE_FAILED");
  }
}

/**
 * Disconnect from a wallet (if supported).
 *
 * Note: CIP-30 does not define a standard disconnect method.
 * This function is a no-op for most wallets. Users typically
 * disconnect via the wallet extension itself.
 *
 * @param _name - Wallet name (unused, kept for API consistency)
 */
export function disconnectWallet(_name: WalletName): void {
  // CIP-30 does not define a disconnect method.
  // Connection state is managed by the wallet extension.
  // This function exists for API completeness.
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Get the first available wallet, preferring common ones.
 *
 * @returns Promise resolving to wallet name, or undefined if none available
 */
export async function getPreferredWallet(): Promise<WalletName | undefined> {
  const available = await getAvailableWallets();

  // Preference order (most popular/stable first)
  const preferred: WalletName[] = ["eternl", "nami", "lace", "vespr", "flint", "typhon"];

  for (const wallet of preferred) {
    if (available.includes(wallet)) {
      return wallet;
    }
  }

  // Return first available if no preferred found
  return available[0];
}
