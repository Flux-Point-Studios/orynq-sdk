/**
 * @summary AWS KMS signer for production server-side EVM direct transfers.
 *
 * This signer uses AWS Key Management Service (KMS) to securely manage private
 * keys and perform ECDSA signing operations. Keys never leave the KMS hardware
 * security modules (HSMs), providing enterprise-grade security.
 *
 * AWS KMS supports secp256k1 (ECC_SECG_P256K1) which is the curve used by
 * Ethereum and all EVM-compatible chains.
 *
 * Used by:
 * - Production server deployments requiring HSM-backed key security
 * - Multi-tenant payment processing systems
 * - High-value direct ERC-20 transfers
 *
 * Requires:
 * - @aws-sdk/client-kms for AWS KMS integration
 *
 * IAM Permissions Required:
 * - kms:Sign - Sign data with the KMS key
 * - kms:GetPublicKey - Retrieve the public key for address derivation
 * - kms:DescribeKey - (Optional) Verify key configuration
 *
 * Note: This file re-exports the full KMS signer implementation from
 * a shared location to avoid code duplication between payer-evm-direct
 * and payer-evm-x402.
 */

import type { Signer, ChainId } from "@fluxpointstudios/orynq-sdk-core";

// ---------------------------------------------------------------------------
// Type Declarations for Optional AWS SDK
// ---------------------------------------------------------------------------

interface KMSClientLike {
  send(command: unknown): Promise<unknown>;
}

interface GetPublicKeyResponse {
  PublicKey?: Uint8Array;
  KeySpec?: string;
  KeyUsage?: string;
}

interface SignResponse {
  Signature?: Uint8Array;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration options for EvmKmsSigner.
 */
export interface EvmKmsSignerConfig {
  /**
   * AWS KMS Key ID, Key ARN, or Key Alias.
   *
   * The key must be:
   * - An asymmetric key for signing/verification
   * - Key spec: ECC_SECG_P256K1 (secp256k1 curve)
   * - Key usage: SIGN_VERIFY
   *
   * @example Key ID: "1234abcd-12ab-34cd-56ef-1234567890ab"
   * @example Key ARN: "arn:aws:kms:us-east-1:123456789012:key/1234abcd-..."
   * @example Alias: "alias/my-eth-key"
   */
  keyId: string;

  /**
   * AWS region for the KMS key.
   *
   * @default Process environment AWS_REGION or AWS_DEFAULT_REGION
   */
  region?: string;

  /**
   * Optional endpoint URL for KMS.
   * Useful for local testing with LocalStack.
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
   * Optional AWS profile to use from shared credentials.
   */
  profile?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SECP256K1_N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"
);

const SECP256K1_HALF_N = SECP256K1_N / BigInt(2);

// ---------------------------------------------------------------------------
// EvmKmsSigner Implementation
// ---------------------------------------------------------------------------

/**
 * AWS KMS Signer for production EVM direct transfers.
 *
 * This signer provides HSM-backed key management for Ethereum and EVM-compatible
 * chains. Private keys never leave the secure hardware boundary of AWS KMS.
 *
 * Features:
 * - secp256k1 ECDSA signing via AWS KMS
 * - Automatic DER signature parsing and normalization
 * - EIP-2 low-S signature values
 * - Recovery parameter (v) calculation
 * - EIP-191 personal_sign support
 * - Lazy KMS client initialization
 * - Public key and address caching
 *
 * Create a suitable KMS key:
 * ```bash
 * aws kms create-key \
 *   --key-spec ECC_SECG_P256K1 \
 *   --key-usage SIGN_VERIFY \
 *   --description "Ethereum signing key for direct transfers"
 * ```
 *
 * @example
 * ```typescript
 * import { EvmKmsSigner } from "@fluxpointstudios/orynq-sdk-payer-evm-direct/signers";
 *
 * const signer = new EvmKmsSigner({
 *   keyId: "alias/my-eth-key",
 *   region: "us-east-1",
 * });
 *
 * const address = await signer.getAddress("eip155:1");
 * console.log("Address:", address);
 * ```
 */
export class EvmKmsSigner implements Signer {
  private readonly config: EvmKmsSignerConfig;
  private kmsClient: KMSClientLike | null = null;
  private cachedPublicKey: Uint8Array | null = null;
  private cachedAddress: string | null = null;

