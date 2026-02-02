/**
 * @fileoverview Type definitions for the poi-midnight-prover package.
 *
 * Location: packages/midnight-prover/src/types.ts
 *
 * Summary:
 * This file contains all type definitions for ZK proof generation using the Midnight network.
 * It defines proof types, input/output structures for various proof circuits, configuration
 * options, and error handling.
 *
 * Usage:
 * Types are imported by the prover-interface.ts and will be used by proof generation
 * implementations in the proofs/ directory. These types integrate with process-trace
 * (TraceEvent, TraceBundle) and attestor (AttestationBundle, VerifierPolicy) packages.
 *
 * Key concepts:
 * - ProofType: Discriminator for different ZK proof circuits
 * - HashChainProof: Proves trace hash chain validity
 * - PolicyProof: Proves content compliance without revealing content
 * - AttestationProof: Proves valid TEE attestation
 * - DisclosureProof: Selective disclosure of spans without revealing others
 * - InferenceProof: Optional zkML proof for model inference correctness
 */

import type { TraceEvent, TraceSpan, TraceBundle } from "@fluxpointstudios/poi-sdk-process-trace";
import type { AttestationBundle, VerifierPolicy, TeeType } from "@fluxpointstudios/poi-sdk-attestor";

// =============================================================================
// PROOF TYPES
// =============================================================================

/**
 * Discriminator for different ZK proof types.
 * Each type corresponds to a specific Compact circuit.
 */
export type ProofType =
  | "hash-chain"              // Trace hash chain is valid
  | "policy-compliance"       // Content passed policy Y
  | "attestation-valid"       // TEE attestation is valid
  | "selective-disclosure"    // Span exists without reveal
  | "zkml-inference";         // Output correct for input (expensive)

// =============================================================================
// BASE PROOF INTERFACE
// =============================================================================

/**
 * Base interface for all ZK proofs.
 * Contains common fields shared by all proof types.
 *
 * @property proofType - Discriminator for proof kind
 * @property proofId - Unique identifier for this proof
 * @property proof - Serialized proof bytes (Compact format)
 * @property createdAt - ISO 8601 timestamp of proof generation
 * @property provingTimeMs - Time taken to generate the proof
 * @property proofSizeBytes - Size of the proof in bytes
 */
export interface Proof {
  proofType: ProofType;
  proofId: string;
  proof: Uint8Array;
  createdAt: string;
  provingTimeMs: number;
  proofSizeBytes: number;
}

// =============================================================================
// HASH CHAIN PROOF
// =============================================================================

/**
 * Input for hash chain validity proof.
 * Proves that a sequence of events produces the expected rolling hash.
 *
 * @property events - The trace events (private witness)
 * @property genesisHash - Initial hash state (usually zeros)
 * @property expectedRootHash - Public commitment (from Cardano anchor)
 * @property cardanoAnchorTxHash - Transaction hash on Cardano L1 for cross-chain binding
 */
export interface HashChainInput {
  events: TraceEvent[];
  genesisHash: string;
  expectedRootHash: string;
  cardanoAnchorTxHash: string;
}

/**
 * Hash chain validity proof.
 * Demonstrates that a sequence of events produces the anchored root hash.
 *
 * @property publicInputs - Values visible to verifiers
 * @property publicInputs.rootHash - The final rolling hash (matches anchor)
 * @property publicInputs.eventCount - Number of events in the chain
 * @property publicInputs.cardanoAnchorTxHash - Binding to Cardano anchor
 */
export interface HashChainProof extends Proof {
  proofType: "hash-chain";
  publicInputs: HashChainPublicInputs;
}

export interface HashChainPublicInputs {
  rootHash: string;
  eventCount: number;
  cardanoAnchorTxHash: string;
}

// =============================================================================
// POLICY COMPLIANCE PROOF
// =============================================================================

/**
 * Input for policy compliance proof.
 * Proves content passed a policy without revealing the content.
 *
 * @property promptHash - Hash of the prompt (private)
 * @property outputHash - Hash of the output (private)
 * @property policy - Policy definition to check against
 * @property cardanoAnchorTxHash - Binding to Cardano anchor
 */
export interface PolicyInput {
  promptHash: string;
  outputHash: string;
  policy: ContentPolicy;
  cardanoAnchorTxHash: string;
}

