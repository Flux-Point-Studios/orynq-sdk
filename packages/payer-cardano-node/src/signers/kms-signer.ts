/**
 * @summary AWS KMS-based signer for production Cardano deployments.
 *
 * This signer uses AWS Key Management Service (KMS) to manage private keys
 * securely. Keys never leave the KMS hardware security modules (HSMs).
 *
 * IMPORTANT: AWS KMS DOES NOT NATIVELY SUPPORT Ed25519
 *
 * Cardano uses Ed25519 for cryptographic signatures. AWS KMS supports:
 * - RSA (various key sizes)
 * - ECC_NIST_P256, ECC_NIST_P384, ECC_NIST_P521
 * - ECC_SECG_P256K1 (secp256k1, used by Bitcoin/Ethereum)
 *
 * This signer provides a SECP256K1 ECDSA implementation that can be used
 * with Cardano tooling that supports alternative signature schemes, or
 * for signing raw transaction data that will be verified off-chain.
 *
 * For native Cardano Ed25519 signatures with HSM security, consider:
 * 1. AWS CloudHSM with custom key import (supports Ed25519)
 * 2. External HSM solutions (Ledger, Trezor, YubiKey)
 * 3. HashiCorp Vault with Ed25519 support
 *
 * Used by:
 * - Production server-side payment processing (with secp256k1)
 * - Enterprise deployments requiring HSM-level security
 * - Off-chain signature verification scenarios
 *
 * Requires:
 * - @aws-sdk/client-kms for AWS KMS integration
 *
 * IAM Permissions Required:
 * - kms:Sign - Sign data with the KMS key
 * - kms:GetPublicKey - Retrieve the public key for address derivation
 * - kms:DescribeKey - (Optional) Verify key configuration
 */

import type { Signer, ChainId } from "@fluxpointstudios/poi-sdk-core";

// ---------------------------------------------------------------------------
// Type Declarations for Optional AWS SDK
// ---------------------------------------------------------------------------

/**
 * KMS client interface (subset of @aws-sdk/client-kms KMSClient).
 */
interface KMSClientLike {
  send(command: unknown): Promise<unknown>;
}

/**
 * GetPublicKey response interface.
 */
interface GetPublicKeyResponse {
  PublicKey?: Uint8Array;
  KeySpec?: string;
  KeyUsage?: string;
}

/**
 * Sign response interface.
 */
interface SignResponse {
  Signature?: Uint8Array;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for AWS KMS signer.
 */
export interface KmsSignerConfig {
  /**
   * AWS KMS key ID, alias, or ARN.
   *
   * The key must be configured for signing/verification.
   *
   * For secp256k1 signatures:
   * - Key spec: ECC_SECG_P256K1
   * - Key usage: SIGN_VERIFY
   *
   * Examples:
   * - Key ID: "1234abcd-12ab-34cd-56ef-1234567890ab"
   * - Alias: "alias/my-cardano-key"
   * - ARN: "arn:aws:kms:us-east-1:123456789012:key/..."
   */
  keyId: string;

  /**
   * AWS region where the key is located.
   * If not specified, uses AWS_REGION environment variable.
   */
  region?: string;

  /**
   * AWS credentials profile to use.
   * If not specified, uses default credential chain.
   */
  profile?: string;

  /**
   * Custom endpoint URL for KMS API.
   * Useful for local development with LocalStack.
   */
  endpoint?: string;

  /**
   * Optional AWS credentials configuration.
   * If not provided, uses the default AWS credential provider chain.
   */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };

  /**
   * Key type to use for signing.
   *
   * - "secp256k1": Use ECC_SECG_P256K1 for ECDSA signatures.
   *               Compatible with some Cardano tooling that accepts
   *               secp256k1 signatures.
   *
   * - "ed25519": NOT SUPPORTED BY AWS KMS.
   *              Will throw an error directing users to CloudHSM or
   *              external HSM solutions.
   *
   * @default "secp256k1"
   */
  keyType?: "secp256k1" | "ed25519";

