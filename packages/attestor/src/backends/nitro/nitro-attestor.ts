/**
 * AWS Nitro Enclaves Attestor.
 * Provides attestation using AWS Nitro Enclaves.
 */

import type { Attestor } from "../../attestor-interface.js";
import type {
  AttestationBundle,
  Measurements,
  NitroAttestorConfig,
  NitroAttestation,
} from "../../types.js";
import { AttestorError, AttestorException } from "../../types.js";
import { AttestationBundleBuilder } from "../../attestation-bundle.js";

/**
 * AWS Nitro Enclaves attestor implementation.
 *
 * Nitro Enclaves use the Nitro Security Module (NSM) to generate
 * attestation documents that are cryptographically signed by AWS.
 */
export class NitroAttestor implements Attestor {
  readonly teeType = "nitro" as const;
  readonly attestorId: string;

  private config: NitroAttestorConfig;
  private isInEnclave: boolean | null = null;

  constructor(config: NitroAttestorConfig) {
    this.config = config;
    this.attestorId = config.attestorId;
  }

  /**
   * Generate an attestation binding a hash value.
   */
  async attest(
    hashToSign: string,
    hashType: "rootHash" | "manifestHash" | "merkleRoot"
  ): Promise<AttestationBundle> {
    if (!this.isAttested()) {
      throw new AttestorException(
        AttestorError.NOT_IN_TEE,
        "Not running in a Nitro Enclave environment"
      );
    }

    const nonce = this.generateNonce();

    // Get attestation document from NSM
    const attestationDoc = await this.getAttestationDocument(hashToSign, nonce);

    // Parse the attestation document to extract PCRs
    const pcrs = this.extractPcrs(attestationDoc);

    // Build the attestation bundle
    const builder = new AttestationBundleBuilder();

    const bundle = builder
      .setTee("nitro", "1.0")
      .setInlineEvidence(attestationDoc, "base64")
      .setBinding(hashToSign, hashType, nonce)
      .setAttestor(this.attestorId)
      .setVerifierPolicy({
        expectedMeasurements: undefined,
        allowedSignerKeys: undefined,
        minFirmwareVersion: undefined,
        minSvn: undefined,
        checkRevocation: undefined,
        revocationListUri: undefined,
      })
      .build();

    // Add Nitro-specific fields
    const nitroAttestation: NitroAttestation = {
      ...bundle,
      teeType: "nitro",
      nitro: {
        attestationDocument: attestationDoc,
        pcrs,
        userData: hashToSign,
        nonce,
        publicKey: await this.getPublicKey(),
        certificate: "", // Extracted from attestation document
      },
    };

    return nitroAttestation;
  }

  /**
   * Get the current measurements from the enclave.
   */
  async getMeasurements(): Promise<Measurements> {
    if (!this.isAttested()) {
      throw new AttestorException(
        AttestorError.NOT_IN_TEE,
        "Not running in a Nitro Enclave environment"
      );
    }

    // Get a basic attestation to extract measurements
    const attestationDoc = await this.getAttestationDocument("measurement-query", "");
    const pcrs = this.extractPcrs(attestationDoc);

    return {
      firmwareVersion: undefined,
      sevSnp: undefined,
      tdx: undefined,
      sgx: undefined,
      nitro: {
        pcrs,
        moduleId: this.attestorId,
      },
    };
  }

  /**
   * Check if running in a Nitro Enclave.
   */
  isAttested(): boolean {
    if (this.isInEnclave !== null) {
      return this.isInEnclave;
    }

    // Check for vsock device which is only available in Nitro Enclaves
    try {
      // In a real implementation, we'd check for /dev/vsock
      // For now, check environment variable or mock
      this.isInEnclave = process.env.AWS_NITRO_ENCLAVE === "1" ||
        typeof process.env.NSM_PATH !== "undefined";
    } catch {
      this.isInEnclave = false;
    }

    return this.isInEnclave;
  }

