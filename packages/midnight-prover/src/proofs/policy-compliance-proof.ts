/**
 * @fileoverview Policy compliance proof generation and verification.
 *
 * Location: packages/midnight-prover/src/proofs/policy-compliance-proof.ts
 *
 * Summary:
 * This module implements the PolicyComplianceProver class which generates ZK proofs
 * demonstrating that content complies with a specified policy without revealing the
 * actual content. The prover evaluates policy rules (blocklist, allowlist, regex,
 * classifier) against content hashes and produces a proof of compliance.
 *
 * Usage:
 * - Used by the MidnightProver to generate policy compliance proofs
 * - Integrates with the types defined in ../types.ts
 * - Binds proofs to Cardano anchor transactions for cross-chain verification
 *
 * @example
 * ```typescript
 * import { PolicyComplianceProver } from './policy-compliance-proof.js';
 *
 * const prover = new PolicyComplianceProver();
 *
 * const proof = await prover.generateProof({
 *   promptHash: 'abc123...',
 *   outputHash: 'def456...',
 *   policy: { id: 'policy-1', version: '1.0.0', rules: [...] },
 *   cardanoAnchorTxHash: 'txhash...',
 * });
 *
 * const isValid = await prover.verifyProof(proof);
 * ```
 */

import {
  sha256StringHex,
  canonicalize,
} from "@fluxpointstudios/poi-sdk-core/utils";

import type {
  PolicyInput,
  PolicyProof,
  PolicyPublicInputs,
  ContentPolicy,
  PolicyRule,
} from "../types.js";

import {
  MidnightProverError,
  MidnightProverException,
} from "../types.js";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Result of evaluating a single policy rule.
 */
export interface RuleEvaluationResult {
  rule: PolicyRule;
  passed: boolean;
  message: string;
}

/**
 * Result of evaluating all policy rules.
 */
export interface PolicyEvaluationResult {
  compliant: boolean;
  ruleResults: RuleEvaluationResult[];
  evaluationTimeMs: number;
}

/**
 * Options for the PolicyComplianceProver.
 */
export interface PolicyComplianceProverOptions {
  /**
   * Enable debug logging.
   */
  debug?: boolean;

  /**
   * Custom rule evaluators for extending policy rule types.
   */
  customEvaluators?: Map<string, RuleEvaluator>;
}

/**
 * Function type for evaluating a policy rule.
 */
export type RuleEvaluator = (
  rule: PolicyRule,
  promptHash: string,
  outputHash: string
) => Promise<RuleEvaluationResult>;

// =============================================================================
// DOMAIN PREFIXES
// =============================================================================

/**
 * Domain separation prefixes for policy compliance proofs.
 */
const POLICY_DOMAIN_PREFIXES = {
  proof: "poi-prover:policy:v1|",
  witness: "poi-prover:policy-witness:v1|",
  publicInput: "poi-prover:policy-input:v1|",
} as const;

// =============================================================================
// DEFAULT RULE EVALUATORS
// =============================================================================

/**
 * Default evaluator for blocklist rules.
 * In ZK context, this simulates checking content hashes against a blocklist.
 *
 * @param rule - The blocklist rule to evaluate
 * @param promptHash - Hash of the prompt content
 * @param outputHash - Hash of the output content
 * @returns Evaluation result
 */
async function evaluateBlocklistRule(
  rule: PolicyRule,
  promptHash: string,
  outputHash: string
): Promise<RuleEvaluationResult> {
  // In a real ZK implementation, this would use a Bloom filter or
  // commitment scheme to check against the blocklist without revealing items.
  // For mock purposes, we simulate by checking if hashes match blocklist patterns.

  const blockedHashes = (rule.params.blockedHashes as string[] | undefined) ?? [];
  const target = rule.target;

  let passed = true;
  let message = "Content does not match any blocked patterns";

  if (target === "prompt" || target === "both") {
    if (blockedHashes.includes(promptHash)) {
      passed = false;
      message = "Prompt matches blocked pattern";
    }
  }

  if (passed && (target === "output" || target === "both")) {
    if (blockedHashes.includes(outputHash)) {
      passed = false;
      message = "Output matches blocked pattern";
    }
  }

  return { rule, passed, message };
}

