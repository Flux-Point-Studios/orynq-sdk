/**
 * @fileoverview Unit tests for safety proof generators.
 *
 * Location: packages/midnight-prover/src/__tests__/safety-proofs.test.ts
 *
 * Summary:
 * Tests for the EvalAwarenessProver, CovertChannelProver, and MonitorComplianceProver
 * classes. Covers proof generation, verification, input validation, type guards,
 * and public inputs binding correctness.
 *
 * Usage:
 * Run with: pnpm test -- packages/midnight-prover
 *
 * Related files:
 * - proofs/eval-awareness-proof.ts: EvalAwarenessProver implementation
 * - proofs/covert-channel-proof.ts: CovertChannelProver implementation
 * - proofs/monitor-compliance-proof.ts: MonitorComplianceProver implementation
 * - types.ts: Type definitions and type guards
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  EvalAwarenessProver,
  createEvalAwarenessProver,
} from "../proofs/eval-awareness-proof.js";

import {
  CovertChannelProver,
  createCovertChannelProver,
} from "../proofs/covert-channel-proof.js";

import {
  MonitorComplianceProver,
  createMonitorComplianceProver,
} from "../proofs/monitor-compliance-proof.js";

import {
  MidnightProverError,
  MidnightProverException,
  isEvalAwarenessProof,
  isCovertChannelProof,
  isMonitorComplianceProof,
  isHashChainProof,
} from "../types.js";

import type {
  EvalAwarenessInput,
  EvalAwarenessProof,
  CovertChannelInput,
  CovertChannelProof,
  MonitorComplianceInput,
  MonitorComplianceProof,
  AnyProof,
} from "../types.js";

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create a valid 64-character hex hash for testing.
 */
function createMockHash(seed: string): string {
  const hex = "0123456789abcdef";
  let result = "";
  for (let i = 0; i < 64; i++) {
    result += hex[(seed.charCodeAt(i % seed.length) + i) % 16];
  }
  return result;
}

/**
 * Create a valid EvalAwarenessInput for testing.
 */
function createEvalAwarenessInput(overrides: Partial<EvalAwarenessInput> = {}): EvalAwarenessInput {
  return {
    baseRootHash: createMockHash("base-root"),
    eaiScore: 0.87,
    threshold: 0.75,
    eaiMethodHash: createMockHash("eai-method"),
    probeSetVersionHash: createMockHash("probe-set"),
    wrapperTemplatesHash: createMockHash("wrapper-templates"),
    scoringWeightsHash: createMockHash("scoring-weights"),
    thresholdPolicyId: "policy-safety-v1",
    cardanoAnchorTxHash: createMockHash("anchor-tx"),
    ...overrides,
  };
}

/**
 * Create a valid CovertChannelInput for testing.
 */
function createCovertChannelInput(overrides: Partial<CovertChannelInput> = {}): CovertChannelInput {
  return {
    baseRootHash: createMockHash("base-root"),
    detectorScore: 0.92,
    threshold: 0.80,
    detectorConfigHash: createMockHash("detector-config"),
    cardanoAnchorTxHash: createMockHash("anchor-tx"),
    ...overrides,
  };
}

/**
 * Create a valid MonitorComplianceInput for testing.
 */
function createMonitorComplianceInput(
  overrides: Partial<MonitorComplianceInput> = {}
): MonitorComplianceInput {
  return {
    baseRootHash: createMockHash("base-root"),
    monitorConfigHash: createMockHash("monitor-config"),
    monitorResults: [
      { monitorId: "toxicity", ran: true },
      { monitorId: "bias", ran: true },
      { monitorId: "hallucination", ran: true },
    ],
    cardanoAnchorTxHash: createMockHash("anchor-tx"),
    ...overrides,
  };
}

// =============================================================================
// EVAL AWARENESS PROVER TESTS
// =============================================================================