  /**
   * Get the enclave's public key.
   */
  async getPublicKey(): Promise<string | undefined> {
    // In a real implementation, this would get the key from KMS
    // that is sealed to this enclave
    if (this.config.kmsKeyId) {
      return this.getKmsPublicKey();
    }
    return undefined;
  }

  // === Private Methods ===

  /**
   * Generate a random nonce for freshness.
   */
  private generateNonce(): string {
    const bytes = new Uint8Array(32);
    if (typeof globalThis.crypto !== "undefined") {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      // Fallback for Node.js
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * Get attestation document from NSM.
   *
   * In a real implementation, this would communicate with the
   * Nitro Security Module via vsock to get a signed attestation document.
   */
  private async getAttestationDocument(
    userData: string,
    nonce: string
  ): Promise<string> {
    // This is a mock implementation
    // Real implementation would use the NSM API via vsock

    if (!this.isAttested()) {
      throw new AttestorException(
        AttestorError.NITRO_NSM_FAILED,
        "NSM not available - not in enclave"
      );
    }

    // Mock attestation document structure
    // Real attestation documents are CBOR-encoded and COSE-signed
    const mockDoc = {
      module_id: this.attestorId,
      timestamp: Date.now(),
      user_data: Buffer.from(userData).toString("base64"),
      nonce: nonce,
      pcrs: this.getMockPcrs(),
      // In real implementation:
      // - cabundle: Certificate chain to AWS root
      // - signature: ECDSA signature over the document
    };

    return Buffer.from(JSON.stringify(mockDoc)).toString("base64");
  }

  /**
   * Extract PCR values from an attestation document.
   */
  private extractPcrs(attestationDoc: string): Record<number, string> {
    try {
      const decoded = JSON.parse(
        Buffer.from(attestationDoc, "base64").toString("utf-8")
      ) as { pcrs?: Record<string, string> };

      if (!decoded.pcrs) {
        return this.getMockPcrs();
      }

      // Convert string keys to numbers
      const pcrs: Record<number, string> = {};
      for (const [key, value] of Object.entries(decoded.pcrs)) {
        pcrs[parseInt(key, 10)] = value;
      }
      return pcrs;
    } catch {
      return this.getMockPcrs();
    }
  }

  /**
   * Get mock PCR values for testing.
   */
  private getMockPcrs(): Record<number, string> {
    // PCR values are SHA-384 hashes (96 hex chars)
    const mockHash = "0".repeat(96);
    const includePcrs = this.config.includePcrs ?? [0, 1, 2, 8];

    const pcrs: Record<number, string> = {};
    for (const pcr of includePcrs) {
      pcrs[pcr] = mockHash;
    }
    return pcrs;
  }

  /**
   * Get public key from KMS (sealed to this enclave).
   */
  private async getKmsPublicKey(): Promise<string | undefined> {
    // In a real implementation, this would use AWS SDK to
    // call KMS with attestation-based authorization
    //
    // The enclave would:
    // 1. Get attestation document
    // 2. Send to KMS with the document
    // 3. KMS validates the attestation
    // 4. If valid, returns the key

    if (!this.config.kmsKeyId) {
      return undefined;
    }

    this.debug(`Would fetch public key from KMS: ${this.config.kmsKeyId}`);

    // Return mock public key
    return undefined;
  }

  private debug(message: string): void {
    if (this.config.debug) {
      console.log(`[NitroAttestor] ${message}`);
    }
  }
}

/**
 * Create a Nitro attestor with default configuration.
 */
export function createNitroAttestor(
  attestorId: string,
  options?: Partial<NitroAttestorConfig>
): NitroAttestor {
  return new NitroAttestor({
    attestorId,
    keyConfig: undefined,
    debug: options?.debug,
    kmsKeyId: options?.kmsKeyId,
    kmsRegion: options?.kmsRegion,
    sealingPolicy: options?.sealingPolicy ?? "signer",
    includePcrs: options?.includePcrs,
  });
}