/**
 * Default evaluator for allowlist rules.
 * Content must match at least one allowed pattern.
 *
 * @param rule - The allowlist rule to evaluate
 * @param promptHash - Hash of the prompt content
 * @param outputHash - Hash of the output content
 * @returns Evaluation result
 */
async function evaluateAllowlistRule(
  rule: PolicyRule,
  promptHash: string,
  outputHash: string
): Promise<RuleEvaluationResult> {
  // In a real ZK implementation, this would verify membership in an
  // allowed set using accumulator proofs or similar techniques.

  const allowedHashes = (rule.params.allowedHashes as string[] | undefined) ?? [];
  const requireAllMatch = (rule.params.requireAllMatch as boolean | undefined) ?? false;
  const target = rule.target;

  // If allowedHashes is empty, everything is allowed (permissive default)
  if (allowedHashes.length === 0) {
    return { rule, passed: true, message: "No allowlist constraints (permissive)" };
  }

  let promptAllowed = true;
  let outputAllowed = true;

  if (target === "prompt" || target === "both") {
    promptAllowed = allowedHashes.some((hash) => promptHash.startsWith(hash));
  }

  if (target === "output" || target === "both") {
    outputAllowed = allowedHashes.some((hash) => outputHash.startsWith(hash));
  }

  const passed = requireAllMatch
    ? promptAllowed && outputAllowed
    : promptAllowed || outputAllowed;

  const message = passed
    ? "Content matches allowlist criteria"
    : "Content does not match any allowed patterns";

  return { rule, passed, message };
}

/**
 * Default evaluator for regex rules.
 * Simulates regex pattern matching in ZK context.
 *
 * @param rule - The regex rule to evaluate
 * @param promptHash - Hash of the prompt content
 * @param outputHash - Hash of the output content
 * @returns Evaluation result
 */
async function evaluateRegexRule(
  rule: PolicyRule,
  promptHash: string,
  outputHash: string
): Promise<RuleEvaluationResult> {
  // In a real ZK implementation, regex matching would be done on
  // the actual content as a private witness. The circuit would
  // verify the regex match and output a boolean commitment.
  // Here we simulate by checking pattern hash signatures.

  const patternHash = (rule.params.patternHash as string | undefined) ?? "";
  const isBlockPattern = (rule.params.isBlockPattern as boolean | undefined) ?? true;
  const target = rule.target;

  // Simulate pattern matching by checking if content hash contains pattern signature
  let matchFound = false;
  const hashesToCheck: string[] = [];

  if (target === "prompt" || target === "both") {
    hashesToCheck.push(promptHash);
  }
  if (target === "output" || target === "both") {
    hashesToCheck.push(outputHash);
  }

  // Simulate: pattern matches if any hash shares prefix with pattern hash
  for (const hash of hashesToCheck) {
    if (patternHash && hash.slice(0, 8) === patternHash.slice(0, 8)) {
      matchFound = true;
      break;
    }
  }

  // For block patterns, passing means no match; for allow patterns, passing means match
  const passed = isBlockPattern ? !matchFound : matchFound;
  const message = isBlockPattern
    ? passed
      ? "Content does not match blocked regex pattern"
      : "Content matches blocked regex pattern"
    : passed
      ? "Content matches required regex pattern"
      : "Content does not match required regex pattern";

  return { rule, passed, message };
}

/**
 * Default evaluator for classifier rules.
 * Simulates ML classifier evaluation in ZK context.
 *
 * @param rule - The classifier rule to evaluate
 * @param promptHash - Hash of the prompt content
 * @param outputHash - Hash of the output content
 * @returns Evaluation result
 */