  /**
   * Custom address derivation function.
   *
   * Since Cardano natively uses Ed25519, deriving a standard Cardano
   * address from a secp256k1 public key requires custom logic.
   *
   * If not provided, getAddress() will throw an error explaining
   * the limitation.
   *
   * @param publicKey - Raw secp256k1 public key (65 bytes, uncompressed)
   * @param network - "mainnet" or "preprod"
   * @returns Cardano address (bech32)
   */
  deriveAddress?: (
    publicKey: Uint8Array,
    network: "mainnet" | "preprod"
  ) => string | Promise<string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * secp256k1 curve order (n).
 */
const SECP256K1_N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"
);

/**
 * Half of secp256k1 curve order.
 */
const SECP256K1_HALF_N = SECP256K1_N / BigInt(2);

// ---------------------------------------------------------------------------
// KMS Signer Implementation
// ---------------------------------------------------------------------------

/**
 * AWS KMS-based signer for production Cardano deployments.
 *
 * IMPORTANT LIMITATION:
 * AWS KMS does not support Ed25519, which is the native signature scheme
 * for Cardano. This signer uses secp256k1 ECDSA as a workaround.
 *
 * Use Cases:
 * 1. Off-chain signature verification where you control the verifier
 * 2. Integration with Cardano tooling that accepts secp256k1 signatures
 * 3. Multi-sig schemes with custom verification logic
 *
 * For native Cardano Ed25519 signatures with HSM security:
 * - AWS CloudHSM with custom key import
 * - External HSM (Ledger, Trezor, YubiKey)
 * - HashiCorp Vault Enterprise with Ed25519 support
 *
 * AWS Key Requirements:
 * - Key type: Asymmetric
 * - Key spec: ECC_SECG_P256K1 (secp256k1)
 * - Key usage: SIGN_VERIFY
 *
 * Create a suitable KMS key:
 * ```bash
 * aws kms create-key \
 *   --key-spec ECC_SECG_P256K1 \
 *   --key-usage SIGN_VERIFY \
 *   --description "Cardano signing key (secp256k1)"
 * ```
 *
 * IAM Policy Example:
 * ```json
 * {
 *   "Version": "2012-10-17",
 *   "Statement": [{
 *     "Effect": "Allow",
 *     "Action": [
 *       "kms:Sign",
 *       "kms:GetPublicKey",
 *       "kms:DescribeKey"
 *     ],
 *     "Resource": "arn:aws:kms:us-east-1:123456789012:key/*"
 *   }]
 * }
 * ```
 *
 * @example
 * ```typescript
 * import { KmsSigner } from "@fluxpointstudios/poi-sdk-payer-cardano-node/signers";
 *
 * const signer = new KmsSigner({
 *   keyId: "alias/my-cardano-payment-key",
 *   region: "us-east-1",
 *   // Custom address derivation for secp256k1
 *   deriveAddress: (publicKey, network) => {
 *     // Your custom logic to derive Cardano address
 *     // from secp256k1 public key
 *     return "addr1...";
 *   },
 * });
 *
 * // Sign transaction hash
 * const signature = await signer.sign(txBodyHash, "cardano:mainnet");
 * ```
 */
export class KmsSigner implements Signer {
  private readonly config: KmsSignerConfig;

  /** Lazily initialized KMS client */
  private kmsClient: KMSClientLike | null = null;

  /** Cached raw public key */
  private cachedPublicKey: Uint8Array | null = null;

  /** Cached address per network */
  private cachedAddresses: Map<string, string> = new Map();

