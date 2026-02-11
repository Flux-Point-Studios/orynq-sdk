/**
 * PoI Midnight Prover Package
 *
 * ZK proof generation for PoI using the Midnight network.
 * Enables privacy-preserving verification of trace properties.
 *
 * Location: packages/midnight-prover/src/index.ts
 *
 * Summary:
 * This is the main entry point for the poi-midnight-prover package. It re-exports
 * all public types, interfaces, and utilities for ZK proof generation.
 *
 * Usage:
 * The package integrates with:
 * - poi-process-trace: Provides TraceEvent and TraceBundle data for proofs
 * - poi-attestor: Provides AttestationBundle for attestation proofs
 * - poi-anchors-cardano: Provides Cardano anchor transaction binding
 *
 * All proofs are bound to a Cardano anchor transaction, creating a cross-chain
 * link between the PoI trace on Cardano L1 and the ZK proof on Midnight.
 *
 * @example
 * ```typescript
 * import {
 *   MidnightProver,
 *   proverRegistry,
 *   HashChainInput,
 *   MidnightProverException,
 * } from '@fluxpointstudios/poi-sdk-midnight-prover';
 *
 * // Get the default prover
 * const prover = proverRegistry.getDefault();
 *
 * // Connect to proof server
 * await prover.connect({
 *   proofServerUrl: 'https://proof.midnight.network',
 *   apiKey: process.env.MIDNIGHT_API_KEY,
 *   timeout: 300000,
 *   retries: 3,
 * });
 *
 * try {
 *   // Generate a hash chain proof
 *   const proof = await prover.proveHashChain({
 *     events: bundle.privateRun.events,
 *     genesisHash: '0x' + '0'.repeat(64),
 *     expectedRootHash: bundle.rootHash,
 *     cardanoAnchorTxHash: anchorTxHash,
 *   });
 *
 *   // Publish to Midnight
 *   const result = await prover.publish(proof);
 *   console.log('Proof published:', result.midnightTxHash);
 * } catch (e) {
 *   if (e instanceof MidnightProverException) {
 *     console.error('Prover error:', e.code, e.message);
 *   }
 *   throw e;
 * }
 * ```
 *
 * @packageDocumentation
 */

// =============================================================================
// CORE TYPES
// =============================================================================

export type {
  // Proof type discriminator
  ProofType,

  // Base proof interface
  Proof,

  // Hash chain proof
  HashChainInput,
  HashChainProof,
  HashChainPublicInputs,

  // Policy compliance proof
  PolicyInput,
  PolicyProof,
  PolicyPublicInputs,
  ContentPolicy,
  PolicyRule,

  // Attestation validity proof
  AttestationInput,
  AttestationProof,
  AttestationPublicInputs,

  // Selective disclosure proof
  DisclosureInput,
  DisclosureProof,
  DisclosurePublicInputs,

  // zkML inference proof
  InferenceInput,
  InferenceProof,
  InferencePublicInputs,
  InferenceParams,
  InferenceProofMetrics,

  // Eval awareness proof
  EvalAwarenessInput,
  EvalAwarenessProof,
  EvalAwarenessPublicInputs,

  // Covert channel proof
  CovertChannelInput,
  CovertChannelProof,
  CovertChannelPublicInputs,

  // Monitor compliance proof
  MonitorComplianceInput,
  MonitorComplianceProof,
  MonitorCompliancePublicInputs,

  // Dual-root support
  PoseidonParams,
  DualRootInput,

  // Configuration
  ProofServerConfig,

  // Publication
  PublicationResult,

  // Verification
  ProofVerificationResult,

  // Union types
  AnyProof,
  AnyProofInput,
  AnyPublicInputs,
} from "./types.js";

// =============================================================================
// ERROR HANDLING
// =============================================================================

export {
  MidnightProverError,
  MidnightProverException,
  DEFAULT_PROOF_SERVER_CONFIG,
} from "./types.js";

// =============================================================================
// TYPE GUARDS
// =============================================================================

export {
  isHashChainProof,
  isPolicyProof,
  isAttestationProof,
  isDisclosureProof,
  isInferenceProof,
  isEvalAwarenessProof,
  isCovertChannelProof,
  isMonitorComplianceProof,
} from "./types.js";

// =============================================================================
// PROVER INTERFACE
// =============================================================================

export type {
  MidnightProver,
  MidnightProverFactory,
  CreateMidnightProverOptions,
  MidnightProverRegistry,
} from "./prover-interface.js";

export {
  AbstractMidnightProver,
  DefaultMidnightProverRegistry,
  proverRegistry,
} from "./prover-interface.js";

// =============================================================================
// PROOF GENERATORS
// =============================================================================

export type {
  HashChainProverOptions,
  PolicyComplianceProverOptions,
  RuleEvaluationResult,
  PolicyEvaluationResult,
  RuleEvaluator,
  SelectiveDisclosureProverOptions,
  MerkleInclusionResult,
  EvalAwarenessProverOptions,
  CovertChannelProverOptions,
  MonitorComplianceProverOptions,
} from "./proofs/index.js";

export {
  // Hash chain prover
  HashChainProver,
  createHashChainProver,
  // Policy compliance prover
  PolicyComplianceProver,
  createPolicyComplianceProver,
  // Selective disclosure prover
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
  // Eval awareness prover
  EvalAwarenessProver,
  createEvalAwarenessProver,
  // Covert channel prover
  CovertChannelProver,
  createCovertChannelProver,
  // Monitor compliance prover
  MonitorComplianceProver,
  createMonitorComplianceProver,
} from "./proofs/index.js";

// =============================================================================
// MIDNIGHT UTILITIES
// =============================================================================

export type {
  EventWitness,
  HashChainWitness,
  HashChainPublicInputData,
  PolicyPublicInputData,
  AttestationPublicInputData,
  DisclosurePublicInputData,
  InferencePublicInputData,
  AnyPublicInputData,
} from "./midnight/index.js";

export {
  buildHashChainWitness,
  serializeWitness,
  computeWitnessSize,
  validateWitness,
  buildPublicInputs,
  serializePublicInputs,
  hashPublicInputs,
} from "./midnight/index.js";

// =============================================================================
// PROOF SERVER CLIENT
// =============================================================================

export type {
  ProofResult,
  CircuitInfo,
  ProofServerClientOptions,
} from "./midnight/index.js";

export {
  ProofServerClient,
  createProofServerClient,
} from "./midnight/index.js";

// =============================================================================
// POSEIDON HASH (ZK-FRIENDLY MERKLE)
// =============================================================================

export type { PoseidonHasher } from "./midnight/poseidon-hash.js";

export {
  computeZkRoot,
  computePoseidonParamsHash,
} from "./midnight/poseidon-hash.js";

// =============================================================================
// LINKING (Publication & Cross-Chain)
// =============================================================================

export type {
  ProofStatus,
  ProofStatusInfo,
  ProofPublisherOptions,
  CrossChainLink,
  LinkVerificationResult,
  CardanoAnchorLinkerOptions,
} from "./linking/index.js";

export {
  ProofPublisher,
  createProofPublisher,
  CardanoAnchorLinker,
  createCardanoAnchorLinker,
} from "./linking/index.js";

// =============================================================================
// DEFAULT PROVER IMPLEMENTATION
// =============================================================================

export {
  DefaultMidnightProver,
  createMidnightProver,
} from "./prover.js";