async function evaluateClassifierRule(
  rule: PolicyRule,
  promptHash: string,
  outputHash: string
): Promise<RuleEvaluationResult> {
  // In a real ZK implementation (zkML), this would run a neural network
  // classifier circuit on the content and produce a proof of the
  // classification result. This is extremely expensive and limited
  // to small models.
  // Here we simulate with deterministic hash-based classification.

  const classifierId = (rule.params.classifierId as string | undefined) ?? "default";
  const threshold = (rule.params.threshold as number | undefined) ?? 0.5;
  const target = rule.target;

  // Simulate classification score based on hash
  const hashesToClassify: string[] = [];
  if (target === "prompt" || target === "both") {
    hashesToClassify.push(promptHash);
  }
  if (target === "output" || target === "both") {
    hashesToClassify.push(outputHash);
  }

  // Deterministic "classification" based on hash bytes
  let simulatedScore = 0;
  for (const hash of hashesToClassify) {
    // Use first 4 bytes of hash as a pseudo-random score
    const hashBytes = hash.slice(0, 8);
    const numericValue = parseInt(hashBytes, 16);
    simulatedScore += (numericValue % 100) / 100;
  }
  simulatedScore = simulatedScore / hashesToClassify.length;

  const passed = simulatedScore >= threshold;
  const message = passed
    ? `Classifier '${classifierId}' score ${simulatedScore.toFixed(2)} meets threshold ${threshold}`
    : `Classifier '${classifierId}' score ${simulatedScore.toFixed(2)} below threshold ${threshold}`;

  return { rule, passed, message };
}

// =============================================================================
// POLICY COMPLIANCE PROVER
// =============================================================================

/**
 * PolicyComplianceProver generates and verifies ZK proofs of policy compliance.
 *
 * This prover evaluates content against policy rules and produces a proof
 * that the content complies (or not) without revealing the actual content.
 * Only content hashes and policy identifiers are exposed in public inputs.
 *
 * Supported rule types:
 * - blocklist: Content must not match blocked patterns
 * - allowlist: Content must match at least one allowed pattern
 * - regex: Content must (not) match a regex pattern
 * - classifier: Content must pass ML classification threshold
 *
 * @example
 * ```typescript
 * const prover = new PolicyComplianceProver();
 * const proof = await prover.generateProof(input);
 * console.log(proof.publicInputs.compliant); // true or false
 * ```
 */
export class PolicyComplianceProver {
  private readonly debug: boolean;
  private readonly evaluators: Map<string, RuleEvaluator>;

  /**
   * Create a new PolicyComplianceProver instance.
   *
   * @param options - Configuration options
   */
  constructor(options: PolicyComplianceProverOptions = {}) {
    this.debug = options.debug ?? false;

    // Initialize with default evaluators
    this.evaluators = new Map<string, RuleEvaluator>([
      ["blocklist", evaluateBlocklistRule],
      ["allowlist", evaluateAllowlistRule],
      ["regex", evaluateRegexRule],
      ["classifier", evaluateClassifierRule],
    ]);

    // Add custom evaluators if provided
    if (options.customEvaluators) {
      for (const [type, evaluator] of options.customEvaluators) {
        this.evaluators.set(type, evaluator);
      }
    }
  }

  /**
   * Generate a policy compliance proof.
   *
   * This method evaluates the content against all policy rules and generates
   * a ZK proof of the compliance result. The proof binds to the Cardano
   * anchor transaction for cross-chain verification.
   *
   * @param input - Policy compliance input
   * @returns Promise resolving to the policy proof
   * @throws MidnightProverException on validation or generation failure
   */
  async generateProof(input: PolicyInput): Promise<PolicyProof> {
    const startTime = performance.now();

    // Validate input
    this.validateInput(input);

    if (this.debug) {
      console.log("[PolicyComplianceProver] Generating proof for policy:", input.policy.id);
    }

    // Evaluate policy rules
    const evaluationResult = await this.evaluatePolicy(
      input.policy,
      input.promptHash,
      input.outputHash
    );

    // Generate proof bytes (mock implementation)
    const proofBytes = await this.generateProofBytes(input, evaluationResult);

    const endTime = performance.now();
    const provingTimeMs = Math.round(endTime - startTime);

    // Construct public inputs
    const publicInputs: PolicyPublicInputs = {
      promptHash: input.promptHash,
      policyId: input.policy.id,
      policyVersion: input.policy.version,
      compliant: evaluationResult.compliant,
      cardanoAnchorTxHash: input.cardanoAnchorTxHash,
    };

    // Generate proof ID
    const proofId = await this.generateProofId(publicInputs);

    const proof: PolicyProof = {
      proofType: "policy-compliance",
      proofId,
      proof: proofBytes,
      createdAt: new Date().toISOString(),
      provingTimeMs,
      proofSizeBytes: proofBytes.length,
      publicInputs,
    };

    if (this.debug) {
      console.log("[PolicyComplianceProver] Proof generated:", {
        proofId,
        compliant: evaluationResult.compliant,
        provingTimeMs,
        ruleCount: input.policy.rules.length,
      });
    }

    return proof;
  }

