/**
 * @fileoverview Quorum certificate verification utilities.
 *
 * Location: packages/attestor/src/quorum/quorum-certificate.ts
 *
 * Summary:
 * This module provides functions for verifying quorum certificates. Verification
 * includes recomputing the certificate hash, checking witness counts, and
 * validating binding consistency across all witness observations.
 *
 * Usage:
 * ```typescript
 * import { verifyCertificate, computeCertificateHash } from '@fluxpointstudios/poi-sdk-attestor';
 *
 * const isValid = await verifyCertificate(certificate);
 * const recomputedHash = await computeCertificateHash(certificate);
 * ```
 *
 * Related files:
 * - quorum-types.ts: QuorumCertificate type definition
 * - witness-quorum.ts: WitnessQuorum class that generates certificates
 */

import type { QuorumCertificate } from "./quorum-types.js";

import {
  sha256StringHex,
  canonicalize,
} from "@fluxpointstudios/poi-sdk-core/utils";

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Domain prefix for quorum certificate hashes.
 * Must match the domain used in witness-quorum.ts.
 */
const CERTIFICATE_HASH_DOMAIN = "poi-trace:safety:v1|";

// =============================================================================
// CERTIFICATE VERIFICATION
// =============================================================================

/**
 * Verify a quorum certificate.
 *
 * This function checks:
 * 1. The certificate hash matches the recomputed hash
 * 2. The witness count matches the actual number of witnesses
 * 3. The quorum threshold is positive
 * 4. The quorumMet flag is consistent with witness count vs threshold
 * 5. All witnesses have consistent binding hashes
 * 6. No duplicate witness IDs
 *
 * @param certificate - The quorum certificate to verify
 * @returns Promise resolving to true if the certificate is valid, false otherwise
 */
export async function verifyCertificate(
  certificate: QuorumCertificate
): Promise<boolean> {
  // Check basic structure
  if (!certificate.certificateId || !certificate.certificateHash) {
    return false;
  }

  // Verify witness count
  if (certificate.witnessCount !== certificate.witnesses.length) {
    return false;
  }

  // Verify quorum threshold is positive
  if (certificate.quorumThreshold <= 0) {
    return false;
  }

  // Verify quorumMet flag is consistent
  const expectedQuorumMet = certificate.witnessCount >= certificate.quorumThreshold;
  if (certificate.quorumMet !== expectedQuorumMet) {
    return false;
  }

  // Verify no duplicate witness IDs
  const witnessIds = new Set<string>();
  for (const witness of certificate.witnesses) {
    if (witnessIds.has(witness.witnessId)) {
      return false;
    }
    witnessIds.add(witness.witnessId);
  }

  // Verify all witnesses have consistent bindings
  for (const witness of certificate.witnesses) {
    if (
      witness.baseRootHash !== certificate.baseRootHash ||
      witness.baseManifestHash !== certificate.baseManifestHash ||
      witness.attestationEvidenceHash !== certificate.attestationEvidenceHash ||
      witness.monitorConfigHash !== certificate.monitorConfigHash
    ) {
      return false;
    }
  }

  // Verify certificate hash
  const recomputedHash = await computeCertificateHash(certificate);
  if (recomputedHash !== certificate.certificateHash) {
    return false;
  }

  return true;
}

/**
 * Recompute the certificate hash from certificate data.
 *
 * The hash is computed as:
 * sha256("poi-trace:safety:v1|" + canonicalize(certificateDataWithoutHash))
 *
 * This allows independent verification that the certificate hash matches
 * the actual certificate contents.
 *
 * @param certificate - The quorum certificate
 * @returns Promise resolving to the recomputed hash as a hex string
 */
export async function computeCertificateHash(
  certificate: QuorumCertificate
): Promise<string> {
  // Build the data object excluding the certificateHash field
  const certificateData = {
    certificateId: certificate.certificateId,
    baseRootHash: certificate.baseRootHash,
    baseManifestHash: certificate.baseManifestHash,
    attestationEvidenceHash: certificate.attestationEvidenceHash,
    monitorConfigHash: certificate.monitorConfigHash,
    witnesses: certificate.witnesses,
    witnessCount: certificate.witnessCount,
    quorumThreshold: certificate.quorumThreshold,
    quorumMet: certificate.quorumMet,
    createdAt: certificate.createdAt,
  };

  const canonicalData = canonicalize(certificateData);
  const hashInput = CERTIFICATE_HASH_DOMAIN + canonicalData;
  return sha256StringHex(hashInput);
}
