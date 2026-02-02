/**
 * @fileoverview Tests for PolicyComplianceProver.
 *
 * Location: packages/midnight-prover/src/__tests__/policy-compliance.test.ts
 *
 * Summary:
 * This file contains unit tests for the PolicyComplianceProver class, testing
 * proof generation, verification, and policy rule evaluation for blocklist,
 * allowlist, regex, and classifier rules.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  PolicyComplianceProver,
  createPolicyComplianceProver,
} from "../proofs/policy-compliance-proof.js";
import type {
  PolicyInput,
  ContentPolicy,
  PolicyRule,
} from "../types.js";

// =============================================================================
// TEST FIXTURES
// =============================================================================

/**
 * Generate a mock 64-character hex hash.
 */
function mockHash(seed: string): string {
  // Simple deterministic hash-like string based on seed
  let hash = "";
  for (let i = 0; i < 64; i++) {
    const charCode = seed.charCodeAt(i % seed.length) || 0;
    hash += ((charCode + i) % 16).toString(16);
  }
  return hash;
}

/**
 * Create a test policy input.
 */
function createTestPolicyInput(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    promptHash: mockHash("test-prompt"),
    outputHash: mockHash("test-output"),
    policy: {
      id: "test-policy-1",
      version: "1.0.0",
      rules: [],
    },
    cardanoAnchorTxHash: "abc123def456789012345678901234567890123456789012345678901234",
    ...overrides,
  };
}

/**
 * Create a blocklist rule.
 */
function createBlocklistRule(
  blockedHashes: string[] = [],
  target: "prompt" | "output" | "both" = "both"
): PolicyRule {
  return {
    type: "blocklist",
    target,
    params: { blockedHashes },
  };
}

/**
 * Create an allowlist rule.
 */
function createAllowlistRule(
  allowedHashes: string[] = [],
  target: "prompt" | "output" | "both" = "both"
): PolicyRule {
  return {
    type: "allowlist",
    target,
    params: { allowedHashes, requireAllMatch: false },
  };
}

/**
 * Create a regex rule.
 */
function createRegexRule(
  patternHash: string,
  isBlockPattern: boolean = true,
  target: "prompt" | "output" | "both" = "both"
): PolicyRule {
  return {
    type: "regex",
    target,
    params: { patternHash, isBlockPattern },
  };
}

/**
 * Create a classifier rule.
 */
function createClassifierRule(
  classifierId: string = "default",
  threshold: number = 0.5,
  target: "prompt" | "output" | "both" = "both"
): PolicyRule {
  return {
    type: "classifier",
    target,
    params: { classifierId, threshold, allowedCategories: [] },
  };
}

// =============================================================================
// PROVER INSTANTIATION TESTS
// =============================================================================

describe("PolicyComplianceProver instantiation", () => {
  it("creates prover with default options", () => {
    const prover = new PolicyComplianceProver();
    expect(prover).toBeInstanceOf(PolicyComplianceProver);
  });

  it("creates prover with debug option", () => {
    const prover = new PolicyComplianceProver({ debug: true });
    expect(prover).toBeInstanceOf(PolicyComplianceProver);
  });

  it("creates prover using factory function", () => {
    const prover = createPolicyComplianceProver();
    expect(prover).toBeInstanceOf(PolicyComplianceProver);
  });

  it("creates prover with custom evaluators", () => {
    const customEvaluators = new Map<string, (rule: PolicyRule, p: string, o: string) => Promise<{ rule: PolicyRule; passed: boolean; message: string }>>([
      ["custom", async (rule, _p, _o) => ({ rule, passed: true, message: "Custom rule passed" })],
    ]);

    const prover = new PolicyComplianceProver({ customEvaluators });
    expect(prover).toBeInstanceOf(PolicyComplianceProver);
  });
});

// =============================================================================
// PROOF GENERATION TESTS
// =============================================================================