describe("EvalAwarenessProver", () => {
  let prover: EvalAwarenessProver;

  beforeEach(() => {
    prover = new EvalAwarenessProver({
      simulatedProvingTimeMs: 0,
      debug: false,
    });
  });

  describe("constructor", () => {
    it("should create a prover with default options", () => {
      const defaultProver = new EvalAwarenessProver();
      expect(defaultProver).toBeInstanceOf(EvalAwarenessProver);
    });

    it("should create a prover with custom options", () => {
      const customProver = new EvalAwarenessProver({
        debug: true,
        simulatedProvingTimeMs: 50,
      });
      expect(customProver).toBeInstanceOf(EvalAwarenessProver);
    });
  });

  describe("generateProof", () => {
    it("should generate a valid proof when score exceeds threshold", async () => {
      const input = createEvalAwarenessInput({ eaiScore: 0.90, threshold: 0.75 });
      const proof = await prover.generateProof(input);

      expect(proof).toBeDefined();
      expect(proof.proofType).toBe("eval-awareness");
      expect(proof.proofId).toMatch(/^[0-9a-f-]{36}$/);
      expect(proof.proof).toBeInstanceOf(Uint8Array);
      expect(proof.proof.length).toBeGreaterThan(0);
      expect(proof.createdAt).toBeDefined();
      expect(proof.provingTimeMs).toBeGreaterThanOrEqual(0);
      expect(proof.proofSizeBytes).toBe(proof.proof.length);

      // Check public inputs
      expect(proof.publicInputs.eaiScoreExceedsT).toBe(true);
      expect(proof.publicInputs.thresholdT).toBe(0.75);
      expect(proof.publicInputs.baseRootHash).toBe(createMockHash("base-root").toLowerCase());
      expect(proof.publicInputs.eaiMethodHash).toBe(createMockHash("eai-method").toLowerCase());
    });

    it("should generate a proof when score does not exceed threshold", async () => {
      const input = createEvalAwarenessInput({ eaiScore: 0.50, threshold: 0.75 });
      const proof = await prover.generateProof(input);

      expect(proof.publicInputs.eaiScoreExceedsT).toBe(false);
    });

    it("should generate a proof when score equals threshold", async () => {
      const input = createEvalAwarenessInput({ eaiScore: 0.75, threshold: 0.75 });
      const proof = await prover.generateProof(input);

      expect(proof.publicInputs.eaiScoreExceedsT).toBe(true);
    });

    it("should throw for invalid baseRootHash format", async () => {
      const input = createEvalAwarenessInput({ baseRootHash: "invalid-hash" });

      await expect(prover.generateProof(input)).rejects.toThrow(MidnightProverException);

      try {
        await prover.generateProof(input);
      } catch (e) {
        expect((e as MidnightProverException).code).toBe(MidnightProverError.INVALID_EAI_INPUT);
      }
    });

    it("should throw for invalid eaiMethodHash format", async () => {
      const input = createEvalAwarenessInput({ eaiMethodHash: "bad" });

      await expect(prover.generateProof(input)).rejects.toThrow(MidnightProverException);
    });

    it("should throw for NaN eaiScore", async () => {
      const input = createEvalAwarenessInput({ eaiScore: NaN });

      await expect(prover.generateProof(input)).rejects.toThrow(MidnightProverException);
    });

    it("should throw for NaN threshold", async () => {
      const input = createEvalAwarenessInput({ threshold: NaN });

      await expect(prover.generateProof(input)).rejects.toThrow(MidnightProverException);
    });

    it("should normalize hashes to lowercase without 0x prefix", async () => {
      const input = createEvalAwarenessInput({
        baseRootHash: "0x" + createMockHash("base-root").toUpperCase(),
        cardanoAnchorTxHash: "0x" + createMockHash("anchor-tx").toUpperCase(),
      });

      const proof = await prover.generateProof(input);

      expect(proof.publicInputs.baseRootHash).not.toContain("0x");
      expect(proof.publicInputs.baseRootHash).toBe(
        proof.publicInputs.baseRootHash.toLowerCase()
      );
    });
  });

  describe("verifyProof", () => {
    it("should verify a valid proof", async () => {
      const input = createEvalAwarenessInput();
      const proof = await prover.generateProof(input);
      const isValid = await prover.verifyProof(proof);

      expect(isValid).toBe(true);
    });

    it("should reject proof with wrong proof type", async () => {
      const input = createEvalAwarenessInput();
      const proof = await prover.generateProof(input);

      const tamperedProof = {
        ...proof,
        proofType: "hash-chain" as const,
      };

      const isValid = await prover.verifyProof(tamperedProof as unknown as EvalAwarenessProof);
      expect(isValid).toBe(false);
    });

    it("should reject proof with empty proof data", async () => {
      const input = createEvalAwarenessInput();
      const proof = await prover.generateProof(input);

      const tamperedProof: EvalAwarenessProof = {
        ...proof,
        proof: new Uint8Array(0),
      };

      const isValid = await prover.verifyProof(tamperedProof);
      expect(isValid).toBe(false);
    });

    it("should reject proof with invalid public inputs hash format", async () => {
      const input = createEvalAwarenessInput();
      const proof = await prover.generateProof(input);

      const tamperedProof: EvalAwarenessProof = {
        ...proof,
        publicInputs: {
          ...proof.publicInputs,
          baseRootHash: "not-a-valid-hash",
        },
      };

      const isValid = await prover.verifyProof(tamperedProof);
      expect(isValid).toBe(false);
    });
  });

  describe("factory function", () => {
    it("should create a prover instance via factory", () => {
      const prover = createEvalAwarenessProver();
      expect(prover).toBeInstanceOf(EvalAwarenessProver);
    });

    it("should accept options via factory", () => {
      const prover = createEvalAwarenessProver({ debug: true });
      expect(prover).toBeInstanceOf(EvalAwarenessProver);
    });
  });
});

