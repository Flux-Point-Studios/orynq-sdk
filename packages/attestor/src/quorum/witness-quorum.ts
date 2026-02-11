/**
 * @fileoverview Witness quorum collection and certificate generation.
 *
 * Location: packages/attestor/src/quorum/witness-quorum.ts
 *
 * Summary:
 * This module implements the WitnessQuorum class which collects independent
 * witness observations and generates quorum certificates when enough witnesses
 * agree on the same set of binding hashes. The quorum provides distributed
 * trust by requiring multiple parties to confirm the same state.
 *
 * Usage:
 * ```typescript
 * import { WitnessQuorum } from '@fluxpointstudios/poi-sdk-attestor';
 *
 * const quorum = new WitnessQuorum({
 *   minWitnesses: 3,
 *   timeoutMs: 30000,
 *   requiredBindings: ['baseRootHash', 'baseManifestHash'],
 * });
 *
 * quorum.addObservation(observation1);
 * quorum.addObservation(observation2);
 * quorum.addObservation(observation3);
 *
 * if (quorum.isQuorumMet()) {
 *   const certificate = await quorum.generateCertificate();
 *   console.log('Certificate:', certificate.certificateHash);
 * }
 * ```
 *
 * Related files:
 * - quorum-types.ts: Type definitions used by this module
 * - quorum-certificate.ts: Certificate verification utilities
 * - ../attestor-interface.ts: The attestor interface this extends
 */

import { randomUUID } from "node:crypto";

import type {
  QuorumConfig,
  WitnessObservation,
  QuorumCertificate,
} from "./quorum-types.js";

import {
  QuorumError,
  QuorumException,
} from "./quorum-types.js";

import {
  sha256StringHex,
  canonicalize,
} from "@fluxpointstudios/poi-sdk-core/utils";

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Domain prefix for quorum certificate hashes.
 */
const CERTIFICATE_HASH_DOMAIN = "poi-trace:safety:v1|";

// =============================================================================
// WITNESS QUORUM
// =============================================================================

/**
 * WitnessQuorum collects witness observations and generates quorum certificates.
 *
 * A quorum is met when the required minimum number of independent witnesses
 * have submitted observations that all agree on the same binding hashes
 * (baseRootHash, baseManifestHash, attestationEvidenceHash, monitorConfigHash).
 *
 * @example
 * ```typescript
 * const quorum = new WitnessQuorum({
 *   minWitnesses: 3,
 *   timeoutMs: 30000,
 *   requiredBindings: ['baseRootHash', 'baseManifestHash'],
 * });
 *
 * quorum.addObservation({
 *   witnessId: 'w1',
 *   attestorId: 'a1',
 *   baseRootHash: 'abc...',
 *   baseManifestHash: 'def...',
 *   attestationEvidenceHash: 'ghi...',
 *   monitorConfigHash: 'jkl...',
 *   timestamp: new Date().toISOString(),
 * });
 *
 * // Add more observations...
 *
 * if (quorum.isQuorumMet()) {
 *   const cert = await quorum.generateCertificate();
 * }
 * ```
 */
export class WitnessQuorum {
  private observations: WitnessObservation[] = [];
  private readonly config: QuorumConfig;

  /**
   * Create a new WitnessQuorum.
   *
   * @param config - Quorum configuration
   */
  constructor(config: QuorumConfig) {
    this.config = config;
  }

  /**
   * Add a witness observation to the quorum.
   *
   * Validates that:
   * - The witness ID is not a duplicate
   * - Binding hashes match existing observations (if any)
   *
   * @param observation - The witness observation to add
   * @throws QuorumException on duplicate witness or binding mismatch
   */
  addObservation(observation: WitnessObservation): void {
    // Validate no duplicate witness
    if (this.observations.some((o) => o.witnessId === observation.witnessId)) {
      throw new QuorumException(
        QuorumError.DUPLICATE_WITNESS,
        `Duplicate witness: ${observation.witnessId}`
      );
    }

    // Validate observation has required fields
    if (!observation.witnessId || !observation.attestorId) {
      throw new QuorumException(
        QuorumError.INVALID_OBSERVATION,
        "Observation must have witnessId and attestorId"
      );
    }

    // Validate bindings match first observation
    if (this.observations.length > 0) {
      const first = this.observations[0]!;
      if (
        observation.baseRootHash !== first.baseRootHash ||
        observation.baseManifestHash !== first.baseManifestHash ||
        observation.attestationEvidenceHash !== first.attestationEvidenceHash ||
        observation.monitorConfigHash !== first.monitorConfigHash
      ) {
        throw new QuorumException(
          QuorumError.INVALID_BINDING,
          "Observation bindings do not match existing observations"
        );
      }
    }

    this.observations.push(observation);
  }

  /**
   * Check whether the quorum threshold has been met.
   *
   * @returns True if enough witnesses have submitted matching observations
   */
  isQuorumMet(): boolean {
    return this.observations.length >= this.config.minWitnesses;
  }

  /**
   * Get the current number of observations collected.
   *
   * @returns Number of observations
   */
  getObservationCount(): number {
    return this.observations.length;
  }

  /**
   * Get the quorum configuration.
   *
   * @returns The quorum config
   */
  getConfig(): QuorumConfig {
    return this.config;
  }

  /**
   * Generate a quorum certificate from collected observations.
   *
   * The certificate hash is computed as:
   * sha256("poi-trace:safety:v1|" + canonicalize(certificateData))
   *
   * @returns Promise resolving to the quorum certificate
   * @throws QuorumException if quorum is not met or no observations exist
   */
  async generateCertificate(): Promise<QuorumCertificate> {
    if (this.observations.length === 0) {
      throw new QuorumException(
        QuorumError.INSUFFICIENT_WITNESSES,
        "No observations collected"
      );
    }

    const quorumMet = this.isQuorumMet();
    const first = this.observations[0]!;

    // Build certificate data (without hash, for hash computation)
    const certificateData = {
      certificateId: randomUUID(),
      baseRootHash: first.baseRootHash,
      baseManifestHash: first.baseManifestHash,
      attestationEvidenceHash: first.attestationEvidenceHash,
      monitorConfigHash: first.monitorConfigHash,
      witnesses: [...this.observations],
      witnessCount: this.observations.length,
      quorumThreshold: this.config.minWitnesses,
      quorumMet,
      createdAt: new Date().toISOString(),
    };

    // Compute certificate hash
    const canonicalData = canonicalize(certificateData);
    const hashInput = CERTIFICATE_HASH_DOMAIN + canonicalData;
    const certificateHash = await sha256StringHex(hashInput);

    const certificate: QuorumCertificate = {
      ...certificateData,
      certificateHash,
    };

    return certificate;
  }

  /**
   * Reset the quorum, clearing all collected observations.
   */
  reset(): void {
    this.observations = [];
  }
}