describe("PolicyComplianceProver.generateProof", () => {
  let prover: PolicyComplianceProver;

  beforeEach(() => {
    prover = new PolicyComplianceProver();
  });

  it("generates proof for policy with no rules (compliant)", async () => {
    const input = createTestPolicyInput();
    const proof = await prover.generateProof(input);

    expect(proof.proofType).toBe("policy-compliance");
    expect(proof.proofId).toMatch(/^policy-proof-/);
    expect(proof.proof).toBeInstanceOf(Uint8Array);
    expect(proof.proof.length).toBe(65);
    expect(proof.publicInputs.compliant).toBe(true);
    expect(proof.publicInputs.promptHash).toBe(input.promptHash);
    expect(proof.publicInputs.policyId).toBe(input.policy.id);
    expect(proof.publicInputs.policyVersion).toBe(input.policy.version);
    expect(proof.publicInputs.cardanoAnchorTxHash).toBe(input.cardanoAnchorTxHash);
    expect(proof.provingTimeMs).toBeGreaterThanOrEqual(0);
    expect(proof.proofSizeBytes).toBe(65);
    expect(proof.createdAt).toBeDefined();
  });

  it("generates proof with blocklist rule (compliant)", async () => {
    const input = createTestPolicyInput({
      policy: {
        id: "blocklist-policy",
        version: "1.0.0",
        rules: [createBlocklistRule(["blocked-hash-1", "blocked-hash-2"])],
      },
    });

    const proof = await prover.generateProof(input);
    expect(proof.publicInputs.compliant).toBe(true);
  });

  it("generates proof with blocklist rule (non-compliant)", async () => {
    const promptHash = mockHash("test-prompt");
    const input = createTestPolicyInput({
      promptHash,
      policy: {
        id: "blocklist-policy",
        version: "1.0.0",
        rules: [createBlocklistRule([promptHash])], // Block the actual prompt hash
      },
    });

    const proof = await prover.generateProof(input);
    expect(proof.publicInputs.compliant).toBe(false);
  });

  it("generates proof with allowlist rule (empty list is permissive)", async () => {
    const input = createTestPolicyInput({
      policy: {
        id: "allowlist-policy",
        version: "1.0.0",
        rules: [createAllowlistRule([])],
      },
    });

    const proof = await prover.generateProof(input);
    expect(proof.publicInputs.compliant).toBe(true);
  });

  it("generates proof with regex rule (compliant - no match)", async () => {
    const input = createTestPolicyInput({
      policy: {
        id: "regex-policy",
        version: "1.0.0",
        rules: [createRegexRule("different-pattern", true)],
      },
    });

    const proof = await prover.generateProof(input);
    expect(proof.publicInputs.compliant).toBe(true);
  });

  it("generates proof with classifier rule", async () => {
    const input = createTestPolicyInput({
      policy: {
        id: "classifier-policy",
        version: "1.0.0",
        rules: [createClassifierRule("safety-classifier", 0.3)],
      },
    });

    const proof = await prover.generateProof(input);
    // Classifier result depends on hash-based simulation
    expect(typeof proof.publicInputs.compliant).toBe("boolean");
  });

  it("generates proof with multiple rules", async () => {
    const input = createTestPolicyInput({
      policy: {
        id: "multi-rule-policy",
        version: "1.0.0",
        rules: [
          createBlocklistRule(["bad-hash-1"]),
          createAllowlistRule([]),
          createClassifierRule("content-filter", 0.2),
        ],
      },
    });

    const proof = await prover.generateProof(input);
    expect(proof.proofType).toBe("policy-compliance");
    expect(typeof proof.publicInputs.compliant).toBe("boolean");
  });

  it("requires all rules to pass for compliance", async () => {
    const promptHash = mockHash("test-prompt");
    const input = createTestPolicyInput({
      promptHash,
      policy: {
        id: "strict-policy",
        version: "1.0.0",
        rules: [
          createBlocklistRule([]), // Passes
          createBlocklistRule([promptHash]), // Fails
        ],
      },
    });

    const proof = await prover.generateProof(input);
    expect(proof.publicInputs.compliant).toBe(false);
  });
});

// =============================================================================
// INPUT VALIDATION TESTS
// =============================================================================