  /**
   * Create a new KMS signer.
   *
   * @param config - KMS configuration
   * @throws Error if keyId is not provided or ed25519 is requested
   */
  constructor(config: KmsSignerConfig) {
    if (!config.keyId || config.keyId.trim() === "") {
      throw new Error("KmsSigner requires a keyId");
    }

    // Check for Ed25519 request and provide clear guidance
    if (config.keyType === "ed25519") {
      throw new Error(
        "AWS KMS does not support Ed25519 keys.\n\n" +
          "Cardano natively uses Ed25519 for cryptographic signatures, " +
          "but AWS KMS only supports the following asymmetric key types:\n" +
          "- RSA (various sizes)\n" +
          "- ECC_NIST_P256, ECC_NIST_P384, ECC_NIST_P521\n" +
          "- ECC_SECG_P256K1 (secp256k1)\n\n" +
          "Options for Ed25519 with HSM security:\n" +
          "1. AWS CloudHSM - Import custom Ed25519 keys\n" +
          "2. HashiCorp Vault Enterprise - Supports Ed25519 transit keys\n" +
          "3. External HSM - Ledger, Trezor, YubiKey support Ed25519\n\n" +
          "Alternatively, use KmsSigner with secp256k1 for scenarios where:\n" +
          "- You control the signature verification logic\n" +
          "- Your Cardano tooling accepts secp256k1 signatures\n" +
          "- You're implementing custom multi-sig schemes"
      );
    }

    this.config = {
      ...config,
      keyType: config.keyType ?? "secp256k1",
    };
  }

  /**
   * Get the payment address for this KMS key.
   *
   * Since Cardano uses Ed25519 and this signer uses secp256k1,
   * a custom address derivation function must be provided.
   *
   * @param chain - CAIP-2 chain identifier (e.g., "cardano:mainnet")
   * @returns Promise resolving to address
   * @throws Error if deriveAddress is not configured
   */
  async getAddress(chain: ChainId): Promise<string> {
    // Validate chain is Cardano
    if (!chain.startsWith("cardano:")) {
      throw new Error(
        `KmsSigner only supports Cardano chains. Got: ${chain}`
      );
    }

    // Check cache
    const cached = this.cachedAddresses.get(chain);
    if (cached) {
      return cached;
    }

    // Require custom address derivation
    if (!this.config.deriveAddress) {
      throw new Error(
        "KmsSigner.getAddress requires a custom deriveAddress function.\n\n" +
          "Since AWS KMS uses secp256k1 (not Ed25519), standard Cardano " +
          "address derivation is not possible.\n\n" +
          "Provide a deriveAddress function in the KmsSigner config:\n" +
          "```typescript\n" +
          "const signer = new KmsSigner({\n" +
          "  keyId: 'alias/my-key',\n" +
          "  deriveAddress: (publicKey, network) => {\n" +
          "    // Your custom address derivation logic\n" +
          "    return 'addr1...';\n" +
          "  },\n" +
          "});\n" +
          "```"
      );
    }

    // Get public key from KMS
    const publicKey = await this.getPublicKey();

    // Derive network from chain
    const network = chain.includes("mainnet") ? "mainnet" : "preprod";

    // Use custom derivation
    const address = await this.config.deriveAddress(publicKey, network);

    // Cache and return
    this.cachedAddresses.set(chain, address);
    return address;
  }

  /**
   * Sign a payload using KMS.
   *
   * Uses ECDSA_SHA_256 with secp256k1 curve.
   *
   * @param payload - Data to sign as Uint8Array (typically 32-byte hash)
   * @param chain - CAIP-2 chain identifier
   * @returns Promise resolving to signature as Uint8Array (64 bytes: r + s)
   * @throws Error if KMS signing fails
   */
  async sign(payload: Uint8Array, chain: ChainId): Promise<Uint8Array> {
    // Validate chain is Cardano
    if (!chain.startsWith("cardano:")) {
      throw new Error(
        `KmsSigner only supports Cardano chains. Got: ${chain}`
      );
    }

    // Validate payload
    if (payload.length === 0) {
      throw new Error("Cannot sign empty payload");
    }

    // For Cardano, the payload is typically already a 32-byte hash
    // If it's not 32 bytes, we hash it with SHA-256
    let digest = payload;
    if (payload.length !== 32) {
      digest = await this.sha256(payload);
    }

    // Sign with KMS
    const derSignature = await this.kmsSign(digest);

    // Parse DER signature to get r and s
    const { r, s } = this.parseDerSignature(derSignature);

    // Normalize S to low value
    const normalizedS = this.normalizeS(s);

    // Return 64-byte signature (r + s, no recovery byte)
    const signature = new Uint8Array(64);
    signature.set(r, 0);
    signature.set(normalizedS, 32);

    return signature;
  }

