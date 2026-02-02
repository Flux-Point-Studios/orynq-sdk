/**
 * @fileoverview Midnight circuit utilities exports.
 *
 * Location: packages/midnight-prover/src/midnight/index.ts
 *
 * Summary:
 * This file exports all Midnight-specific utilities for witness building
 * and public input construction. These components prepare data for
 * submission to Midnight's Compact circuits.
 *
 * Usage:
 * ```typescript
 * import {
 *   buildHashChainWitness,
 *   buildPublicInputs,
 *   serializeWitness,
 * } from "@fluxpointstudios/poi-sdk-midnight-prover";
 * ```
 *
 * Related files:
 * - witness-builder.ts: Converts trace events to circuit-compatible witnesses
 * - public-inputs.ts: Builds and serializes public inputs for proofs
 */

// =============================================================================
// WITNESS BUILDER
// =============================================================================

export type {
  EventWitness,
  HashChainWitness,
} from "./witness-builder.js";

export {
  buildHashChainWitness,
  serializeWitness,
  computeWitnessSize,
  validateWitness,
} from "./witness-builder.js";

// =============================================================================
// PUBLIC INPUTS
// =============================================================================

export type {
  HashChainPublicInputData,
  PolicyPublicInputData,
  AttestationPublicInputData,
  DisclosurePublicInputData,
  InferencePublicInputData,
  AnyPublicInputData,
} from "./public-inputs.js";

export {
  buildPublicInputs,
  serializePublicInputs,
  hashPublicInputs,
} from "./public-inputs.js";

// =============================================================================
// PROOF SERVER CLIENT
// =============================================================================

export type {
  ProofResult,
  CircuitInfo,
  ProofServerClientOptions,
} from "./proof-server-client.js";

export {
  ProofServerClient,
  createProofServerClient,
} from "./proof-server-client.js";