  /**
   * Create a new EvmKmsSigner instance.
   *
   * @param config - KMS configuration with keyId and optional region/credentials
   * @throws Error if keyId is not provided or is empty
   */
  constructor(config: EvmKmsSignerConfig) {
    if (!config.keyId || config.keyId.trim() === "") {
      throw new Error("EvmKmsSigner requires a keyId");
    }
    this.config = config;
  }

  /**
   * Get the signing address for a specific chain.
   *
   * @param _chain - CAIP-2 chain identifier (unused, same address for all EVM chains)
   * @returns Promise resolving to the checksummed Ethereum address
   */
  async getAddress(_chain: ChainId): Promise<string> {
    if (this.cachedAddress) {
      return this.cachedAddress;
    }

    const publicKey = await this.getPublicKey();
    this.cachedAddress = this.publicKeyToAddress(publicKey);
    return this.cachedAddress;
  }

  /**
   * Sign arbitrary binary data.
   *
   * @param payload - Data to sign as Uint8Array
   * @param chain - CAIP-2 chain identifier
   * @returns Promise resolving to 65-byte signature (r, s, v)
   */
  async sign(payload: Uint8Array, chain: ChainId): Promise<Uint8Array> {
    if (payload.length === 0) {
      throw new Error("Cannot sign empty payload");
    }

    const digest = this.keccak256(payload);
    const derSignature = await this.kmsSign(digest);
    const { r, s } = this.parseDerSignature(derSignature);
    const normalizedS = this.normalizeS(s);
    const expectedAddress = await this.getAddress(chain);
    const v = await this.recoverV(digest, r, normalizedS, expectedAddress);

    const signature = new Uint8Array(65);
    signature.set(r, 0);
    signature.set(normalizedS, 32);
    signature[64] = v;

    return signature;
  }

  /**
   * Sign a human-readable message (EIP-191 style).
   *
   * @param message - UTF-8 string message to sign
   * @param chain - CAIP-2 chain identifier
   * @returns Promise resolving to the signature as 0x-prefixed hex string
   */
  async signMessage(message: string, chain: ChainId): Promise<string> {
    const prefix = `\x19Ethereum Signed Message:\n${message.length}`;
    const prefixedMessage = new TextEncoder().encode(prefix + message);
    const signature = await this.sign(prefixedMessage, chain);
    return "0x" + this.bytesToHex(signature);
  }

  /**
   * Get the KMS Key ID.
   */
  getKeyId(): string {
    return this.config.keyId;
  }

  /**
   * Get the AWS region.
   */
  getRegion(): string | undefined {
    return this.config.region;
  }

  // -------------------------------------------------------------------------
  // Private Methods
  // -------------------------------------------------------------------------

  private async getKmsClient(): Promise<KMSClientLike> {
    if (this.kmsClient) {
      return this.kmsClient;
    }

    try {
      const { KMSClient } = await import("@aws-sdk/client-kms");
      const clientConfig: Record<string, unknown> = {};

      if (this.config.region) clientConfig.region = this.config.region;
      if (this.config.endpoint) clientConfig.endpoint = this.config.endpoint;
      if (this.config.credentials) clientConfig.credentials = this.config.credentials;

      this.kmsClient = new KMSClient(clientConfig) as KMSClientLike;
      return this.kmsClient;
    } catch (error) {
      throw new Error(
        "EvmKmsSigner requires @aws-sdk/client-kms.\n" +
          "Install it with: pnpm add @aws-sdk/client-kms\n" +
          "Original error: " +
          (error instanceof Error ? error.message : String(error))
      );
    }
  }