describe("PolicyComplianceProver input validation", () => {
  let prover: PolicyComplianceProver;

  beforeEach(() => {
    prover = new PolicyComplianceProver();
  });

  it("rejects invalid prompt hash (too short)", async () => {
    const input = createTestPolicyInput({ promptHash: "abc123" });
    await expect(prover.generateProof(input)).rejects.toThrow(/Invalid prompt hash/);
  });

  it("rejects invalid output hash (too short)", async () => {
    const input = createTestPolicyInput({ outputHash: "def456" });
    await expect(prover.generateProof(input)).rejects.toThrow(/Invalid output hash/);
  });

  it("rejects missing policy ID", async () => {
    const input = createTestPolicyInput({
      policy: { id: "", version: "1.0.0", rules: [] },
    });
    await expect(prover.generateProof(input)).rejects.toThrow(/Policy ID is required/);
  });

  it("rejects missing policy version", async () => {
    const input = createTestPolicyInput({
      policy: { id: "test", version: "", rules: [] },
    });
    await expect(prover.generateProof(input)).rejects.toThrow(/Policy version is required/);
  });

  it("rejects missing Cardano anchor hash", async () => {
    const input = createTestPolicyInput({ cardanoAnchorTxHash: "" });
    await expect(prover.generateProof(input)).rejects.toThrow(/Cardano anchor transaction hash is required/);
  });

  it("rejects unknown rule type", async () => {
    const input = createTestPolicyInput({
      policy: {
        id: "test",
        version: "1.0.0",
        rules: [{ type: "unknown" as "blocklist", target: "both", params: {} }],
      },
    });
    await expect(prover.generateProof(input)).rejects.toThrow(/Unknown rule type/);
  });
});

// =============================================================================
// PROOF VERIFICATION TESTS
// =============================================================================

describe("PolicyComplianceProver.verifyProof", () => {
  let prover: PolicyComplianceProver;

  beforeEach(() => {
    prover = new PolicyComplianceProver();
  });

  it("verifies a valid proof", async () => {
    const input = createTestPolicyInput();
    const proof = await prover.generateProof(input);
    const isValid = await prover.verifyProof(proof);
    expect(isValid).toBe(true);
  });

  it("verifies compliant proof", async () => {
    const input = createTestPolicyInput({
      policy: {
        id: "safe-policy",
        version: "1.0.0",
        rules: [createBlocklistRule([])],
      },
    });

    const proof = await prover.generateProof(input);
    expect(proof.publicInputs.compliant).toBe(true);
    expect(await prover.verifyProof(proof)).toBe(true);
  });

  it("verifies non-compliant proof", async () => {
    const promptHash = mockHash("test-prompt");
    const input = createTestPolicyInput({
      promptHash,
      policy: {
        id: "strict-policy",
        version: "1.0.0",
        rules: [createBlocklistRule([promptHash])],
      },
    });

    const proof = await prover.generateProof(input);
    expect(proof.publicInputs.compliant).toBe(false);
    expect(await prover.verifyProof(proof)).toBe(true);
  });

  it("rejects proof with wrong type", async () => {
    const input = createTestPolicyInput();
    const proof = await prover.generateProof(input);
    (proof as { proofType: string }).proofType = "hash-chain";
    expect(await prover.verifyProof(proof)).toBe(false);
  });

  it("rejects proof with empty proof bytes", async () => {
    const input = createTestPolicyInput();
    const proof = await prover.generateProof(input);
    proof.proof = new Uint8Array(0);
    expect(await prover.verifyProof(proof)).toBe(false);
  });

  it("rejects proof with tampered proof ID", async () => {
    const input = createTestPolicyInput();
    const proof = await prover.generateProof(input);
    proof.proofId = "tampered-proof-id";
    expect(await prover.verifyProof(proof)).toBe(false);
  });

  it("rejects proof with invalid prompt hash", async () => {
    const input = createTestPolicyInput();
    const proof = await prover.generateProof(input);
    proof.publicInputs.promptHash = "short";
    expect(await prover.verifyProof(proof)).toBe(false);
  });

  it("rejects proof with wrong version byte", async () => {
    const input = createTestPolicyInput();
    const proof = await prover.generateProof(input);
    proof.proof[0] = 0x99; // Wrong version
    // Still passes because we regenerate proof ID check
    const isValid = await prover.verifyProof(proof);
    expect(isValid).toBe(false);
  });
});

// =============================================================================
// POLICY EVALUATION TESTS
// =============================================================================

