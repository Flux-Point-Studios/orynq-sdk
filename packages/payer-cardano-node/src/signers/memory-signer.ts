/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-cardano-node/src/signers/memory-signer.ts
 * @summary In-memory signer for development and testing purposes.
 *
 * WARNING: This signer stores private keys in memory and is NOT suitable
 * for production use with real funds. Use only for development and testing.
 *
 * For production deployments, use KmsSigner or implement a custom signer
 * with proper key management (HSM, secure enclaves, etc.).
 *
 * Used by:
 * - Development and testing environments
 * - Local integration testing
 *
 * Requires:
 * - @emurgo/cardano-serialization-lib-nodejs for full functionality
 */

import type { Signer, ChainId } from "@poi-sdk/core";

// ---------------------------------------------------------------------------
// Memory Signer Implementation
// ---------------------------------------------------------------------------

/**
 * In-memory signer for development and testing.
 *
 * WARNING: This signer stores private keys in memory!
 * - NEVER use in production with real funds
 * - NEVER commit private keys to source control
 * - Use only for local development and testing
 *
 * The current implementation provides stub methods that throw errors
 * instructing users to install @emurgo/cardano-serialization-lib-nodejs
 * for full functionality.
 *
 * @example
 * ```typescript
 * // Development only - use hex private key
 * const signer = new MemorySigner("your-hex-private-key");
 *
 * // This will throw until cardano-serialization-lib is installed
 * const address = await signer.getAddress("cardano:mainnet");
 * ```
 */
export class MemorySigner implements Signer {
  private readonly privateKeyHex: string;
  private static warningShown = false;

  /**
   * Create a new memory signer.
   *
   * @param privateKeyHex - Hex-encoded private key (Ed25519)
   *
   * WARNING: Storing private keys in code is a security risk.
   * This signer is for development and testing only.
   */
  constructor(privateKeyHex: string) {
    // Validate hex format
    if (!/^[0-9a-fA-F]+$/.test(privateKeyHex)) {
      throw new Error("Invalid private key: must be hex-encoded");
    }

    // Expected length for Ed25519 private key (32 bytes = 64 hex chars)
    // or extended key (64 bytes = 128 hex chars)
    if (privateKeyHex.length !== 64 && privateKeyHex.length !== 128) {
      throw new Error(
        "Invalid private key length: expected 64 or 128 hex characters"
      );
    }

    this.privateKeyHex = privateKeyHex;

    // Show warning once per process
    if (!MemorySigner.warningShown) {
      console.warn(
        "\n" +
          "=".repeat(70) + "\n" +
          "WARNING: MemorySigner is for DEVELOPMENT and TESTING only!\n" +
          "- Do NOT use with real funds\n" +
          "- Do NOT use in production\n" +
          "- Private keys in memory are vulnerable to extraction\n" +
          "For production, use KmsSigner or a hardware wallet integration.\n" +
          "=".repeat(70) + "\n"
      );
      MemorySigner.warningShown = true;
    }
  }

  /**
   * Get the payment address for this signer.
   *
   * Derives the payment address from the private key using
   * cardano-serialization-lib-nodejs.
   *
   * @param chain - CAIP-2 chain identifier (e.g., "cardano:mainnet")
   * @returns Promise resolving to bech32 address
   * @throws Until cardano-serialization-lib-nodejs is installed
   */
  async getAddress(chain: ChainId): Promise<string> {
    // Validate chain is Cardano
    if (!chain.startsWith("cardano:")) {
      throw new Error(
        `MemorySigner only supports Cardano chains. Got: ${chain}`
      );
    }

    // This is a stub - requires cardano-serialization-lib-nodejs
    // The implementation would:
    // 1. Import cardano-serialization-lib-nodejs
    // 2. Create PrivateKey from hex
    // 3. Derive public key
    // 4. Create enterprise or base address
    // 5. Return bech32 encoded address

    throw new Error(
      "MemorySigner.getAddress requires @emurgo/cardano-serialization-lib-nodejs.\n" +
        "Install it with: pnpm add @emurgo/cardano-serialization-lib-nodejs\n" +
        "Then implement the address derivation logic for your use case."
    );
  }

  /**
   * Sign a payload with the private key.
   *
   * Signs the payload using Ed25519 signature scheme.
   *
   * @param payload - Data to sign as Uint8Array
   * @param chain - CAIP-2 chain identifier
   * @returns Promise resolving to signature as Uint8Array
   * @throws Until cardano-serialization-lib-nodejs is installed
   */
  async sign(payload: Uint8Array, chain: ChainId): Promise<Uint8Array> {
    // Validate chain is Cardano
    if (!chain.startsWith("cardano:")) {
      throw new Error(
        `MemorySigner only supports Cardano chains. Got: ${chain}`
      );
    }

    // Validate payload
    if (payload.length === 0) {
      throw new Error("Cannot sign empty payload");
    }

    // This is a stub - requires cardano-serialization-lib-nodejs
    // The implementation would:
    // 1. Import cardano-serialization-lib-nodejs
    // 2. Create PrivateKey from hex
    // 3. Sign the payload
    // 4. Return signature bytes

    throw new Error(
      "MemorySigner.sign requires @emurgo/cardano-serialization-lib-nodejs.\n" +
        "Install it with: pnpm add @emurgo/cardano-serialization-lib-nodejs\n" +
        "Then implement the signing logic."
    );
  }

  /**
   * Sign a human-readable message (CIP-8 style).
   *
   * @param message - UTF-8 string message to sign
   * @param chain - CAIP-2 chain identifier
   * @returns Promise resolving to signature as hex string
   * @throws MemorySigner does not support message signing
   */
  async signMessage(_message: string, chain: ChainId): Promise<string> {
    // Validate chain is Cardano
    if (!chain.startsWith("cardano:")) {
      throw new Error(
        `MemorySigner only supports Cardano chains. Got: ${chain}`
      );
    }

    // Message signing (CIP-8) is more complex and requires
    // specific data structure construction
    throw new Error(
      "MemorySigner.signMessage is not implemented.\n" +
        "CIP-8 message signing requires building a specific data structure.\n" +
        "Consider using a wallet integration for message signing."
    );
  }

  /**
   * Get the raw private key hex (for testing only).
   *
   * WARNING: Exposing private keys is a security risk.
   * This method exists only for testing scenarios.
   *
   * @returns Hex-encoded private key
   */
  getPrivateKeyHex(): string {
    return this.privateKeyHex;
  }
}