  /**
   * Sign a human-readable message.
   *
   * @param _message - UTF-8 string message to sign
   * @param chain - CAIP-2 chain identifier
   * @returns Promise resolving to signature as hex string
   * @throws KmsSigner does not support CIP-8 message signing
   */
  async signMessage(_message: string, chain: ChainId): Promise<string> {
    // Validate chain is Cardano
    if (!chain.startsWith("cardano:")) {
      throw new Error(
        `KmsSigner only supports Cardano chains. Got: ${chain}`
      );
    }

    throw new Error(
      "KmsSigner.signMessage is not implemented.\n\n" +
        "CIP-8 message signing for Cardano requires Ed25519 signatures, " +
        "which AWS KMS does not support.\n\n" +
        "For CIP-8 compliant message signing, use:\n" +
        "- MemorySigner with @emurgo/cardano-serialization-lib-nodejs\n" +
        "- Browser wallet via CIP-30 API\n" +
        "- CloudHSM with Ed25519 key import"
    );
  }

  /**
   * Get the raw secp256k1 public key.
   *
   * @returns Promise resolving to uncompressed public key (65 bytes)
   */
  async getRawPublicKey(): Promise<Uint8Array> {
    return this.getPublicKey();
  }

  /**
   * Get the KMS key ID.
   *
   * @returns The configured KMS key ID
   */
  getKeyId(): string {
    return this.config.keyId;
  }

  /**
   * Get the AWS region.
   *
   * @returns The configured region or undefined
   */
  getRegion(): string | undefined {
    return this.config.region;
  }

  /**
   * Get the key type.
   *
   * @returns "secp256k1" (the only supported type)
   */
  getKeyType(): "secp256k1" {
    return "secp256k1";
  }

  // -------------------------------------------------------------------------
  // Private Methods - KMS Operations
  // -------------------------------------------------------------------------

  /**
   * Get or create the KMS client.
   */
  private async getKmsClient(): Promise<KMSClientLike> {
    if (this.kmsClient) {
      return this.kmsClient;
    }

    try {
      const { KMSClient } = await import("@aws-sdk/client-kms");

      const clientConfig: Record<string, unknown> = {};

      if (this.config.region) {
        clientConfig.region = this.config.region;
      }

      if (this.config.endpoint) {
        clientConfig.endpoint = this.config.endpoint;
      }

      if (this.config.credentials) {
        clientConfig.credentials = this.config.credentials;
      }

      this.kmsClient = new KMSClient(clientConfig) as KMSClientLike;
      return this.kmsClient;
    } catch (error) {
      throw new Error(
        "KmsSigner requires @aws-sdk/client-kms.\n" +
          "Install it with: pnpm add @aws-sdk/client-kms\n" +
          "Original error: " +
          (error instanceof Error ? error.message : String(error))
      );
    }
  }