  private async getPublicKey(): Promise<Uint8Array> {
    if (this.cachedPublicKey) {
      return this.cachedPublicKey;
    }

    const client = await this.getKmsClient();
    const { GetPublicKeyCommand } = await import("@aws-sdk/client-kms");

    const response = (await client.send(
      new GetPublicKeyCommand({ KeyId: this.config.keyId })
    )) as GetPublicKeyResponse;

    if (!response.PublicKey) {
      throw new Error("KMS GetPublicKey returned no public key");
    }

    if (response.KeySpec && response.KeySpec !== "ECC_SECG_P256K1") {
      throw new Error(
        `Invalid KMS key spec: ${response.KeySpec}. EvmKmsSigner requires ECC_SECG_P256K1.`
      );
    }

    const rawPublicKey = this.extractRawPublicKeyFromSpki(
      new Uint8Array(response.PublicKey)
    );

    this.cachedPublicKey = rawPublicKey;
    return rawPublicKey;
  }

  private async kmsSign(digest: Uint8Array): Promise<Uint8Array> {
    const client = await this.getKmsClient();
    const { SignCommand } = await import("@aws-sdk/client-kms");

    const response = (await client.send(
      new SignCommand({
        KeyId: this.config.keyId,
        Message: digest,
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256",
      })
    )) as SignResponse;

    if (!response.Signature) {
      throw new Error("KMS Sign returned no signature");
    }

    return new Uint8Array(response.Signature);
  }

  private extractRawPublicKeyFromSpki(spki: Uint8Array): Uint8Array {
    let offset = 0;

    const seqTag = spki[offset];
    if (seqTag !== 0x30) throw new Error("Invalid SPKI: expected SEQUENCE");
    offset++;

    const lengthByte1 = spki[offset];
    if (lengthByte1 !== undefined && (lengthByte1 & 0x80) !== 0) {
      offset += 1 + (lengthByte1 & 0x7f);
    } else {
      offset++;
    }

    const algSeqTag = spki[offset];
    if (algSeqTag !== 0x30) throw new Error("Invalid SPKI: expected algorithm SEQUENCE");
    offset++;

    const algLength = spki[offset];
    if (algLength === undefined) throw new Error("Invalid SPKI: missing algorithm length");
    offset++;
    offset += algLength;

    const bitStringTag = spki[offset];
    if (bitStringTag !== 0x03) throw new Error("Invalid SPKI: expected BIT STRING");
    offset++;

    const bitStringLengthByte = spki[offset];
    if (bitStringLengthByte !== undefined && (bitStringLengthByte & 0x80) !== 0) {
      offset += 1 + (bitStringLengthByte & 0x7f);
    } else {
      offset++;
    }

    const unusedBits = spki[offset];
    if (unusedBits !== 0x00) throw new Error("Invalid SPKI: BIT STRING unused bits should be 0");
    offset++;

    const rawPublicKey = new Uint8Array(spki.buffer, spki.byteOffset + offset, 65);

    if (rawPublicKey.length !== 65 || rawPublicKey[0] !== 0x04) {
      throw new Error("Invalid public key format");
    }

    return rawPublicKey;
  }

  private publicKeyToAddress(publicKey: Uint8Array): string {
    const keyWithoutPrefix = publicKey.slice(1);
    const hash = this.keccak256(keyWithoutPrefix);
    const addressBytes = hash.slice(-20);
    const address = this.bytesToHex(addressBytes);
    return this.toChecksumAddress("0x" + address);
  }