// =============================================================================
// COVERT CHANNEL PROVER TESTS
// =============================================================================

describe("CovertChannelProver", () => {
  let prover: CovertChannelProver;

  beforeEach(() => {
    prover = new CovertChannelProver({
      simulatedProvingTimeMs: 0,
      debug: false,
    });
  });

  describe("constructor", () => {
    it("should create a prover with default options", () => {
      const defaultProver = new CovertChannelProver();
      expect(defaultProver).toBeInstanceOf(CovertChannelProver);
    });
  });

  describe("generateProof", () => {
    it("should generate a valid proof when score exceeds threshold", async () => {
      const input = createCovertChannelInput({ detectorScore: 0.95, threshold: 0.80 });
      const proof = await prover.generateProof(input);

      expect(proof).toBeDefined();
      expect(proof.proofType).toBe("covert-channel");
      expect(proof.proofId).toMatch(/^[0-9a-f-]{36}$/);
      expect(proof.proof).toBeInstanceOf(Uint8Array);
      expect(proof.proof.length).toBeGreaterThan(0);

      // Check public inputs
      expect(proof.publicInputs.detectorScoreExceedsS).toBe(true);
      expect(proof.publicInputs.thresholdS).toBe(0.80);
      expect(proof.publicInputs.baseRootHash).toBe(createMockHash("base-root").toLowerCase());
      expect(proof.publicInputs.detectorConfigHash).toBe(
        createMockHash("detector-config").toLowerCase()
      );
    });

    it("should generate a proof when score does not exceed threshold", async () => {
      const input = createCovertChannelInput({ detectorScore: 0.50, threshold: 0.80 });
      const proof = await prover.generateProof(input);

      expect(proof.publicInputs.detectorScoreExceedsS).toBe(false);
    });

    it("should generate a proof when score equals threshold", async () => {
      const input = createCovertChannelInput({ detectorScore: 0.80, threshold: 0.80 });
      const proof = await prover.generateProof(input);

      expect(proof.publicInputs.detectorScoreExceedsS).toBe(true);
    });

    it("should throw for invalid baseRootHash format", async () => {
      const input = createCovertChannelInput({ baseRootHash: "invalid" });

      await expect(prover.generateProof(input)).rejects.toThrow(MidnightProverException);

      try {
        await prover.generateProof(input);
      } catch (e) {
        expect((e as MidnightProverException).code).toBe(
          MidnightProverError.INVALID_CHANNEL_INPUT
        );
      }
    });

    it("should throw for invalid detectorConfigHash format", async () => {
      const input = createCovertChannelInput({ detectorConfigHash: "bad" });

      await expect(prover.generateProof(input)).rejects.toThrow(MidnightProverException);
    });

    it("should throw for NaN detectorScore", async () => {
      const input = createCovertChannelInput({ detectorScore: NaN });

      await expect(prover.generateProof(input)).rejects.toThrow(MidnightProverException);
    });

    it("should bind cardanoAnchorTxHash in public inputs", async () => {
      const anchorHash = createMockHash("unique-anchor");
      const input = createCovertChannelInput({ cardanoAnchorTxHash: anchorHash });
      const proof = await prover.generateProof(input);

      expect(proof.publicInputs.cardanoAnchorTxHash).toBe(anchorHash.toLowerCase());
    });
  });

  describe("verifyProof", () => {
    it("should verify a valid proof", async () => {
      const input = createCovertChannelInput();
      const proof = await prover.generateProof(input);
      const isValid = await prover.verifyProof(proof);

      expect(isValid).toBe(true);
    });

    it("should reject proof with wrong proof type", async () => {
      const input = createCovertChannelInput();
      const proof = await prover.generateProof(input);

      const tamperedProof = {
        ...proof,
        proofType: "hash-chain" as const,
      };

      const isValid = await prover.verifyProof(tamperedProof as unknown as CovertChannelProof);
      expect(isValid).toBe(false);
    });

    it("should reject proof with empty proof data", async () => {
      const input = createCovertChannelInput();
      const proof = await prover.generateProof(input);

      const tamperedProof: CovertChannelProof = {
        ...proof,
        proof: new Uint8Array(0),
      };

      const isValid = await prover.verifyProof(tamperedProof);
      expect(isValid).toBe(false);
    });
  });

  describe("factory function", () => {
    it("should create a prover instance via factory", () => {
      const prover = createCovertChannelProver();
      expect(prover).toBeInstanceOf(CovertChannelProver);
    });
  });
});