  /**
   * Verify a policy compliance proof.
   *
   * This method verifies the cryptographic validity of the proof and
   * checks that public inputs are consistent.
   *
   * @param proof - The policy proof to verify
   * @returns Promise resolving to true if valid
   */
  async verifyProof(proof: PolicyProof): Promise<boolean> {
    try {
      // Validate proof structure
      if (proof.proofType !== "policy-compliance") {
        return false;
      }

      if (!proof.proof || proof.proof.length === 0) {
        return false;
      }

      // Validate public inputs
      const { publicInputs } = proof;
      if (!publicInputs.promptHash || publicInputs.promptHash.length !== 64) {
        return false;
      }
      if (!publicInputs.policyId || publicInputs.policyId.length === 0) {
        return false;
      }
      if (!publicInputs.policyVersion || publicInputs.policyVersion.length === 0) {
        return false;
      }
      if (!publicInputs.cardanoAnchorTxHash || publicInputs.cardanoAnchorTxHash.length === 0) {
        return false;
      }
      if (typeof publicInputs.compliant !== "boolean") {
        return false;
      }

      // Verify proof ID matches public inputs
      const expectedProofId = await this.generateProofId(publicInputs);
      if (proof.proofId !== expectedProofId) {
        return false;
      }

      // Verify proof bytes contain expected structure
      // In a real implementation, this would verify the ZK proof cryptographically
      const proofValid = this.verifyProofBytes(proof.proof, publicInputs);

      return proofValid;
    } catch (error) {
      if (this.debug) {
        console.error("[PolicyComplianceProver] Verification error:", error);
      }
      return false;
    }
  }

  /**
   * Evaluate all policy rules against content.
   *
   * @param policy - The policy to evaluate
   * @param promptHash - Hash of prompt content
   * @param outputHash - Hash of output content
   * @returns Evaluation result with rule-by-rule breakdown
   */
  async evaluatePolicy(
    policy: ContentPolicy,
    promptHash: string,
    outputHash: string
  ): Promise<PolicyEvaluationResult> {
    const startTime = performance.now();
    const ruleResults: RuleEvaluationResult[] = [];

    for (const rule of policy.rules) {
      const evaluator = this.evaluators.get(rule.type);
      if (!evaluator) {
        throw new MidnightProverException(
          MidnightProverError.INVALID_INPUT,
          `Unknown rule type: ${rule.type}`
        );
      }

      const result = await evaluator(rule, promptHash, outputHash);
      ruleResults.push(result);

      if (this.debug) {
        console.log(`[PolicyComplianceProver] Rule ${rule.type}:`, result.message);
      }
    }

    const endTime = performance.now();

    // Policy is compliant only if all rules pass
    const compliant = ruleResults.every((r) => r.passed);

    return {
      compliant,
      ruleResults,
      evaluationTimeMs: Math.round(endTime - startTime),
    };
  }

  /**
   * Register a custom rule evaluator.
   *
   * @param type - Rule type identifier
   * @param evaluator - Evaluation function
   */
  registerEvaluator(type: string, evaluator: RuleEvaluator): void {
    this.evaluators.set(type, evaluator);
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  /**
   * Validate policy input.
   */
  private validateInput(input: PolicyInput): void {
    if (!input.promptHash || input.promptHash.length !== 64) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_INPUT,
        "Invalid prompt hash: must be 64-character hex string"
      );
    }