  private parseDerSignature(der: Uint8Array): { r: Uint8Array; s: Uint8Array } {
    let offset = 0;

    const seqTag = der[offset];
    if (seqTag !== 0x30) throw new Error("Invalid DER signature: expected SEQUENCE");
    offset++;

    const seqLengthByte = der[offset];
    if (seqLengthByte !== undefined && (seqLengthByte & 0x80) !== 0) {
      offset += 1 + (seqLengthByte & 0x7f);
    } else {
      offset++;
    }

    const rTag = der[offset];
    if (rTag !== 0x02) throw new Error("Invalid DER signature: expected INTEGER for r");
    offset++;

    const rLength = der[offset];
    if (rLength === undefined) throw new Error("Invalid DER signature: r length missing");
    offset++;

    const rBytes = new Uint8Array(der.buffer, der.byteOffset + offset, rLength);
    offset += rLength;

    const sTag = der[offset];
    if (sTag !== 0x02) throw new Error("Invalid DER signature: expected INTEGER for s");
    offset++;

    const sLength = der[offset];
    if (sLength === undefined) throw new Error("Invalid DER signature: s length missing");
    offset++;

    const sBytes = new Uint8Array(der.buffer, der.byteOffset + offset, sLength);

    const r = this.normalizeInteger(rBytes, 32);
    const s = this.normalizeInteger(sBytes, 32);

    return { r, s };
  }

  private normalizeInteger(int: Uint8Array, targetLength: number): Uint8Array {
    let start = 0;
    while (start < int.length - 1 && int[start] === 0x00) {
      start++;
    }

    const trimmed = int.slice(start);

    if (trimmed.length > targetLength) {
      throw new Error(`Integer too large: ${trimmed.length} > ${targetLength}`);
    }

    const result = new Uint8Array(targetLength);
    result.set(trimmed, targetLength - trimmed.length);
    return result;
  }

  private normalizeS(s: Uint8Array): Uint8Array {
    const sValue = BigInt("0x" + this.bytesToHex(s));

    if (sValue > SECP256K1_HALF_N) {
      const normalizedS = SECP256K1_N - sValue;
      const hexS = normalizedS.toString(16).padStart(64, "0");
      return this.hexToBytes(hexS);
    }

    return s;
  }

  private async recoverV(
    digest: Uint8Array,
    r: Uint8Array,
    s: Uint8Array,
    expectedAddress: string
  ): Promise<number> {
    for (const v of [27, 28]) {
      try {
        const recoveredAddress = this.ecRecover(digest, r, s, v);
        if (recoveredAddress.toLowerCase() === expectedAddress.toLowerCase()) {
          return v;
        }
      } catch {
        continue;
      }
    }

    throw new Error("Failed to recover v value");
  }

  private ecRecover(
    digest: Uint8Array,
    r: Uint8Array,
    s: Uint8Array,
    v: number
  ): string {
    const recovery = v - 27;

    const p = BigInt(
      "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F"
    );
    const a = BigInt(0);
    const b = BigInt(7);
    const gx = BigInt(
      "0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798"
    );
    const gy = BigInt(
      "0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8"
    );
    const n = SECP256K1_N;

    const rInt = BigInt("0x" + this.bytesToHex(r));
    const sInt = BigInt("0x" + this.bytesToHex(s));
    const e = BigInt("0x" + this.bytesToHex(digest));

    const x = rInt + BigInt(recovery >> 1) * n;
    if (x >= p) throw new Error("Invalid x coordinate");

    const ySquared = (this.modPow(x, BigInt(3), p) + b) % p;
    let y = this.modPow(ySquared, (p + BigInt(1)) / BigInt(4), p);

    if ((y % BigInt(2) === BigInt(0)) !== ((recovery & 1) === 0)) {
      y = p - y;
    }

    const rInv = this.modInverse(rInt, n);
    const sR = this.pointMultiply({ x, y }, sInt, p, a, n);
    const eG = this.pointMultiply({ x: gx, y: gy }, e, p, a, n);
    const negEG = { x: eG.x, y: (p - eG.y) % p };
    const diff = this.pointAdd(sR, negEG, p, a);
    const Q = this.pointMultiply(diff, rInv, p, a, n);

    const pubKeyX = Q.x.toString(16).padStart(64, "0");
    const pubKeyY = Q.y.toString(16).padStart(64, "0");
    const pubKeyBytes = this.hexToBytes(pubKeyX + pubKeyY);
    const hash = this.keccak256(pubKeyBytes);
    const address = "0x" + this.bytesToHex(hash.slice(-20));

    return this.toChecksumAddress(address);
  }