describe("PolicyComplianceProver.evaluatePolicy", () => {
  let prover: PolicyComplianceProver;

  beforeEach(() => {
    prover = new PolicyComplianceProver();
  });

  it("evaluates empty policy as compliant", async () => {
    const policy: ContentPolicy = { id: "empty", version: "1.0.0", rules: [] };
    const result = await prover.evaluatePolicy(policy, mockHash("prompt"), mockHash("output"));

    expect(result.compliant).toBe(true);
    expect(result.ruleResults).toHaveLength(0);
    expect(result.evaluationTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("evaluates blocklist rule targeting prompt only", async () => {
    const promptHash = mockHash("blocked-prompt");
    const policy: ContentPolicy = {
      id: "prompt-blocklist",
      version: "1.0.0",
      rules: [createBlocklistRule([promptHash], "prompt")],
    };

    const result = await prover.evaluatePolicy(policy, promptHash, mockHash("safe-output"));
    expect(result.compliant).toBe(false);
    expect(result.ruleResults[0]?.passed).toBe(false);
  });

  it("evaluates blocklist rule targeting output only", async () => {
    const outputHash = mockHash("blocked-output");
    const policy: ContentPolicy = {
      id: "output-blocklist",
      version: "1.0.0",
      rules: [createBlocklistRule([outputHash], "output")],
    };

    const result = await prover.evaluatePolicy(policy, mockHash("safe-prompt"), outputHash);
    expect(result.compliant).toBe(false);
    expect(result.ruleResults[0]?.passed).toBe(false);
  });

  it("evaluates multiple rules returning all results", async () => {
    const policy: ContentPolicy = {
      id: "multi-rule",
      version: "1.0.0",
      rules: [
        createBlocklistRule([]),
        createAllowlistRule([]),
        createClassifierRule("test", 0.2),
      ],
    };

    const result = await prover.evaluatePolicy(policy, mockHash("prompt"), mockHash("output"));
    expect(result.ruleResults).toHaveLength(3);
    expect(result.ruleResults[0]?.rule.type).toBe("blocklist");
    expect(result.ruleResults[1]?.rule.type).toBe("allowlist");
    expect(result.ruleResults[2]?.rule.type).toBe("classifier");
  });
});

// =============================================================================
// CUSTOM EVALUATOR TESTS
// =============================================================================

describe("PolicyComplianceProver custom evaluators", () => {
  it("uses registered custom evaluator", async () => {
    const prover = new PolicyComplianceProver();

    prover.registerEvaluator("custom-check", async (rule, _p, _o) => ({
      rule,
      passed: true,
      message: "Custom check passed",
    }));

    const input = createTestPolicyInput({
      policy: {
        id: "custom-policy",
        version: "1.0.0",
        rules: [{ type: "custom-check" as "blocklist", target: "both", params: {} }],
      },
    });

    const proof = await prover.generateProof(input);
    expect(proof.publicInputs.compliant).toBe(true);
  });

  it("custom evaluator can fail compliance", async () => {
    const prover = new PolicyComplianceProver();

    prover.registerEvaluator("always-fail", async (rule, _p, _o) => ({
      rule,
      passed: false,
      message: "Always fails",
    }));

    const input = createTestPolicyInput({
      policy: {
        id: "fail-policy",
        version: "1.0.0",
        rules: [{ type: "always-fail" as "blocklist", target: "both", params: {} }],
      },
    });

    const proof = await prover.generateProof(input);
    expect(proof.publicInputs.compliant).toBe(false);
  });
});

// =============================================================================
// PROOF METRICS TESTS
// =============================================================================

describe("PolicyComplianceProver proof metrics", () => {
  let prover: PolicyComplianceProver;

  beforeEach(() => {
    prover = new PolicyComplianceProver();
  });

  it("includes proving time in proof", async () => {
    const input = createTestPolicyInput();
    const proof = await prover.generateProof(input);

    expect(proof.provingTimeMs).toBeGreaterThanOrEqual(0);
    expect(proof.provingTimeMs).toBeLessThan(10000); // Should be fast for mock
  });

  it("includes proof size in proof", async () => {
    const input = createTestPolicyInput();
    const proof = await prover.generateProof(input);

    expect(proof.proofSizeBytes).toBe(proof.proof.length);
    expect(proof.proofSizeBytes).toBe(65); // Version + commitment + witness hash
  });

  it("includes creation timestamp in proof", async () => {
    const beforeTime = new Date().toISOString();
    const input = createTestPolicyInput();
    const proof = await prover.generateProof(input);
    const afterTime = new Date().toISOString();

    expect(proof.createdAt).toBeDefined();
    expect(proof.createdAt >= beforeTime).toBe(true);
    expect(proof.createdAt <= afterTime).toBe(true);
  });
});