    if (!input.outputHash || input.outputHash.length !== 64) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_INPUT,
        "Invalid output hash: must be 64-character hex string"
      );
    }

    if (!input.policy) {
      throw new MidnightProverException(
        MidnightProverError.MISSING_REQUIRED_FIELD,
        "Policy is required"
      );
    }

    if (!input.policy.id || input.policy.id.length === 0) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_INPUT,
        "Policy ID is required"
      );
    }

    if (!input.policy.version || input.policy.version.length === 0) {
      throw new MidnightProverException(
        MidnightProverError.INVALID_INPUT,
        "Policy version is required"
      );
    }

    if (!input.cardanoAnchorTxHash || input.cardanoAnchorTxHash.length === 0) {
      throw new MidnightProverException(
        MidnightProverError.MISSING_REQUIRED_FIELD,
        "Cardano anchor transaction hash is required"
      );
    }
  }

  /**
   * Generate mock proof bytes.
   * In a real implementation, this would call the Midnight proof server.
   */
  private async generateProofBytes(
    input: PolicyInput,
    evaluation: PolicyEvaluationResult
  ): Promise<Uint8Array> {
    // Construct witness data (private inputs)
    const witnessData = canonicalize({
      promptHash: input.promptHash,
      outputHash: input.outputHash,
      policyId: input.policy.id,
      policyVersion: input.policy.version,
      rules: input.policy.rules,
      compliant: evaluation.compliant,
      cardanoAnchorTxHash: input.cardanoAnchorTxHash,
    });

    // Generate witness hash
    const witnessHash = await sha256StringHex(POLICY_DOMAIN_PREFIXES.witness + witnessData);

    // Construct public input commitment
    const publicInputData = canonicalize({
      promptHash: input.promptHash,
      policyId: input.policy.id,
      policyVersion: input.policy.version,
      compliant: evaluation.compliant,
      cardanoAnchorTxHash: input.cardanoAnchorTxHash,
    });
    const publicInputHash = await sha256StringHex(
      POLICY_DOMAIN_PREFIXES.publicInput + publicInputData
    );

    // Generate mock proof: commitment to witness + public inputs
    const proofCommitment = await sha256StringHex(
      POLICY_DOMAIN_PREFIXES.proof + witnessHash + "|" + publicInputHash
    );

    // Construct proof bytes: version (1 byte) + commitment (32 bytes) + witness hash (32 bytes)
    const proofBytes = new Uint8Array(65);
    proofBytes[0] = 0x01; // Version 1

    // Copy commitment hash
    const commitmentBytes = this.hexToBytes(proofCommitment);
    proofBytes.set(commitmentBytes, 1);

    // Copy witness hash
    const witnessBytes = this.hexToBytes(witnessHash);
    proofBytes.set(witnessBytes, 33);

    return proofBytes;
  }

  /**
   * Verify mock proof bytes.
   * In a real implementation, this would cryptographically verify the proof
   * against the public inputs using the ZK verifier.
   */
  private verifyProofBytes(
    proofBytes: Uint8Array,
    _publicInputs: PolicyPublicInputs
  ): boolean {
    // Check minimum proof size
    if (proofBytes.length < 65) {
      return false;
    }

    // Check version byte
    if (proofBytes[0] !== 0x01) {
      return false;
    }

    // Note: _publicInputs would be used in real ZK verification

    // Extract commitment from proof and verify structure is valid
    const commitmentBytes = proofBytes.slice(1, 33);
    const witnessHashBytes = proofBytes.slice(33, 65);

    // Verify both are non-zero (basic sanity check)
    const commitmentNonZero = commitmentBytes.some((b) => b !== 0);
    const witnessNonZero = witnessHashBytes.some((b) => b !== 0);

    return commitmentNonZero && witnessNonZero;
  }

  /**
   * Generate proof ID from public inputs.
   */
  private async generateProofId(publicInputs: PolicyPublicInputs): Promise<string> {
    const data = canonicalize({
      type: "policy-compliance",
      ...publicInputs,
    });
    const hash = await sha256StringHex(data);
    return `policy-proof-${hash.slice(0, 16)}`;
  }

  /**
   * Convert hex string to bytes.
   */
  private hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return bytes;
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a new PolicyComplianceProver instance.
 *
 * @param options - Configuration options
 * @returns New prover instance
 */
export function createPolicyComplianceProver(
  options?: PolicyComplianceProverOptions
): PolicyComplianceProver {
  return new PolicyComplianceProver(options);
}
