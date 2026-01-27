/**
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
 * - @emurgo/cardano-serialization-lib-nodejs for cryptographic operations
 */

import type { Signer, ChainId } from "@fluxpointstudios/poi-sdk-core";

// ---------------------------------------------------------------------------
// CSL Import Helper
// ---------------------------------------------------------------------------

/**
 * Dynamically import cardano-serialization-lib-nodejs.
 * This allows the package to be used without CSL for basic provider operations.
 */
async function loadCSL(): Promise<typeof import("@emurgo/cardano-serialization-lib-nodejs")> {
  try {
    const CSL = await import("@emurgo/cardano-serialization-lib-nodejs");
    return CSL;
  } catch {
    throw new Error(
      "MemorySigner requires @emurgo/cardano-serialization-lib-nodejs.\n" +
        "Install it with: pnpm add @emurgo/cardano-serialization-lib-nodejs"
    );
  }
}

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
 * @example
 * ```typescript
 * // Development only - use hex private key
 * const signer = new MemorySigner("your-hex-private-key");
 *
 * const address = await signer.getAddress("cardano:mainnet");
 * const signature = await signer.sign(txBodyHash, "cardano:mainnet");
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
   */
  async getAddress(chain: ChainId): Promise<string> {
    // Validate chain is Cardano
    if (!chain.startsWith("cardano:")) {
      throw new Error(
        `MemorySigner only supports Cardano chains. Got: ${chain}`
      );
    }

    const CSL = await loadCSL();

    // Determine network ID from chain
    const network = chain.replace("cardano:", "");
    const networkId = network === "mainnet" ? 1 : 0;

    // Create private key from hex
    // Note: CSL.PrivateKey has a private constructor, so we use factory methods
    const privateKey = this.privateKeyHex.length === 128
      ? CSL.PrivateKey.from_extended_bytes(Buffer.from(this.privateKeyHex, "hex"))
      : CSL.PrivateKey.from_normal_bytes(Buffer.from(this.privateKeyHex, "hex"));

    // Get public key
    const publicKey = privateKey.to_public();

    // Create enterprise address (payment key only, no staking)
    // This is the simplest address type for payment purposes
    const credential = CSL.Credential.from_keyhash(publicKey.hash());
    const address = CSL.EnterpriseAddress.new(networkId, credential);

    return address.to_address().to_bech32();
  }

  /**
   * Sign a payload with the private key.
   *
   * Signs the payload using Ed25519 signature scheme.
   *
   * @param payload - Data to sign as Uint8Array
   * @param chain - CAIP-2 chain identifier
   * @returns Promise resolving to signature as Uint8Array
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

    const CSL = await loadCSL();

    // Create private key from hex
    const privateKey = this.privateKeyHex.length === 128
      ? CSL.PrivateKey.from_extended_bytes(Buffer.from(this.privateKeyHex, "hex"))
      : CSL.PrivateKey.from_normal_bytes(Buffer.from(this.privateKeyHex, "hex"));

    // Sign the payload
    const signature = privateKey.sign(payload);

    return signature.to_bytes();
  }

  /**
   * Sign a transaction body and return the witness.
   *
   * This is a convenience method for transaction signing that creates
   * the witness set directly.
   *
   * @param txBodyHash - Transaction body hash as Uint8Array (32 bytes)
   * @param chain - CAIP-2 chain identifier
   * @returns Promise resolving to vkey witness CBOR hex
   */
  async signTx(txBodyHash: Uint8Array, chain: ChainId): Promise<string> {
    // Validate chain is Cardano
    if (!chain.startsWith("cardano:")) {
      throw new Error(
        `MemorySigner only supports Cardano chains. Got: ${chain}`
      );
    }

    // Validate hash length (should be 32 bytes)
    if (txBodyHash.length !== 32) {
      throw new Error(
        `Invalid transaction body hash length: expected 32 bytes, got ${txBodyHash.length}`
      );
    }

    const CSL = await loadCSL();

    // Create private key from hex
    const privateKey = this.privateKeyHex.length === 128
      ? CSL.PrivateKey.from_extended_bytes(Buffer.from(this.privateKeyHex, "hex"))
      : CSL.PrivateKey.from_normal_bytes(Buffer.from(this.privateKeyHex, "hex"));

    // Get public key for witness
    const publicKey = privateKey.to_public();

    // Sign the transaction body hash
    const signature = privateKey.sign(txBodyHash);

    // Create vkey witness
    const vkeyWitness = CSL.Vkeywitness.new(
      CSL.Vkey.new(publicKey),
      signature
    );

    return Buffer.from(vkeyWitness.to_bytes()).toString("hex");
  }

  /**
   * Get the public key hash (verification key hash).
   *
   * @param chain - CAIP-2 chain identifier
   * @returns Promise resolving to public key hash as hex
   */
  async getPublicKeyHash(chain: ChainId): Promise<string> {
    // Validate chain is Cardano
    if (!chain.startsWith("cardano:")) {
      throw new Error(
        `MemorySigner only supports Cardano chains. Got: ${chain}`
      );
    }

    const CSL = await loadCSL();

    // Create private key from hex
    const privateKey = this.privateKeyHex.length === 128
      ? CSL.PrivateKey.from_extended_bytes(Buffer.from(this.privateKeyHex, "hex"))
      : CSL.PrivateKey.from_normal_bytes(Buffer.from(this.privateKeyHex, "hex"));

    // Get public key and hash
    const publicKey = privateKey.to_public();
    const keyHash = publicKey.hash();

    return Buffer.from(keyHash.to_bytes()).toString("hex");
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

  /**
   * Reset the warning flag (for testing).
   * This is only used in tests to ensure warnings appear.
   */
  static resetWarning(): void {
    MemorySigner.warningShown = false;
  }
}
