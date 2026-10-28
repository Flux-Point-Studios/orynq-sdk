/**
 * AMD SEV-SNP Verifier.
 * Fails closed until SNP signature and VCEK-chain verification is available.
 */

import type { AttestationVerifier } from "../../verification/verifier-interface.js";
import type {
  AttestationBundle,
  VerificationResult,
  VerifierPolicy,
  Measurements,
  SevSnpAttestation,
} from "../../types.js";
import { verificationUnavailable } from "../../verification/verifier-interface.js";

/**
 * Verifier for AMD SEV-SNP attestations.
 */
export class SevSnpVerifier implements AttestationVerifier {
  readonly teeType = "sev-snp" as const;

  /**
   * Verify a SEV-SNP attestation bundle.
   */
  async verify(
    bundle: AttestationBundle,
    _policy?: VerifierPolicy
  ): Promise<VerificationResult> {
    return verificationUnavailable(bundle.teeType);
  }

  /**
   * Extract untrusted measurements; this does not authenticate the evidence.
   */
  async extractMeasurements(bundle: AttestationBundle): Promise<Measurements> {
    const sevSnpBundle = bundle as SevSnpAttestation;

    // Try to extract from sev-snp-specific fields
    if (sevSnpBundle.sevSnp) {
      return {
        firmwareVersion: undefined,
        sevSnp: {
          launchMeasurement: sevSnpBundle.sevSnp.launchMeasurement,
          guestPolicy: "0x0", // Would be extracted from report
          vmpl: undefined,
        },
        tdx: undefined,
        sgx: undefined,
        nitro: undefined,
      };
    }

    // Fallback: parse from evidence
    const { measurement, policy, vmpl } = await this.parseFromEvidence(bundle);

    return {
      firmwareVersion: undefined,
      sevSnp: {
        launchMeasurement: measurement,
        guestPolicy: policy,
        vmpl,
      },
      tdx: undefined,
      sgx: undefined,
      nitro: undefined,
    };
  }

  async verifyBinding(
    _bundle: AttestationBundle,
    _expectedHash: string
  ): Promise<boolean> {
    // Caller-supplied fields cannot authenticate a binding without signed evidence.
    return false;
  }

  /**
   * Parse measurements from the evidence.
   */
  private async parseFromEvidence(
    bundle: AttestationBundle
  ): Promise<{ measurement: string; policy: string; vmpl: number | undefined }> {
    if (!bundle.evidence.data) {
      return {
        measurement: "0".repeat(96),
        policy: "0x0",
        vmpl: undefined,
      };
    }

    try {
      const decoded = JSON.parse(
        Buffer.from(bundle.evidence.data, "base64").toString("utf-8")
      ) as { measurement?: string; policy?: string; vmpl?: number };

      return {
        measurement: decoded.measurement ?? "0".repeat(96),
        policy: decoded.policy ?? "0x0",
        vmpl: decoded.vmpl,
      };
    } catch {
      return {
        measurement: "0".repeat(96),
        policy: "0x0",
        vmpl: undefined,
      };
    }
  }
}

/**
 * Create a SEV-SNP verifier instance.
 */
export function createSevSnpVerifier(): SevSnpVerifier {
  return new SevSnpVerifier();
}
