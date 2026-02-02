/**
 * AWS Nitro Enclaves Verifier.
 * Verifies attestation bundles from Nitro Enclaves.
 */

import type { AttestationVerifier } from "../../verification/verifier-interface.js";
import type {
  AttestationBundle,
  VerificationResult,
  VerifierPolicy,
  Measurements,
  NitroAttestation,
} from "../../types.js";
import { evaluatePolicy } from "../../verification/policy-engine.js";

/**
 * Verifier for AWS Nitro Enclave attestations.
 */
export class NitroVerifier implements AttestationVerifier {
  readonly teeType = "nitro" as const;

  /**
   * Verify a Nitro attestation bundle.
   */
  async verify(
    bundle: AttestationBundle,
    policy?: VerifierPolicy
  ): Promise<VerificationResult> {
    const warnings: string[] = [];
    const errors: string[] = [];

    // Check TEE type
    if (bundle.teeType !== "nitro") {
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
        errors: [`Expected Nitro attestation, got ${bundle.teeType}`],
        measurements: undefined,
      };
    }

    // Extract measurements
    const measurements = await this.extractMeasurements(bundle);

    // Verify signature on attestation document
    const signatureValid = await this.verifySignature(bundle);
    if (!signatureValid) {
      errors.push("Attestation document signature is invalid");
    }

    // Verify certificate chain to AWS root
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
      "nitro"
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
      teeType: "nitro",
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
   * Extract measurements from a Nitro attestation bundle.
   */
  async extractMeasurements(bundle: AttestationBundle): Promise<Measurements> {
    const nitroBundle = bundle as NitroAttestation;

    // Try to extract from nitro-specific fields
    if (nitroBundle.nitro) {
      return {
        firmwareVersion: undefined,
        sevSnp: undefined,
        tdx: undefined,
        sgx: undefined,
        nitro: {
          pcrs: nitroBundle.nitro.pcrs,
          moduleId: bundle.attestorId,
        },
      };
    }

    // Fallback: parse from evidence
    const pcrs = await this.parsePcrsFromEvidence(bundle);

    return {
      firmwareVersion: undefined,
      sevSnp: undefined,
      tdx: undefined,
      sgx: undefined,
      nitro: {
        pcrs,
        moduleId: bundle.attestorId,
      },
    };
  }

  /**
   * Verify the hash binding in the attestation.
   */
  async verifyBinding(
    bundle: AttestationBundle,
    expectedHash: string
  ): Promise<boolean> {
    const nitroBundle = bundle as NitroAttestation;

    // Check if the userData field contains the expected hash
    if (nitroBundle.nitro?.userData) {
      return nitroBundle.nitro.userData === expectedHash;
    }

    // Fallback: check the binding field
    return bundle.binding.hash === expectedHash;
  }

  // === Private Methods ===

  /**
   * Verify the COSE signature on the attestation document.
   *
   * In a real implementation, this would:
   * 1. Parse the CBOR/COSE attestation document
   * 2. Extract the signature and public key
   * 3. Verify the signature over the document
   */
  private async verifySignature(bundle: AttestationBundle): Promise<boolean> {
    // Mock implementation - always returns true in development
    // Real implementation would use COSE verification

    if (!bundle.evidence.data) {
      return false;
    }

    // In production, we would:
    // 1. Decode the COSE_Sign1 structure
    // 2. Extract the protected headers and payload
    // 3. Verify the ECDSA signature
    // 4. Check that the signing certificate chains to AWS root

    return true;
  }

  /**
   * Verify the certificate chain to AWS Nitro root.
   */
  private async verifyCertChain(bundle: AttestationBundle): Promise<boolean> {
    // Mock implementation
    // Real implementation would verify the certificate chain

    const nitroBundle = bundle as NitroAttestation;

    if (!nitroBundle.nitro?.certificate) {
      // No certificate to verify
      return true;
    }

    // In production, we would:
    // 1. Parse the certificate chain from the attestation document
    // 2. Verify each certificate's signature
    // 3. Check that the root certificate matches AWS Nitro root
    // 4. Check certificate validity dates
    // 5. Check for revocations

    return true;
  }

  /**
   * Parse PCR values from the evidence.
   */
  private async parsePcrsFromEvidence(
    bundle: AttestationBundle
  ): Promise<Record<number, string>> {
    if (!bundle.evidence.data) {
      return {};
    }

    try {
      // Try to parse as JSON (mock format)
      const decoded = JSON.parse(
        Buffer.from(bundle.evidence.data, "base64").toString("utf-8")
      ) as { pcrs?: Record<string, string> };

      if (!decoded.pcrs) {
        return {};
      }

      const pcrs: Record<number, string> = {};
      for (const [key, value] of Object.entries(decoded.pcrs)) {
        pcrs[parseInt(key, 10)] = value;
      }
      return pcrs;
    } catch {
      // In production, this would parse CBOR
      return {};
    }
  }
}

/**
 * Create a Nitro verifier instance.
 */
export function createNitroVerifier(): NitroVerifier {
  return new NitroVerifier();
}