// =============================================================================
// MONITOR COMPLIANCE PROVER TESTS
// =============================================================================

describe("MonitorComplianceProver", () => {
  let prover: MonitorComplianceProver;

  beforeEach(() => {
    prover = new MonitorComplianceProver({
      simulatedProvingTimeMs: 0,
      debug: false,
    });
  });

  describe("constructor", () => {
    it("should create a prover with default options", () => {
      const defaultProver = new MonitorComplianceProver();
      expect(defaultProver).toBeInstanceOf(MonitorComplianceProver);
    });
  });

  describe("generateProof", () => {
    it("should generate a valid proof when all monitors ran", async () => {
      const input = createMonitorComplianceInput();
      const proof = await prover.generateProof(input);

      expect(proof).toBeDefined();
      expect(proof.proofType).toBe("monitor-compliance");
      expect(proof.proofId).toMatch(/^[0-9a-f-]{36}$/);
      expect(proof.proof).toBeInstanceOf(Uint8Array);
      expect(proof.proof.length).toBeGreaterThan(0);

      // Check public inputs
      expect(proof.publicInputs.allRequiredMonitorsRan).toBe(true);
      expect(proof.publicInputs.monitorCount).toBe(3);
      expect(proof.publicInputs.baseRootHash).toBe(createMockHash("base-root").toLowerCase());
      expect(proof.publicInputs.monitorConfigHash).toBe(
        createMockHash("monitor-config").toLowerCase()
      );
    });

    it("should generate a proof when some monitors did not run", async () => {
      const input = createMonitorComplianceInput({
        monitorResults: [
          { monitorId: "toxicity", ran: true },
          { monitorId: "bias", ran: false },
          { monitorId: "hallucination", ran: true },
        ],
      });
      const proof = await prover.generateProof(input);

      expect(proof.publicInputs.allRequiredMonitorsRan).toBe(false);
      expect(proof.publicInputs.monitorCount).toBe(3);
    });

    it("should generate a proof for a single monitor", async () => {
      const input = createMonitorComplianceInput({
        monitorResults: [{ monitorId: "toxicity", ran: true }],
      });
      const proof = await prover.generateProof(input);

      expect(proof.publicInputs.allRequiredMonitorsRan).toBe(true);
      expect(proof.publicInputs.monitorCount).toBe(1);
    });

    it("should throw for empty monitorResults array", async () => {
      const input = createMonitorComplianceInput({ monitorResults: [] });

      await expect(prover.generateProof(input)).rejects.toThrow(MidnightProverException);

      try {
        await prover.generateProof(input);
      } catch (e) {
        expect((e as MidnightProverException).code).toBe(
          MidnightProverError.INVALID_COMPLIANCE_INPUT
        );
      }
    });

    it("should throw for invalid baseRootHash format", async () => {
      const input = createMonitorComplianceInput({ baseRootHash: "invalid" });

      await expect(prover.generateProof(input)).rejects.toThrow(MidnightProverException);
    });

    it("should throw for invalid monitorConfigHash format", async () => {
      const input = createMonitorComplianceInput({ monitorConfigHash: "bad" });

      await expect(prover.generateProof(input)).rejects.toThrow(MidnightProverException);
    });

    it("should throw for monitor result with empty monitorId", async () => {
      const input = createMonitorComplianceInput({
        monitorResults: [{ monitorId: "", ran: true }],
      });

      await expect(prover.generateProof(input)).rejects.toThrow(MidnightProverException);
    });

    it("should bind cardanoAnchorTxHash in public inputs", async () => {
      const anchorHash = createMockHash("unique-anchor");
      const input = createMonitorComplianceInput({ cardanoAnchorTxHash: anchorHash });
      const proof = await prover.generateProof(input);

      expect(proof.publicInputs.cardanoAnchorTxHash).toBe(anchorHash.toLowerCase());
    });
  });

  describe("verifyProof", () => {
    it("should verify a valid proof", async () => {
      const input = createMonitorComplianceInput();
      const proof = await prover.generateProof(input);
      const isValid = await prover.verifyProof(proof);

      expect(isValid).toBe(true);
    });

    it("should reject proof with wrong proof type", async () => {
      const input = createMonitorComplianceInput();
      const proof = await prover.generateProof(input);

      const tamperedProof = {
        ...proof,
        proofType: "hash-chain" as const,
      };

      const isValid = await prover.verifyProof(
        tamperedProof as unknown as MonitorComplianceProof
      );
      expect(isValid).toBe(false);
    });

    it("should reject proof with empty proof data", async () => {
      const input = createMonitorComplianceInput();
      const proof = await prover.generateProof(input);

      const tamperedProof: MonitorComplianceProof = {
        ...proof,
        proof: new Uint8Array(0),
      };

      const isValid = await prover.verifyProof(tamperedProof);
      expect(isValid).toBe(false);
    });

    it("should reject proof with invalid monitorCount", async () => {
      const input = createMonitorComplianceInput();
      const proof = await prover.generateProof(input);

      const tamperedProof: MonitorComplianceProof = {
        ...proof,
        publicInputs: {
          ...proof.publicInputs,
          monitorCount: -1,
        },
      };

      const isValid = await prover.verifyProof(tamperedProof);
      expect(isValid).toBe(false);
    });
  });

  describe("factory function", () => {
    it("should create a prover instance via factory", () => {
      const prover = createMonitorComplianceProver();
      expect(prover).toBeInstanceOf(MonitorComplianceProver);
    });
  });
});