/**
 * Content policy definition.
 * Describes rules that content must comply with.
 *
 * @property id - Unique identifier for this policy
 * @property version - Semantic version of the policy
 * @property rules - Array of rules to evaluate
 */
export interface ContentPolicy {
  id: string;
  version: string;
  rules: PolicyRule[];
}

/**
 * Individual policy rule.
 *
 * @property type - Rule type (blocklist, allowlist, regex, classifier)
 * @property target - What to apply the rule to (prompt, output, or both)
 * @property params - Rule-specific parameters
 */
export interface PolicyRule {
  type: "blocklist" | "allowlist" | "regex" | "classifier";
  target: "prompt" | "output" | "both";
  params: Record<string, unknown>;
}

/**
 * Policy compliance proof.
 * Demonstrates content compliance without revealing content.
 *
 * @property publicInputs - Values visible to verifiers
 * @property publicInputs.promptHash - Reveals hash, not content
 * @property publicInputs.policyId - Policy that was checked
 * @property publicInputs.policyVersion - Version of the policy
 * @property publicInputs.compliant - Whether content passed policy
 * @property publicInputs.cardanoAnchorTxHash - Binding to Cardano anchor
 */
export interface PolicyProof extends Proof {
  proofType: "policy-compliance";
  publicInputs: PolicyPublicInputs;
}

export interface PolicyPublicInputs {
  promptHash: string;
  policyId: string;
  policyVersion: string;
  compliant: boolean;
  cardanoAnchorTxHash: string;
}

// =============================================================================
// ATTESTATION VALIDITY PROOF
// =============================================================================

/**
 * Input for attestation validity proof.
 * Proves a TEE attestation is valid without revealing full evidence.
 *
 * @property attestation - Full attestation bundle (private witness)
 * @property policy - Expected verifier policy
 * @property cardanoAnchorTxHash - Binding to Cardano anchor
 */
export interface AttestationInput {
  attestation: AttestationBundle;
  policy: VerifierPolicy;
  cardanoAnchorTxHash: string;
}

/**
 * Attestation validity proof.
 * Demonstrates TEE attestation validity without exposing full evidence.
 *
 * @property publicInputs - Values visible to verifiers
 * @property publicInputs.teeType - Type of TEE that was attested
 * @property publicInputs.measurementMatch - Whether measurements matched policy
 * @property publicInputs.boundHash - The hash that was bound in attestation
 * @property publicInputs.cardanoAnchorTxHash - Binding to Cardano anchor
 */
export interface AttestationProof extends Proof {
  proofType: "attestation-valid";
  publicInputs: AttestationPublicInputs;
}

export interface AttestationPublicInputs {
  teeType: TeeType;
  measurementMatch: boolean;
  boundHash: string;
  cardanoAnchorTxHash: string;
}

// =============================================================================
// SELECTIVE DISCLOSURE PROOF
// =============================================================================

/**
 * Input for selective disclosure proof.
 * Proves a span exists in a bundle without revealing other spans.
 *
 * @property bundle - Full trace bundle (private witness)
 * @property spanId - ID of span to disclose/prove membership
 * @property merkleRoot - Expected Merkle root (from anchor)
 * @property cardanoAnchorTxHash - Binding to Cardano anchor
 */
export interface DisclosureInput {
  bundle: TraceBundle;
  spanId: string;
  merkleRoot: string;
  cardanoAnchorTxHash: string;
}

/**
 * Selective disclosure proof.
 * Proves span membership with optional span/event revelation.
 *
 * @property publicInputs - Values visible to verifiers
 * @property publicInputs.spanHash - Hash of the disclosed span
 * @property publicInputs.merkleRoot - Merkle root the span belongs to
 * @property publicInputs.cardanoAnchorTxHash - Binding to Cardano anchor
 * @property disclosedSpan - Optionally revealed span data
 * @property disclosedEvents - Optionally revealed events in span
 */
export interface DisclosureProof extends Proof {
  proofType: "selective-disclosure";
  publicInputs: DisclosurePublicInputs;
  disclosedSpan: TraceSpan | undefined;
  disclosedEvents: TraceEvent[] | undefined;
}