  private modPow(base: bigint, exp: bigint, mod: bigint): bigint {
    let result = BigInt(1);
    base = base % mod;
    while (exp > BigInt(0)) {
      if (exp % BigInt(2) === BigInt(1)) {
        result = (result * base) % mod;
      }
      exp = exp / BigInt(2);
      base = (base * base) % mod;
    }
    return result;
  }

  private modInverse(a: bigint, m: bigint): bigint {
    let [old_r, r] = [a, m];
    let [old_s, s] = [BigInt(1), BigInt(0)];

    while (r !== BigInt(0)) {
      const quotient = old_r / r;
      [old_r, r] = [r, old_r - quotient * r];
      [old_s, s] = [s, old_s - quotient * s];
    }

    return ((old_s % m) + m) % m;
  }

  private pointAdd(
    p1: { x: bigint; y: bigint },
    p2: { x: bigint; y: bigint },
    p: bigint,
    _a: bigint
  ): { x: bigint; y: bigint } {
    if (p1.x === BigInt(0) && p1.y === BigInt(0)) return p2;
    if (p2.x === BigInt(0) && p2.y === BigInt(0)) return p1;

    let lambda: bigint;
    if (p1.x === p2.x && p1.y === p2.y) {
      lambda =
        ((BigInt(3) * p1.x * p1.x) * this.modInverse(BigInt(2) * p1.y, p)) % p;
    } else {
      lambda = ((p2.y - p1.y) * this.modInverse(((p2.x - p1.x) % p + p) % p, p)) % p;
    }

    lambda = ((lambda % p) + p) % p;

    const x3 = ((lambda * lambda - p1.x - p2.x) % p + p) % p;
    const y3 = ((lambda * (p1.x - x3) - p1.y) % p + p) % p;

    return { x: x3, y: y3 };
  }

  private pointMultiply(
    point: { x: bigint; y: bigint },
    scalar: bigint,
    p: bigint,
    a: bigint,
    _n: bigint
  ): { x: bigint; y: bigint } {
    let result = { x: BigInt(0), y: BigInt(0) };
    let addend = { ...point };

    while (scalar > BigInt(0)) {
      if (scalar % BigInt(2) === BigInt(1)) {
        result = this.pointAdd(result, addend, p, a);
      }
      addend = this.pointAdd(addend, addend, p, a);
      scalar = scalar / BigInt(2);
    }

    return result;
  }

