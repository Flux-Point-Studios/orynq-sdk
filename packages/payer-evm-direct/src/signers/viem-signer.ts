/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-evm-direct/src/signers/viem-signer.ts
 * @summary Viem-based signer implementation for browser and Node.js environments.
 *
 * This file implements the Signer interface from @poi-sdk/core using viem's Account
 * abstraction. It supports both private key initialization and pre-configured accounts
 * from wallet connectors.
 *
 * Used by:
 * - ViemPayer for signing direct ERC-20 transfer transactions
 * - Browser applications with viem wallet integration
 * - Node.js servers with private key configuration
 */

import type { Account, LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Signer, ChainId } from "@poi-sdk/core";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration options for ViemSigner.
 *
 * Either privateKey or account must be provided, but not both.
 */
export interface ViemSignerConfig {
  /**
   * Private key for signing transactions.
   * Must be a hex string starting with "0x" (64 hex chars + prefix).
   *
   * Either privateKey or account must be provided.
   */
  privateKey?: `0x${string}`;

  /**
   * Pre-configured viem Account for signing.
   * Use this when you already have an account from a wallet connector
   * (e.g., WalletConnect, injected wallet).
   *
   * Either privateKey or account must be provided.
   */
  account?: Account;
}

// ---------------------------------------------------------------------------
// ViemSigner Implementation
// ---------------------------------------------------------------------------

/**
 * Signer implementation using viem's Account abstraction.
 *
 * This signer works in both browser and Node.js environments and supports:
 * - Private key accounts (for server-side usage)
 * - Pre-configured accounts (for wallet connector integration)
 *
 * @example Private key initialization
 * ```typescript
 * import { ViemSigner } from "@poi-sdk/payer-evm-direct/signers";
 *
 * const signer = new ViemSigner({
 *   privateKey: "0x1234...abcd",
 * });
 *
 * const address = await signer.getAddress("eip155:8453");
 * ```
 *
 * @example Account initialization (browser)
 * ```typescript
 * import { ViemSigner } from "@poi-sdk/payer-evm-direct/signers";
 * import { privateKeyToAccount } from "viem/accounts";
 *
 * const account = privateKeyToAccount("0x...");
 * const signer = new ViemSigner({ account });
 * ```
 */
export class ViemSigner implements Signer {
  /** The viem Account used for signing operations */
  private account: Account;

  /**
   * Create a new ViemSigner instance.
   *
   * @param config - Signer configuration with either privateKey or account
   * @throws Error if neither privateKey nor account is provided
   */
  constructor(config: ViemSignerConfig) {
    if (config.account) {
      this.account = config.account;
    } else if (config.privateKey) {
      this.account = privateKeyToAccount(config.privateKey);
    } else {
      throw new Error(
        "ViemSigner requires either privateKey or account in configuration"
      );
    }
  }

  // -------------------------------------------------------------------------
  // Signer Interface Implementation
  // -------------------------------------------------------------------------

  /**
   * Get the signing address for a specific chain.
   *
   * For EVM chains, the same address is used across all chains.
   *
   * @param _chain - CAIP-2 chain identifier (unused for EVM)
   * @returns Promise resolving to the address
   */
  async getAddress(_chain: ChainId): Promise<string> {
    return this.account.address;
  }

  /**
   * Sign arbitrary binary data.
   *
   * @param payload - Data to sign as Uint8Array
   * @param _chain - CAIP-2 chain identifier (unused for EVM)
   * @returns Promise resolving to the signature as Uint8Array
   * @throws Error if the account does not support signMessage
   */
  async sign(payload: Uint8Array, _chain: ChainId): Promise<Uint8Array> {
    if (!this.account.signMessage) {
      throw new Error(
        "Account does not support signMessage. " +
          "Ensure the account was created with signing capabilities."
      );
    }

    const signature = await this.account.signMessage({
      message: { raw: payload },
    });

    // Convert hex signature to Uint8Array (remove 0x prefix)
    return hexToBytes(signature);
  }

  /**
   * Sign a human-readable message (EIP-191 style).
   *
   * @param message - UTF-8 string message to sign
   * @param _chain - CAIP-2 chain identifier (unused for EVM)
   * @returns Promise resolving to the signature as hex string
   * @throws Error if the account does not support signMessage
   */
  async signMessage(message: string, _chain: ChainId): Promise<string> {
    if (!this.account.signMessage) {
      throw new Error(
        "Account does not support signMessage. " +
          "Ensure the account was created with signing capabilities."
      );
    }

    return this.account.signMessage({ message });
  }

  // -------------------------------------------------------------------------
  // Public Accessors
  // -------------------------------------------------------------------------

  /**
   * Get the underlying viem Account.
   *
   * Useful for direct access to account methods.
   *
   * @returns The viem Account instance
   */
  getAccount(): Account {
    return this.account;
  }

  /**
   * Check if this is a LocalAccount (has signTransaction).
   *
   * @returns true if the account can sign transactions directly
   */
  canSignTransactions(): boolean {
    return "signTransaction" in this.account;
  }

  /**
   * Get the account as a LocalAccount for transaction signing.
   *
   * @returns LocalAccount if available
   * @throws Error if account is not a LocalAccount
   */
  getLocalAccount(): LocalAccount {
    if (!this.canSignTransactions()) {
      throw new Error(
        "Account is not a LocalAccount. " +
          "Transaction signing requires a private key-based account."
      );
    }
    return this.account as LocalAccount;
  }
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Convert a hex string to Uint8Array.
 *
 * @param hex - Hex string with or without 0x prefix
 * @returns Uint8Array of bytes
 */
function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
