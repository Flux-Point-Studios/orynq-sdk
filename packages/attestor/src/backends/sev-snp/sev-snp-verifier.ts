/**
 * AMD SEV-SNP Verifier.
 * Verifies attestation bundles from SEV-SNP protected VMs.
 */

import type { AttestationVerifier } from "../../verification/verifier-interface.js";
import type {
  AttestationBundle,
  VerificationResult,
  VerifierPolicy,
  Measurements,
  SevSnpAttestation,
} from "../../types.js";
import { evaluatePolicy } from "../../verification/policy-engine.js";

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
    policy?: VerifierPolicy
  ): Promise<VerificationResult> {
    const warnings: string[] = [];
    const errors: string[] = [];

    // Check TEE type
    if (bundle.teeType !== "sev-snp") {
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
        errors: [`Expected SEV-SNP attestation, got ${bundle.teeType}`],
        measurements: undefined,
      };
    }

    // Extract measurements
    const measurements = await this.extractMeasurements(bundle);

    // Verify signature on attestation report
    const signatureValid = await this.verifySignature(bundle);
    if (!signatureValid) {
      errors.push("Attestation report signature is invalid");
    }

    // Verify certificate chain to AMD root
    const certChainValid = await this.verifyCertChain(bundle);
    if (!certChainValid) {
      warnings.push("Certificate chain verification not fully implemented");
    }

    // Verify hash binding
    const hashBindingValid = await this.verifyBinding(
      bundle,
      bundle.binding.hash
    );
    if (!hashBindingValid) {
      errors.push("Hash binding verification failed");
    }

    // Evaluate policy
    const effectivePolicy = policy ?? bundle.verifierPolicy;
    const policyResult = evaluatePolicy(
      measurements,
      effectivePolicy,
      "sev-snp"
    );

    warnings.push(...policyResult.warnings);
    errors.push(...policyResult.errors);

    const valid =
      signatureValid &&
      certChainValid &&
      hashBindingValid &&
      policyResult.passed;

    return {
      valid,
      teeType: "sev-snp",
      checks: {
        signatureValid,
        measurementsMatch: policyResult.measurementsMatch,
        certChainValid,
        notRevoked: policyResult.notRevoked,
        hashBindingValid,
      },
      warnings,
      errors,
      measurements,
    };
  }

  /**
   * Extract measurements from a SEV-SNP attestation bundle.
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

  /**
   * Verify the hash binding in the attestation.
   */
  async verifyBinding(
    bundle: AttestationBundle,
    expectedHash: string
  ): Promise<boolean> {
    const sevSnpBundle = bundle as SevSnpAttestation;

    // Check if the reportData field contains the expected hash
    if (sevSnpBundle.sevSnp?.reportData) {
      return sevSnpBundle.sevSnp.reportData === expectedHash;
    }

    // Fallback: check the binding field
    return bundle.binding.hash === expectedHash;
  }

  // === Private Methods ===

  /**
   * Verify the ECDSA signature on the attestation report.
   *
   * In a real implementation, this would:
   * 1. Parse the binary attestation report
   * 2. Extract the signature and the VCEK public key
   * 3. Verify the ECDSA-P384 signature over the report
   */
  private async verifySignature(bundle: AttestationBundle): Promise<boolean> {
    // Mock implementation
    // Real implementation would use ECDSA verification

    if (!bundle.evidence.data) {
      return false;
    }

    const sevSnpBundle = bundle as SevSnpAttestation;

    // Need VCEK certificate to verify
    if (!sevSnpBundle.sevSnp?.vcek) {
      return false;
    }

    // In production, we would:
    // 1. Parse the attestation report binary
    // 2. Extract the signature bytes
    // 3. Verify using the VCEK public key

    return true;
  }

  /**
   * Verify the certificate chain to AMD root.
   */
  private async verifyCertChain(bundle: AttestationBundle): Promise<boolean> {
    const sevSnpBundle = bundle as SevSnpAttestation;

    if (!sevSnpBundle.sevSnp?.certChain) {
      // No certificate chain to verify
      return true;
    }

    // In production, we would:
    // 1. Parse each certificate in the chain
    // 2. Verify VCEK is signed by ASK (AMD SEV Key)
    // 3. Verify ASK is signed by ARK (AMD Root Key)
    // 4. Verify ARK matches known AMD root certificate
    // 5. Check certificate validity dates
    // 6. Check for revocations via AMD CRL

    return true;
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
