/**
 * @fileoverview Witness quorum module exports.
 *
 * Location: packages/attestor/src/quorum/index.ts
 *
 * Summary:
 * This file re-exports all public types, classes, and functions from the
 * witness quorum module. The quorum system enables distributed trust by
 * requiring multiple independent witnesses to confirm the same set of
 * binding hashes before generating a certificate.
 *
 * Usage:
 * ```typescript
 * import {
 *   WitnessQuorum,
 *   verifyCertificate,
 *   QuorumError,
 * } from '@fluxpointstudios/poi-sdk-attestor';
 * ```
 *
 * Related files:
 * - quorum-types.ts: Error codes, exception class, and type definitions
 * - witness-quorum.ts: WitnessQuorum class for collecting observations
 * - quorum-certificate.ts: Certificate verification utilities
 */

// =============================================================================
// TYPES AND ERRORS
// =============================================================================

export type {
  QuorumConfig,
  WitnessObservation,
  QuorumCertificate,
} from "./quorum-types.js";

export {
  QuorumError,
  QuorumException,
} from "./quorum-types.js";

// =============================================================================
// WITNESS QUORUM
// =============================================================================

export { WitnessQuorum } from "./witness-quorum.js";

// =============================================================================
// CERTIFICATE VERIFICATION
// =============================================================================

export {
  verifyCertificate,
  computeCertificateHash,
} from "./quorum-certificate.js";