export interface DisclosurePublicInputs {
  spanHash: string;
  merkleRoot: string;
  cardanoAnchorTxHash: string;
}

// =============================================================================
// ZKML INFERENCE PROOF (OPTIONAL, HIGH-STAKES)
// =============================================================================

/**
 * Inference parameters for zkML proof.
 * Captures model configuration at inference time.
 */
export interface InferenceParams {
  temperature: number | undefined;
  topP: number | undefined;
  topK: number | undefined;
  maxTokens: number | undefined;
  stopStrings: string[] | undefined;
  frequencyPenalty: number | undefined;
  presencePenalty: number | undefined;
}

/**
 * Input for zkML inference proof.
 * Proves model output is correct for given inputs.
 *
 * WARNING: zkML proofs are extremely expensive. Use only for high-stakes scenarios.
 *
 * @property modelId - Identifier of the model (e.g., "gpt-4", "claude-3")
 * @property modelWeightDigest - Hash of model weights (for verification)
 * @property inputTokens - Tokenized input (private)
 * @property outputTokens - Tokenized output (private)
 * @property params - Inference parameters used
 * @property cardanoAnchorTxHash - Binding to Cardano anchor
 */
export interface InferenceInput {
  modelId: string;
  modelWeightDigest: string;
  inputTokens: number[];
  outputTokens: number[];
  params: InferenceParams;
  cardanoAnchorTxHash: string;
}

/**
 * zkML inference proof.
 * Proves model inference correctness (extremely expensive).
 *
 * @property publicInputs - Values visible to verifiers
 * @property publicInputs.modelWeightDigest - Proves which model was used
 * @property publicInputs.inputHash - Hash of input tokens
 * @property publicInputs.outputHash - Hash of output tokens
 * @property publicInputs.paramsHash - Hash of inference parameters
 * @property publicInputs.cardanoAnchorTxHash - Binding to Cardano anchor
 * @property metrics - Cost/performance metrics for the proof
 */
export interface InferenceProof extends Proof {
  proofType: "zkml-inference";
  publicInputs: InferencePublicInputs;
  metrics: InferenceProofMetrics;
}

export interface InferencePublicInputs {
  modelWeightDigest: string;
  inputHash: string;
  outputHash: string;
  paramsHash: string;
  cardanoAnchorTxHash: string;
}

/**
 * Metrics for zkML proof generation.
 * zkML proofs are expensive - these metrics help track costs.
 */
export interface InferenceProofMetrics {
  provingTimeMs: number;
  proofSizeBytes: number;
  circuitSize: number;
  memoryUsageMB: number | undefined;
  gpuUsed: boolean | undefined;
}

// =============================================================================
// PROOF SERVER CONFIGURATION
// =============================================================================

/**
 * Configuration for connecting to a Midnight proof server.
 *
 * @property proofServerUrl - URL of the Midnight proof server
 * @property apiKey - Optional API key for authentication
 * @property timeout - Request timeout in milliseconds
 * @property retries - Number of retries on failure
 * @property circuitCacheDir - Optional local circuit cache directory
 */
export interface ProofServerConfig {
  proofServerUrl: string;
  apiKey: string | undefined;
  timeout: number;
  retries: number;
  circuitCacheDir: string | undefined;
}

/**
 * Default proof server configuration.
 */
export const DEFAULT_PROOF_SERVER_CONFIG: Partial<ProofServerConfig> = {
  timeout: 300_000, // 5 minutes
  retries: 3,
} as const;

// =============================================================================
// PUBLICATION
// =============================================================================

/**
 * Result of publishing a proof to the Midnight network.
 *
 * @property midnightTxHash - Transaction hash on Midnight
 * @property proofId - Unique identifier for the proof
 * @property timestamp - When the proof was published
 * @property cardanoAnchorTxHash - Cross-chain reference to Cardano
 * @property blockNumber - Block number where proof was included
 * @property fee - Fee paid for publication
 */
export interface PublicationResult {
  midnightTxHash: string;
  proofId: string;
  timestamp: string;
  cardanoAnchorTxHash: string;
  blockNumber: number | undefined;
  fee: bigint | undefined;
}

// =============================================================================
// VERIFICATION
// =============================================================================

/**
 * Result of verifying a proof.
 */
