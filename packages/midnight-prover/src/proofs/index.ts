/**
 * @fileoverview Proof generators exports.
 *
 * Location: packages/midnight-prover/src/proofs/index.ts
 *
 * Summary:
 * This file exports all proof generator classes and factory functions.
 * Each prover handles a specific type of ZK proof for the PoI system.
 *
 * Usage:
 * ```typescript
 * import {
 *   HashChainProver,
 *   PolicyComplianceProver,
 *   SelectiveDisclosureProver,
 *   createHashChainProver,
 * } from "@fluxpointstudios/poi-sdk-midnight-prover";
 *
 * const prover = createHashChainProver({ debug: true });
 * const proof = await prover.generateProof(input);
 * ```
 *
 * Related files:
 * - hash-chain-proof.ts: Hash chain validity proofs
 * - policy-compliance-proof.ts: Policy compliance proofs
 * - selective-disclosure.ts: Selective disclosure proofs with Merkle utilities
 * - eval-awareness-proof.ts: Eval awareness safety proofs
 * - covert-channel-proof.ts: Covert channel detection proofs
 * - monitor-compliance-proof.ts: Monitor compliance proofs
 * - (future) attestation-proof.ts: TEE attestation proofs
 */

// =============================================================================
// HASH CHAIN PROVER
// =============================================================================

export type { HashChainProverOptions } from "./hash-chain-proof.js";

export {
  HashChainProver,
  createHashChainProver,
} from "./hash-chain-proof.js";

// =============================================================================
// POLICY COMPLIANCE PROVER
// =============================================================================

export type {
  PolicyComplianceProverOptions,
  RuleEvaluationResult,
  PolicyEvaluationResult,
  RuleEvaluator,
} from "./policy-compliance-proof.js";

export {
  PolicyComplianceProver,
  createPolicyComplianceProver,
} from "./policy-compliance-proof.js";

// =============================================================================
// SELECTIVE DISCLOSURE PROVER
// =============================================================================

export type {
  SelectiveDisclosureProverOptions,
  MerkleInclusionResult,
} from "./selective-disclosure.js";

export {
  SelectiveDisclosureProver,
  createSelectiveDisclosureProver,
  // Merkle utilities
  computeSpanHash,
  computeLeafHash,
  computeNodeHash,
  computeMerkleRoot,
  generateMerkleInclusionProof,
  verifyMerkleProof,
  verifySpanInclusion,
} from "./selective-disclosure.js";

// =============================================================================
// EVAL AWARENESS PROVER
// =============================================================================

export type { EvalAwarenessProverOptions } from "./eval-awareness-proof.js";

export {
  EvalAwarenessProver,
  createEvalAwarenessProver,
} from "./eval-awareness-proof.js";

// =============================================================================
// COVERT CHANNEL PROVER
// =============================================================================

export type { CovertChannelProverOptions } from "./covert-channel-proof.js";

export {
  CovertChannelProver,
  createCovertChannelProver,
} from "./covert-channel-proof.js";

// =============================================================================
// MONITOR COMPLIANCE PROVER
// =============================================================================

export type { MonitorComplianceProverOptions } from "./monitor-compliance-proof.js";

export {
  MonitorComplianceProver,
  createMonitorComplianceProver,
} from "./monitor-compliance-proof.js";