// =============================================================================
// TYPE GUARD TESTS
// =============================================================================

describe("Safety Proof Type Guards", () => {
  it("isEvalAwarenessProof should return true for eval-awareness proof", async () => {
    const prover = new EvalAwarenessProver({ simulatedProvingTimeMs: 0 });
    const proof = await prover.generateProof(createEvalAwarenessInput());

    expect(isEvalAwarenessProof(proof)).toBe(true);
    expect(isCovertChannelProof(proof as unknown as AnyProof)).toBe(false);
    expect(isMonitorComplianceProof(proof as unknown as AnyProof)).toBe(false);
    expect(isHashChainProof(proof as unknown as AnyProof)).toBe(false);
  });

  it("isCovertChannelProof should return true for covert-channel proof", async () => {
    const prover = new CovertChannelProver({ simulatedProvingTimeMs: 0 });
    const proof = await prover.generateProof(createCovertChannelInput());

    expect(isCovertChannelProof(proof)).toBe(true);
    expect(isEvalAwarenessProof(proof as unknown as AnyProof)).toBe(false);
    expect(isMonitorComplianceProof(proof as unknown as AnyProof)).toBe(false);
    expect(isHashChainProof(proof as unknown as AnyProof)).toBe(false);
  });

  it("isMonitorComplianceProof should return true for monitor-compliance proof", async () => {
    const prover = new MonitorComplianceProver({ simulatedProvingTimeMs: 0 });
    const proof = await prover.generateProof(createMonitorComplianceInput());

    expect(isMonitorComplianceProof(proof)).toBe(true);
    expect(isEvalAwarenessProof(proof as unknown as AnyProof)).toBe(false);
    expect(isCovertChannelProof(proof as unknown as AnyProof)).toBe(false);
    expect(isHashChainProof(proof as unknown as AnyProof)).toBe(false);
  });
});