export interface ProofVerificationResult {
  valid: boolean;
  proofType: ProofType;
  publicInputs: Record<string, unknown>;
  errors: string[];
  warnings: string[];
  verifiedAt: string;
}

// =============================================================================
// ERRORS
// =============================================================================

/**
 * Error codes for midnight-prover operations.
 * Uses 5xxx range as specified in architectural plan.
 */
export enum MidnightProverError {
  // Connection errors (5000-5019)
  CONNECTION_FAILED = 5000,
  CONNECTION_TIMEOUT = 5001,
  CONNECTION_REFUSED = 5002,
  AUTHENTICATION_FAILED = 5003,

  // Proof generation errors (5020-5049)
  PROOF_GENERATION_FAILED = 5020,
  CIRCUIT_NOT_FOUND = 5021,
  INVALID_WITNESS = 5022,
  WITNESS_TOO_LARGE = 5023,
  INSUFFICIENT_RESOURCES = 5024,
  PROVING_TIMEOUT = 5025,

  // Proof verification errors (5050-5079)
  PROOF_VERIFICATION_FAILED = 5050,
  INVALID_PROOF_FORMAT = 5051,
  PUBLIC_INPUT_MISMATCH = 5052,
  PROOF_EXPIRED = 5053,

  // Publication errors (5080-5099)
  PUBLICATION_FAILED = 5080,
  INSUFFICIENT_FUNDS = 5081,
  NETWORK_ERROR = 5082,
  TRANSACTION_REJECTED = 5083,

  // Input validation errors (5100-5119)
  INVALID_INPUT = 5100,
  MISSING_REQUIRED_FIELD = 5101,
  HASH_MISMATCH = 5102,
  ANCHOR_NOT_FOUND = 5103,
  SPAN_NOT_FOUND = 5104,

  // Circuit errors (5120-5139)
  CIRCUIT_COMPILE_FAILED = 5120,
  CIRCUIT_EXECUTION_FAILED = 5121,
  CIRCUIT_CONSTRAINT_VIOLATED = 5122,
}

/**
 * Exception class for midnight-prover errors.
 * Provides structured error information with error codes.
 */
export class MidnightProverException extends Error {
  constructor(
    public readonly code: MidnightProverError,
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "MidnightProverException";
  }

  /**
   * Create a formatted error message including code.
   */
  toString(): string {
    const codeStr = MidnightProverError[this.code] ?? this.code.toString();
    const causeStr = this.cause ? ` (caused by: ${this.cause.message})` : "";
    return `[${codeStr}] ${this.message}${causeStr}`;
  }
}

// =============================================================================
// UNION TYPES
// =============================================================================

/**
 * Union of all proof types for type guards and discriminated unions.
 */
export type AnyProof =
  | HashChainProof
  | PolicyProof
  | AttestationProof
  | DisclosureProof
  | InferenceProof;

/**
 * Union of all proof input types.
 */
export type AnyProofInput =
  | HashChainInput
  | PolicyInput
  | AttestationInput
  | DisclosureInput
  | InferenceInput;

/**
 * Union of all public input types.
 */
export type AnyPublicInputs =
  | HashChainPublicInputs
  | PolicyPublicInputs
  | AttestationPublicInputs
  | DisclosurePublicInputs
  | InferencePublicInputs;

// =============================================================================
// TYPE GUARDS
// =============================================================================

/**
 * Type guard for HashChainProof.
 */
export function isHashChainProof(proof: AnyProof): proof is HashChainProof {
  return proof.proofType === "hash-chain";
}

/**
 * Type guard for PolicyProof.
 */
export function isPolicyProof(proof: AnyProof): proof is PolicyProof {
  return proof.proofType === "policy-compliance";
}

/**
 * Type guard for AttestationProof.
 */
export function isAttestationProof(proof: AnyProof): proof is AttestationProof {
  return proof.proofType === "attestation-valid";
}

/**
 * Type guard for DisclosureProof.
 */
export function isDisclosureProof(proof: AnyProof): proof is DisclosureProof {
  return proof.proofType === "selective-disclosure";
}

/**
 * Type guard for InferenceProof.
 */
export function isInferenceProof(proof: AnyProof): proof is InferenceProof {
  return proof.proofType === "zkml-inference";
}
