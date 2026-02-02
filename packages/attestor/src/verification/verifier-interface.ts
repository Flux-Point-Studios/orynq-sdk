/**
 * Attestation Verifier Interface.
 * Defines the contract for verifying attestation bundles.
 */

import type {
  TeeType,
  AttestationBundle,
  VerificationResult,
  VerifierPolicy,
  Measurements,
} from "../types.js";

/**
 * Interface for attestation verifiers.
 * Each TEE type has its own verifier implementation.
 */
export interface AttestationVerifier {
  /** The TEE type this verifier supports */
  readonly teeType: TeeType;

  /**
   * Verify an attestation bundle.
   *
   * @param bundle - The attestation bundle to verify
   * @param policy - Optional policy to verify against (overrides bundle policy)
   * @returns Verification result with detailed checks
   */
  verify(bundle: AttestationBundle, policy?: VerifierPolicy): Promise<VerificationResult>;

  /**
   * Extract measurements from a bundle.
   */
  extractMeasurements(bundle: AttestationBundle): Promise<Measurements>;

  /**
   * Verify the hash binding in the attestation.
   */
  verifyBinding(bundle: AttestationBundle, expectedHash: string): Promise<boolean>;
}

/**
 * Factory function type for creating verifiers.
 */
export type VerifierFactory = () => AttestationVerifier;

/**
 * Registry of available verifiers.
 */
export class VerifierRegistry {
  private verifiers = new Map<TeeType, VerifierFactory>();

  /**
   * Register a verifier factory for a TEE type.
   */
  register(teeType: TeeType, factory: VerifierFactory): void {
    this.verifiers.set(teeType, factory);
  }

  /**
   * Get a verifier for a TEE type.
   */
  get(teeType: TeeType): AttestationVerifier | undefined {
    const factory = this.verifiers.get(teeType);
    if (!factory) {
      return undefined;
    }
    return factory();
  }

  /**
   * Get a verifier for a bundle.
   */
  getForBundle(bundle: AttestationBundle): AttestationVerifier | undefined {
    return this.get(bundle.teeType);
  }

  /**
   * List available verifier types.
   */
  availableTypes(): TeeType[] {
    return Array.from(this.verifiers.keys());
  }
}

/**
 * Global verifier registry instance.
 */
export const verifierRegistry = new VerifierRegistry();

/**
 * Convenience function to verify a bundle using the appropriate verifier.
 */
export async function verifyBundle(
  bundle: AttestationBundle,
  policy?: VerifierPolicy
): Promise<VerificationResult> {
  const verifier = verifierRegistry.getForBundle(bundle);

  if (!verifier) {
    return {
      valid: false,
      teeType: bundle.teeType,
      checks: {
        signatureValid: false,
        measurementsMatch: false,
        certChainValid: false,
        notRevoked: false,
        hashBindingValid: false,
      },
      warnings: [],
      errors: [`No verifier available for TEE type: ${bundle.teeType}`],
      measurements: undefined,
    };
  }

  return verifier.verify(bundle, policy);
}