  private keccak256(data: Uint8Array): Uint8Array {
    const RC = [
      BigInt("0x0000000000000001"), BigInt("0x0000000000008082"),
      BigInt("0x800000000000808a"), BigInt("0x8000000080008000"),
      BigInt("0x000000000000808b"), BigInt("0x0000000080000001"),
      BigInt("0x8000000080008081"), BigInt("0x8000000000008009"),
      BigInt("0x000000000000008a"), BigInt("0x0000000000000088"),
      BigInt("0x0000000080008009"), BigInt("0x000000008000000a"),
      BigInt("0x000000008000808b"), BigInt("0x800000000000008b"),
      BigInt("0x8000000000008089"), BigInt("0x8000000000008003"),
      BigInt("0x8000000000008002"), BigInt("0x8000000000000080"),
      BigInt("0x000000000000800a"), BigInt("0x800000008000000a"),
      BigInt("0x8000000080008081"), BigInt("0x8000000000008080"),
      BigInt("0x0000000080000001"), BigInt("0x8000000080008008"),
    ];

    const ROTC = [
      1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18,
      39, 61, 20, 44,
    ];

    const PIL = [
      10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14,
      22, 9, 6, 1,
    ];

    const rate = 136;
    const outputLen = 32;

    const paddedLen = Math.ceil((data.length + 1) / rate) * rate;
    const padded = new Uint8Array(paddedLen);
    padded.set(data);
    padded[data.length] = 0x01;
    const lastIndex = paddedLen - 1;
    padded[lastIndex] = (padded[lastIndex] ?? 0) | 0x80;

    const state: bigint[] = new Array(25).fill(BigInt(0));

    for (let offset = 0; offset < paddedLen; offset += rate) {
      for (let i = 0; i < rate / 8; i++) {
        const idx = offset + i * 8;
        let lane = BigInt(0);
        for (let j = 0; j < 8; j++) {
          const byte = padded[idx + j];
          if (byte !== undefined) {
            lane |= BigInt(byte) << BigInt(j * 8);
          }
        }
        state[i] = (state[i] ?? BigInt(0)) ^ lane;
      }

      for (let round = 0; round < 24; round++) {
        const C: bigint[] = new Array(5).fill(BigInt(0));
        for (let x = 0; x < 5; x++) {
          C[x] =
            (state[x] ?? BigInt(0)) ^
            (state[x + 5] ?? BigInt(0)) ^
            (state[x + 10] ?? BigInt(0)) ^
            (state[x + 15] ?? BigInt(0)) ^
            (state[x + 20] ?? BigInt(0));
        }

        const D: bigint[] = new Array(5).fill(BigInt(0));
        for (let x = 0; x < 5; x++) {
          D[x] =
            (C[(x + 4) % 5] ?? BigInt(0)) ^
            this.rotl64(C[(x + 1) % 5] ?? BigInt(0), BigInt(1));
        }

        for (let i = 0; i < 25; i++) {
          state[i] = (state[i] ?? BigInt(0)) ^ (D[i % 5] ?? BigInt(0));
        }

        let current = state[1] ?? BigInt(0);
        for (let i = 0; i < 24; i++) {
          const j = PIL[i];
          if (j !== undefined) {
            const temp = state[j] ?? BigInt(0);
            const rotAmount = ROTC[i];
            state[j] = this.rotl64(current, BigInt(rotAmount ?? 0));
            current = temp;
          }
        }

        for (let y = 0; y < 5; y++) {
          const row = [
            state[y * 5] ?? BigInt(0),
            state[y * 5 + 1] ?? BigInt(0),
            state[y * 5 + 2] ?? BigInt(0),
            state[y * 5 + 3] ?? BigInt(0),
            state[y * 5 + 4] ?? BigInt(0),
          ];
          for (let x = 0; x < 5; x++) {
            state[y * 5 + x] =
              (row[x] ?? BigInt(0)) ^ (~(row[(x + 1) % 5] ?? BigInt(0)) & (row[(x + 2) % 5] ?? BigInt(0)));
          }
        }

        state[0] = (state[0] ?? BigInt(0)) ^ (RC[round] ?? BigInt(0));
      }
    }

    const output = new Uint8Array(outputLen);
    for (let i = 0; i < outputLen / 8; i++) {
      const lane = state[i] ?? BigInt(0);
      for (let j = 0; j < 8; j++) {
        output[i * 8 + j] = Number((lane >> BigInt(j * 8)) & BigInt(0xff));
      }
    }

    return output;
  }

  private rotl64(x: bigint, n: bigint): bigint {
    const mask = BigInt("0xFFFFFFFFFFFFFFFF");
    n = n % BigInt(64);
    return ((x << n) | (x >> (BigInt(64) - n))) & mask;
  }

  private bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private hexToBytes(hex: string): Uint8Array {
    const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
    const bytes = new Uint8Array(cleanHex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  private toChecksumAddress(address: string): string {
    const addr = address.toLowerCase().replace("0x", "");
    const hash = this.keccak256(new TextEncoder().encode(addr));
    const hashHex = this.bytesToHex(hash);

    let checksummed = "0x";
    for (let i = 0; i < addr.length; i++) {
      const char = addr[i] ?? "";
      const hashChar = hashHex[i] ?? "0";
      const hashNibble = parseInt(hashChar, 16);
      checksummed += hashNibble >= 8 ? char.toUpperCase() : char;
    }

    return checksummed;
  }
}

// Legacy exports for backward compatibility
export { EvmKmsSigner as KmsSigner };
export type { EvmKmsSignerConfig as KmsSignerConfig };
