/**
 * Abstract Attestor Interface.
 * Defines the contract for TEE attestation backends.
 */

import type {
  TeeType,
  AttestationBundle,
  Measurements,
  AttestorConfig,
} from "./types.js";

/**
 * Abstract interface for TEE attestors.
 * Each TEE backend (Nitro, SEV-SNP, TDX, SGX) implements this interface.
 */
export interface Attestor {
  /** The type of TEE this attestor supports */
  readonly teeType: TeeType;

  /** The attestor's unique identifier */
  readonly attestorId: string;

  /**
   * Generate an attestation binding a hash value.
   * The hash is typically a rootHash, manifestHash, or merkleRoot.
   *
   * @param hashToSign - The hash value to bind to the attestation
   * @param hashType - The type of hash being bound
   * @returns An attestation bundle containing the evidence
   */
  attest(
    hashToSign: string,
    hashType: "rootHash" | "manifestHash" | "merkleRoot"
  ): Promise<AttestationBundle>;

  /**
   * Get the current measurements from the TEE.
   * These can be used for policy verification.
   */
  getMeasurements(): Promise<Measurements>;

  /**
   * Check if the current environment is an attested TEE.
   */
  isAttested(): boolean;

  /**
   * Get the attestor's public key (if available).
   * This key is bound to the TEE and can be used for key wrapping.
   */
  getPublicKey(): Promise<string | undefined>;
}

/**
 * Factory function type for creating attestors.
 */
export type AttestorFactory = (config: AttestorConfig) => Attestor;

/**
 * Registry of available attestor backends.
 */
export interface AttestorRegistry {
  /**
   * Register an attestor factory for a TEE type.
   */
  register(teeType: TeeType, factory: AttestorFactory): void;

  /**
   * Get an attestor for a TEE type.
   */
  get(teeType: TeeType, config: AttestorConfig): Attestor | undefined;

  /**
   * List available TEE types.
   */
  availableTypes(): TeeType[];

  /**
   * Detect the current TEE environment.
   */
  detectEnvironment(): Promise<TeeType | undefined>;
}

/**
 * Default attestor registry implementation.
 */
export class DefaultAttestorRegistry implements AttestorRegistry {
  private factories = new Map<TeeType, AttestorFactory>();

  register(teeType: TeeType, factory: AttestorFactory): void {
    this.factories.set(teeType, factory);
  }

  get(teeType: TeeType, config: AttestorConfig): Attestor | undefined {
    const factory = this.factories.get(teeType);
    if (!factory) {
      return undefined;
    }
    return factory(config);
  }

  availableTypes(): TeeType[] {
    return Array.from(this.factories.keys());
  }

  async detectEnvironment(): Promise<TeeType | undefined> {
    // Check for Nitro (AWS)
    if (await this.isNitroEnvironment()) {
      return "nitro";
    }

    // Check for SEV-SNP (AMD)
    if (await this.isSevSnpEnvironment()) {
      return "sev-snp";
    }

    // Check for TDX (Intel)
    if (await this.isTdxEnvironment()) {
      return "tdx";
    }

    // Check for SGX (Intel)
    if (await this.isSgxEnvironment()) {
      return "sgx";
    }

    return undefined;
  }

  private async isNitroEnvironment(): Promise<boolean> {
    // Check for vsock device (Nitro Enclaves use vsock)
    try {
      const fs = await import("node:fs/promises");
      await fs.access("/dev/vsock");
      return true;
    } catch {
      return false;
    }
  }

  private async isSevSnpEnvironment(): Promise<boolean> {
    // Check for SEV device
    try {
      const fs = await import("node:fs/promises");
      await fs.access("/dev/sev-guest");
      return true;
    } catch {
      return false;
    }
  }

  private async isTdxEnvironment(): Promise<boolean> {
    // Check for TDX device
    try {
      const fs = await import("node:fs/promises");
      await fs.access("/dev/tdx-guest");
      return true;
    } catch {
      return false;
    }
  }

  private async isSgxEnvironment(): Promise<boolean> {
    // Check for SGX device
    try {
      const fs = await import("node:fs/promises");
      await fs.access("/dev/sgx_enclave");
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Global attestor registry instance.
 */
export const attestorRegistry = new DefaultAttestorRegistry();
