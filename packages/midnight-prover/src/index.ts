/** Real Compact proofs, native verification, and explicit legacy simulations. */

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

export { RealMidnightProver, NativeVerifierConfigurationError } from "./real-prover.js";
export type { RealProverOptions, CircuitProof, CapabilityProof, RollingHashChainProof } from "./real-prover.js";