// =============================================================================
// PUBLIC INPUTS BINDING TESTS
// =============================================================================

describe("Safety Proof Public Inputs Binding", () => {
  it("eval-awareness proof should bind baseRootHash and eaiMethodHash", async () => {
    const prover = new EvalAwarenessProver({ simulatedProvingTimeMs: 0 });
    const baseRootHash = createMockHash("specific-root");
    const eaiMethodHash = createMockHash("specific-method");

    const proof = await prover.generateProof(
      createEvalAwarenessInput({ baseRootHash, eaiMethodHash })
    );

    expect(proof.publicInputs.baseRootHash).toBe(baseRootHash.toLowerCase());
    expect(proof.publicInputs.eaiMethodHash).toBe(eaiMethodHash.toLowerCase());
  });

  it("covert-channel proof should bind baseRootHash and detectorConfigHash", async () => {
    const prover = new CovertChannelProver({ simulatedProvingTimeMs: 0 });
    const baseRootHash = createMockHash("specific-root");
    const detectorConfigHash = createMockHash("specific-config");

    const proof = await prover.generateProof(
      createCovertChannelInput({ baseRootHash, detectorConfigHash })
    );

    expect(proof.publicInputs.baseRootHash).toBe(baseRootHash.toLowerCase());
    expect(proof.publicInputs.detectorConfigHash).toBe(detectorConfigHash.toLowerCase());
  });

  it("monitor-compliance proof should bind baseRootHash and monitorConfigHash", async () => {
    const prover = new MonitorComplianceProver({ simulatedProvingTimeMs: 0 });
    const baseRootHash = createMockHash("specific-root");
    const monitorConfigHash = createMockHash("specific-config");

    const proof = await prover.generateProof(
      createMonitorComplianceInput({ baseRootHash, monitorConfigHash })
    );

    expect(proof.publicInputs.baseRootHash).toBe(baseRootHash.toLowerCase());
    expect(proof.publicInputs.monitorConfigHash).toBe(monitorConfigHash.toLowerCase());
  });

  it("all safety proofs should bind cardanoAnchorTxHash", async () => {
    const anchorHash = createMockHash("shared-anchor");

    const eaProver = new EvalAwarenessProver({ simulatedProvingTimeMs: 0 });
    const eaProof = await eaProver.generateProof(
      createEvalAwarenessInput({ cardanoAnchorTxHash: anchorHash })
    );
    expect(eaProof.publicInputs.cardanoAnchorTxHash).toBe(anchorHash.toLowerCase());

    const ccProver = new CovertChannelProver({ simulatedProvingTimeMs: 0 });
    const ccProof = await ccProver.generateProof(
      createCovertChannelInput({ cardanoAnchorTxHash: anchorHash })
    );
    expect(ccProof.publicInputs.cardanoAnchorTxHash).toBe(anchorHash.toLowerCase());

    const mcProver = new MonitorComplianceProver({ simulatedProvingTimeMs: 0 });
    const mcProof = await mcProver.generateProof(
      createMonitorComplianceInput({ cardanoAnchorTxHash: anchorHash })
    );
    expect(mcProof.publicInputs.cardanoAnchorTxHash).toBe(anchorHash.toLowerCase());
  });

  it("different inputs should produce different proofs", async () => {
    const prover = new EvalAwarenessProver({ simulatedProvingTimeMs: 0 });

    const proof1 = await prover.generateProof(
      createEvalAwarenessInput({ eaiScore: 0.90 })
    );
    const proof2 = await prover.generateProof(
      createEvalAwarenessInput({ eaiScore: 0.50 })
    );

    expect(proof1.proofId).not.toBe(proof2.proofId);
    expect(proof1.publicInputs.eaiScoreExceedsT).toBe(true);
    expect(proof2.publicInputs.eaiScoreExceedsT).toBe(false);
  });
});
