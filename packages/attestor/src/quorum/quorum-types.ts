/**
 * @fileoverview Type definitions for the witness quorum system.
 *
 * Location: packages/attestor/src/quorum/quorum-types.ts
 *
 * Summary:
 * This file defines error codes, exception class, and core types for the witness
 * quorum system. A quorum certificate proves that multiple independent witnesses
 * observed the same set of binding hashes, providing distributed trust without
 * relying on a single attestor.
 *
 * Usage:
 * Types are imported by:
 * - witness-quorum.ts: WitnessQuorum class for collecting observations
 * - quorum-certificate.ts: Certificate generation and verification
 * - The main attestor index.ts for public API exports
 */

// =============================================================================
// ERROR CODES
// =============================================================================

/**
 * Error codes for witness quorum operations.
 * Uses the 3600-3699 range.
 */
export enum QuorumError {
  /** Not enough witnesses to meet the quorum threshold */
  INSUFFICIENT_WITNESSES = 3600,
  /** A witness with the same ID has already submitted an observation */
  DUPLICATE_WITNESS = 3601,
  /** An observation failed validation */
  INVALID_OBSERVATION = 3602,
  /** Certificate generation failed */
  CERTIFICATE_GENERATION_FAILED = 3603,
  /** Certificate verification failed */
  CERTIFICATE_VERIFICATION_FAILED = 3604,
  /** Quorum threshold not met */
  QUORUM_NOT_MET = 3605,
  /** Binding hashes do not match across observations */
  INVALID_BINDING = 3606,
}

/**
 * Exception class for quorum errors.
 * Provides structured error information with error codes.
 */
export class QuorumException extends Error {
  constructor(
    public readonly code: QuorumError,
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "QuorumException";
  }

  /**
   * Create a formatted error message including code.
   */
  toString(): string {
    const codeStr = QuorumError[this.code] ?? this.code.toString();
    const causeStr = this.cause ? ` (caused by: ${this.cause.message})` : "";
    return `[${codeStr}] ${this.message}${causeStr}`;
  }
}

// =============================================================================
// QUORUM CONFIGURATION
// =============================================================================

/**
 * Configuration for a witness quorum.
 *
 * @property minWitnesses - Minimum number of witnesses required to meet quorum
 * @property timeoutMs - Maximum time to wait for witnesses (milliseconds)
 * @property requiredBindings - Required binding hash field names for validation
 */
export interface QuorumConfig {
  /** Minimum number of witnesses required */
  minWitnesses: number;
  /** Maximum time to wait for witnesses (ms) */
  timeoutMs: number;
  /** Required binding hashes */
  requiredBindings: string[];
}

// =============================================================================
// WITNESS OBSERVATION
// =============================================================================

/**
 * A single witness observation for quorum participation.
 * Each witness independently observes the same set of binding hashes.
 *
 * @property witnessId - Unique identifier for this witness
 * @property attestorId - ID of the attestor that produced this observation
 * @property baseRootHash - Root hash of the base model trace
 * @property baseManifestHash - Hash of the base manifest
 * @property attestationEvidenceHash - Hash of the attestation evidence
 * @property monitorConfigHash - Hash of the monitor configuration
 * @property timestamp - ISO 8601 timestamp of when the observation was made
 * @property signature - Optional cryptographic signature of the observation
 */
export interface WitnessObservation {
  witnessId: string;
  attestorId: string;
  baseRootHash: string;
  baseManifestHash: string;
  attestationEvidenceHash: string;
  monitorConfigHash: string;
  timestamp: string;
  signature?: string;
}

// =============================================================================
// QUORUM CERTIFICATE
// =============================================================================

/**
 * A quorum certificate that binds multiple witness observations together.
 * This certificate proves that a quorum of witnesses independently confirmed
 * the same set of binding hashes.
 *
 * @property certificateId - Unique identifier for this certificate
 * @property baseRootHash - Root hash binding (from observations)
 * @property baseManifestHash - Manifest hash binding (from observations)
 * @property attestationEvidenceHash - Evidence hash binding (from observations)
 * @property monitorConfigHash - Monitor config binding (from observations)
 * @property witnesses - Array of witness observations
 * @property witnessCount - Number of witnesses in this certificate
 * @property quorumThreshold - Minimum required witnesses
 * @property quorumMet - Whether the quorum threshold was met
 * @property certificateHash - H("poi-trace:safety:v1|" + canonicalize(certificate))
 * @property createdAt - ISO 8601 creation timestamp
 */
export interface QuorumCertificate {
  certificateId: string;
  /** Binds all 4 hashes */
  baseRootHash: string;
  baseManifestHash: string;
  attestationEvidenceHash: string;
  monitorConfigHash: string;
  /** Witness observations */
  witnesses: WitnessObservation[];
  /** Number of witnesses */
  witnessCount: number;
  /** Minimum required */
  quorumThreshold: number;
  /** Whether quorum was met */
  quorumMet: boolean;
  /** Certificate hash = H("poi-trace:safety:v1|" + canonicalize(certificate)) */
  certificateHash: string;
  /** Creation timestamp */
  createdAt: string;
}