  /**
   * Retrieve the public key from KMS.
   */
  private async getPublicKey(): Promise<Uint8Array> {
    if (this.cachedPublicKey) {
      return this.cachedPublicKey;
    }

    const client = await this.getKmsClient();

    try {
      const { GetPublicKeyCommand } = await import("@aws-sdk/client-kms");

      const command = new GetPublicKeyCommand({
        KeyId: this.config.keyId,
      });

      const response = (await client.send(command)) as GetPublicKeyResponse;

      if (!response.PublicKey) {
        throw new Error("KMS GetPublicKey returned no public key");
      }

      // Verify key spec is secp256k1
      if (response.KeySpec && response.KeySpec !== "ECC_SECG_P256K1") {
        throw new Error(
          `Invalid KMS key spec: ${response.KeySpec}. ` +
            "KmsSigner requires ECC_SECG_P256K1 (secp256k1) key.\n\n" +
            "Create a compatible key with:\n" +
            "aws kms create-key --key-spec ECC_SECG_P256K1 --key-usage SIGN_VERIFY"
        );
      }

      // Parse SubjectPublicKeyInfo DER to extract raw public key
      const rawPublicKey = this.extractRawPublicKeyFromSpki(
        new Uint8Array(response.PublicKey)
      );

      this.cachedPublicKey = rawPublicKey;
      return rawPublicKey;
    } catch (error) {
      if (error instanceof Error && error.message.includes("KMS")) {
        throw error;
      }
      throw new Error(
        "Failed to retrieve public key from KMS: " +
          (error instanceof Error ? error.message : String(error))
      );
    }
  }

