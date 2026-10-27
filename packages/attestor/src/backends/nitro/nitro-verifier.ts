/**
 * AWS Nitro Enclaves Verifier.
 * Fails closed until Nitro signature and root-chain verification is available.
 */

import type { AttestationVerifier } from "../../verification/verifier-interface.js";
import type {
  AttestationBundle,
  VerificationResult,
  VerifierPolicy,
  Measurements,
  NitroAttestation,
} from "../../types.js";
import { verificationUnavailable } from "../../verification/verifier-interface.js";

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
    _policy?: VerifierPolicy
  ): Promise<VerificationResult> {
    return verificationUnavailable(bundle.teeType);
  }

  /**
   * Extract untrusted measurements; this does not authenticate the evidence.
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

  async verifyBinding(
    _bundle: AttestationBundle,
    _expectedHash: string
  ): Promise<boolean> {
    // Caller-supplied fields cannot authenticate a binding without signed evidence.
    return false;
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