  /**
   * Sign a digest using KMS.
   */
  private async kmsSign(digest: Uint8Array): Promise<Uint8Array> {
    const client = await this.getKmsClient();

    try {
      const { SignCommand } = await import("@aws-sdk/client-kms");

      const command = new SignCommand({
        KeyId: this.config.keyId,
        Message: digest,
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256",
      });

      const response = (await client.send(command)) as SignResponse;

      if (!response.Signature) {
        throw new Error("KMS Sign returned no signature");
      }

      return new Uint8Array(response.Signature);
    } catch (error) {
      throw new Error(
        "KMS signing failed: " +
          (error instanceof Error ? error.message : String(error))
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private Methods - Cryptographic Utilities
  // -------------------------------------------------------------------------

  /**
   * Extract raw public key from SubjectPublicKeyInfo DER encoding.
   */
  private extractRawPublicKeyFromSpki(spki: Uint8Array): Uint8Array {
    let offset = 0;

    // Skip outer SEQUENCE
    const outerTag = spki[offset];
    if (outerTag !== 0x30) {
      throw new Error("Invalid SPKI: expected SEQUENCE");
    }
    offset++;

    // Skip length bytes
    const lengthByte1 = spki[offset];
    if (lengthByte1 !== undefined && (lengthByte1 & 0x80) !== 0) {
      const lengthBytes = lengthByte1 & 0x7f;
      offset += 1 + lengthBytes;
    } else {
      offset++;
    }

    // Skip algorithm identifier SEQUENCE
    const algTag = spki[offset];
    if (algTag !== 0x30) {
      throw new Error("Invalid SPKI: expected algorithm SEQUENCE");
    }
    offset++;

    const algLength = spki[offset];
    if (algLength === undefined) {
      throw new Error("Invalid SPKI: algorithm length missing");
    }
    offset++;
    offset += algLength;

    // Now we should be at the BIT STRING
    const bitStringTag = spki[offset];
    if (bitStringTag !== 0x03) {
      throw new Error("Invalid SPKI: expected BIT STRING");
    }
    offset++;

    // Get BIT STRING length
    const bitStringLengthByte = spki[offset];
    if (bitStringLengthByte !== undefined && (bitStringLengthByte & 0x80) !== 0) {
      const lengthBytes = bitStringLengthByte & 0x7f;
      offset += 1 + lengthBytes;
    } else {
      offset++;
    }

    // Skip unused bits byte
    const unusedBits = spki[offset];
    if (unusedBits !== 0x00) {
      throw new Error("Invalid SPKI: BIT STRING unused bits should be 0");
    }
    offset++;

    // Extract the raw public key (65 bytes for uncompressed)
    const rawPublicKey = new Uint8Array(spki.buffer, spki.byteOffset + offset, 65);

    if (rawPublicKey.length !== 65 || rawPublicKey[0] !== 0x04) {
      throw new Error(
        "Invalid public key format: expected uncompressed point (65 bytes starting with 0x04)"
      );
    }

    return rawPublicKey;
  }

  /**
   * Parse DER-encoded ECDSA signature.
   */
  private parseDerSignature(der: Uint8Array): {
    r: Uint8Array;
    s: Uint8Array;
  } {
    let offset = 0;

    // SEQUENCE tag
    const seqTag = der[offset];
    if (seqTag !== 0x30) {
      throw new Error("Invalid DER signature: expected SEQUENCE");
    }
    offset++;

    // Skip sequence length
    const seqLengthByte = der[offset];
    if (seqLengthByte !== undefined && (seqLengthByte & 0x80) !== 0) {
      offset += 1 + (seqLengthByte & 0x7f);
    } else {
      offset++;
    }

    // INTEGER r
    const rTag = der[offset];
    if (rTag !== 0x02) {
      throw new Error("Invalid DER signature: expected INTEGER for r");
    }
    offset++;

    const rLength = der[offset];
    if (rLength === undefined) {
      throw new Error("Invalid DER signature: r length missing");
    }
    offset++;

    const rBytes = new Uint8Array(der.buffer, der.byteOffset + offset, rLength);
    offset += rLength;

    // INTEGER s
    const sTag = der[offset];
    if (sTag !== 0x02) {
      throw new Error("Invalid DER signature: expected INTEGER for s");
    }
    offset++;

    const sLength = der[offset];
    if (sLength === undefined) {
      throw new Error("Invalid DER signature: s length missing");
    }
    offset++;

    const sBytes = new Uint8Array(der.buffer, der.byteOffset + offset, sLength);

    // Normalize to 32 bytes
    const r = this.normalizeInteger(rBytes, 32);
    const s = this.normalizeInteger(sBytes, 32);

    return { r, s };
  }

  /**
   * Normalize an ASN.1 INTEGER to fixed length.
   */
  private normalizeInteger(int: Uint8Array, targetLength: number): Uint8Array {
    let start = 0;
    while (start < int.length - 1 && int[start] === 0x00) {
      start++;
    }

    const trimmed = int.slice(start);

    if (trimmed.length > targetLength) {
      throw new Error(
        `Integer too large: ${trimmed.length} > ${targetLength}`
      );
    }

    const result = new Uint8Array(targetLength);
    result.set(trimmed, targetLength - trimmed.length);
    return result;
  }

  /**
   * Normalize S value to lower half of curve order.
   */
  private normalizeS(s: Uint8Array): Uint8Array {
    const sValue = BigInt("0x" + this.bytesToHex(s));

    if (sValue > SECP256K1_HALF_N) {
      const normalizedS = SECP256K1_N - sValue;
      const hexS = normalizedS.toString(16).padStart(64, "0");
      return this.hexToBytes(hexS);
    }

    return s;
  }

  /**
   * SHA-256 hash using Web Crypto API (Node.js compatible).
   */
  private async sha256(data: Uint8Array): Promise<Uint8Array> {
    // Try Node.js crypto first
    try {
      const crypto = await import("crypto");
      const hash = crypto.createHash("sha256");
      hash.update(data);
      return new Uint8Array(hash.digest());
    } catch {
      // Fall back to Web Crypto API
      // Create a new ArrayBuffer copy to satisfy TypeScript strict typing
      const dataBuffer = new ArrayBuffer(data.length);
      new Uint8Array(dataBuffer).set(data);
      const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", dataBuffer);
      return new Uint8Array(hashBuffer);
    }
  }

  /**
   * Convert bytes to hex string.
   */
  private bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * Convert hex string to bytes.
   */
  private hexToBytes(hex: string): Uint8Array {
    const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
    const bytes = new Uint8Array(cleanHex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
}
