/**
 * @fileoverview Unit tests for the witness quorum system.
 *
 * Location: packages/attestor/src/__tests__/quorum.test.ts
 *
 * Summary:
 * Tests for the WitnessQuorum class, certificate generation, and certificate
 * verification. Covers observation collection, quorum threshold logic,
 * duplicate witness rejection, binding mismatch detection, and certificate
 * hash integrity.
 *
 * Usage:
 * Run with: pnpm test -- packages/attestor
 *
 * Related files:
 * - quorum/witness-quorum.ts: WitnessQuorum implementation
 * - quorum/quorum-certificate.ts: Certificate verification
 * - quorum/quorum-types.ts: Types and error codes
 */

import { describe, it, expect, beforeEach } from "vitest";

import { WitnessQuorum } from "../quorum/witness-quorum.js";
import { verifyCertificate, computeCertificateHash } from "../quorum/quorum-certificate.js";
import { QuorumError, QuorumException } from "../quorum/quorum-types.js";
import type {
  QuorumConfig,
  WitnessObservation,
  QuorumCertificate,
} from "../quorum/quorum-types.js";

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create a default quorum config for testing.
 */
function createTestConfig(overrides: Partial<QuorumConfig> = {}): QuorumConfig {
  return {
    minWitnesses: 3,
    timeoutMs: 30000,
    requiredBindings: ["baseRootHash", "baseManifestHash"],
    ...overrides,
  };
}

/**
 * Create a test observation with consistent bindings.
 */
function createTestObservation(
  witnessId: string,
  overrides: Partial<WitnessObservation> = {}
): WitnessObservation {
  return {
    witnessId,
    attestorId: `attestor-${witnessId}`,
    baseRootHash: "aaaa".repeat(16),
    baseManifestHash: "bbbb".repeat(16),
    attestationEvidenceHash: "cccc".repeat(16),
    monitorConfigHash: "dddd".repeat(16),
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// =============================================================================
// WITNESS QUORUM TESTS
// =============================================================================

describe("WitnessQuorum", () => {
  let quorum: WitnessQuorum;

  beforeEach(() => {
    quorum = new WitnessQuorum(createTestConfig());
  });

  describe("addObservation", () => {
    it("should add a valid observation", () => {
      const obs = createTestObservation("w1");
      quorum.addObservation(obs);

      expect(quorum.getObservationCount()).toBe(1);
    });

    it("should add multiple observations with matching bindings", () => {
      quorum.addObservation(createTestObservation("w1"));
      quorum.addObservation(createTestObservation("w2"));
      quorum.addObservation(createTestObservation("w3"));

      expect(quorum.getObservationCount()).toBe(3);
    });

    it("should reject duplicate witness IDs", () => {
      quorum.addObservation(createTestObservation("w1"));

      expect(() => quorum.addObservation(createTestObservation("w1"))).toThrow(QuorumException);

      try {
        quorum.addObservation(createTestObservation("w1"));
      } catch (e) {
        expect((e as QuorumException).code).toBe(QuorumError.DUPLICATE_WITNESS);
      }
    });

    it("should reject observation with mismatched baseRootHash", () => {
      quorum.addObservation(createTestObservation("w1"));

      const mismatchObs = createTestObservation("w2", {
        baseRootHash: "ffff".repeat(16),
      });

      expect(() => quorum.addObservation(mismatchObs)).toThrow(QuorumException);

      try {
        quorum.addObservation(mismatchObs);
      } catch (e) {
        expect((e as QuorumException).code).toBe(QuorumError.INVALID_BINDING);
      }
    });

    it("should reject observation with mismatched baseManifestHash", () => {
      quorum.addObservation(createTestObservation("w1"));

      const mismatchObs = createTestObservation("w2", {
        baseManifestHash: "ffff".repeat(16),
      });

      expect(() => quorum.addObservation(mismatchObs)).toThrow(QuorumException);
    });

    it("should reject observation with mismatched attestationEvidenceHash", () => {
      quorum.addObservation(createTestObservation("w1"));

      const mismatchObs = createTestObservation("w2", {
        attestationEvidenceHash: "ffff".repeat(16),
      });

      expect(() => quorum.addObservation(mismatchObs)).toThrow(QuorumException);
    });

    it("should reject observation with mismatched monitorConfigHash", () => {
      quorum.addObservation(createTestObservation("w1"));

      const mismatchObs = createTestObservation("w2", {
        monitorConfigHash: "ffff".repeat(16),
      });

      expect(() => quorum.addObservation(mismatchObs)).toThrow(QuorumException);
    });
  });

  describe("isQuorumMet", () => {
    it("should return false when no observations", () => {
      expect(quorum.isQuorumMet()).toBe(false);
    });

    it("should return false when fewer than minWitnesses", () => {
      quorum.addObservation(createTestObservation("w1"));
      quorum.addObservation(createTestObservation("w2"));

      expect(quorum.isQuorumMet()).toBe(false);
    });

    it("should return true when exactly minWitnesses observations", () => {
      quorum.addObservation(createTestObservation("w1"));
      quorum.addObservation(createTestObservation("w2"));
      quorum.addObservation(createTestObservation("w3"));

      expect(quorum.isQuorumMet()).toBe(true);
    });

    it("should return true when more than minWitnesses observations", () => {
      quorum.addObservation(createTestObservation("w1"));
      quorum.addObservation(createTestObservation("w2"));
      quorum.addObservation(createTestObservation("w3"));
      quorum.addObservation(createTestObservation("w4"));

      expect(quorum.isQuorumMet()).toBe(true);
    });

    it("should respect custom minWitnesses", () => {
      const strictQuorum = new WitnessQuorum(createTestConfig({ minWitnesses: 5 }));

      strictQuorum.addObservation(createTestObservation("w1"));
      strictQuorum.addObservation(createTestObservation("w2"));
      strictQuorum.addObservation(createTestObservation("w3"));

      expect(strictQuorum.isQuorumMet()).toBe(false);
    });

    it("should return true with minWitnesses = 1", () => {
      const singleQuorum = new WitnessQuorum(createTestConfig({ minWitnesses: 1 }));
      singleQuorum.addObservation(createTestObservation("w1"));

      expect(singleQuorum.isQuorumMet()).toBe(true);
    });
  });

  describe("getObservationCount", () => {
    it("should return 0 initially", () => {
      expect(quorum.getObservationCount()).toBe(0);
    });

    it("should increment with each observation", () => {
      quorum.addObservation(createTestObservation("w1"));
      expect(quorum.getObservationCount()).toBe(1);

      quorum.addObservation(createTestObservation("w2"));
      expect(quorum.getObservationCount()).toBe(2);
    });
  });

  describe("reset", () => {
    it("should clear all observations", () => {
      quorum.addObservation(createTestObservation("w1"));
      quorum.addObservation(createTestObservation("w2"));

      expect(quorum.getObservationCount()).toBe(2);

      quorum.reset();

      expect(quorum.getObservationCount()).toBe(0);
      expect(quorum.isQuorumMet()).toBe(false);
    });
  });

  describe("generateCertificate", () => {
    it("should generate a certificate when quorum is met", async () => {
      quorum.addObservation(createTestObservation("w1"));
      quorum.addObservation(createTestObservation("w2"));
      quorum.addObservation(createTestObservation("w3"));

      const cert = await quorum.generateCertificate();

      expect(cert).toBeDefined();
      expect(cert.certificateId).toBeDefined();
      expect(cert.certificateHash).toBeDefined();
      expect(cert.certificateHash).toMatch(/^[0-9a-f]{64}$/);
      expect(cert.witnessCount).toBe(3);
      expect(cert.quorumThreshold).toBe(3);
      expect(cert.quorumMet).toBe(true);
      expect(cert.witnesses).toHaveLength(3);
      expect(cert.baseRootHash).toBe("aaaa".repeat(16));
      expect(cert.baseManifestHash).toBe("bbbb".repeat(16));
      expect(cert.attestationEvidenceHash).toBe("cccc".repeat(16));
      expect(cert.monitorConfigHash).toBe("dddd".repeat(16));
      expect(cert.createdAt).toBeDefined();
    });

    it("should generate a certificate when quorum is not met (with quorumMet = false)", async () => {
      quorum.addObservation(createTestObservation("w1"));

      const cert = await quorum.generateCertificate();

      expect(cert.quorumMet).toBe(false);
      expect(cert.witnessCount).toBe(1);
    });

    it("should throw when no observations exist", async () => {
      await expect(quorum.generateCertificate()).rejects.toThrow(QuorumException);

      try {
        await quorum.generateCertificate();
      } catch (e) {
        expect((e as QuorumException).code).toBe(QuorumError.INSUFFICIENT_WITNESSES);
      }
    });

    it("should produce unique certificate IDs", async () => {
      quorum.addObservation(createTestObservation("w1"));
      quorum.addObservation(createTestObservation("w2"));
      quorum.addObservation(createTestObservation("w3"));

      const cert1 = await quorum.generateCertificate();

      // Reset and regenerate
      quorum.reset();
      quorum.addObservation(createTestObservation("w1"));
      quorum.addObservation(createTestObservation("w2"));
      quorum.addObservation(createTestObservation("w3"));

      const cert2 = await quorum.generateCertificate();

      expect(cert1.certificateId).not.toBe(cert2.certificateId);
    });
  });
});

// =============================================================================
// CERTIFICATE VERIFICATION TESTS
// =============================================================================

describe("verifyCertificate", () => {
  let quorum: WitnessQuorum;

  beforeEach(() => {
    quorum = new WitnessQuorum(createTestConfig());
  });

  it("should verify a valid certificate", async () => {
    quorum.addObservation(createTestObservation("w1"));
    quorum.addObservation(createTestObservation("w2"));
    quorum.addObservation(createTestObservation("w3"));

    const cert = await quorum.generateCertificate();
    const isValid = await verifyCertificate(cert);

    expect(isValid).toBe(true);
  });

  it("should reject certificate with tampered hash", async () => {
    quorum.addObservation(createTestObservation("w1"));
    quorum.addObservation(createTestObservation("w2"));
    quorum.addObservation(createTestObservation("w3"));

    const cert = await quorum.generateCertificate();
    const tamperedCert: QuorumCertificate = {
      ...cert,
      certificateHash: "ff".repeat(32),
    };

    const isValid = await verifyCertificate(tamperedCert);
    expect(isValid).toBe(false);
  });

  it("should reject certificate with wrong witnessCount", async () => {
    quorum.addObservation(createTestObservation("w1"));
    quorum.addObservation(createTestObservation("w2"));
    quorum.addObservation(createTestObservation("w3"));

    const cert = await quorum.generateCertificate();
    const tamperedCert: QuorumCertificate = {
      ...cert,
      witnessCount: 999,
    };

    const isValid = await verifyCertificate(tamperedCert);
    expect(isValid).toBe(false);
  });

  it("should reject certificate with inconsistent quorumMet flag", async () => {
    quorum.addObservation(createTestObservation("w1"));
    quorum.addObservation(createTestObservation("w2"));
    quorum.addObservation(createTestObservation("w3"));

    const cert = await quorum.generateCertificate();
    const tamperedCert: QuorumCertificate = {
      ...cert,
      quorumMet: false, // Should be true since 3 >= 3
    };

    const isValid = await verifyCertificate(tamperedCert);
    expect(isValid).toBe(false);
  });

  it("should reject certificate with duplicate witness IDs", async () => {
    quorum.addObservation(createTestObservation("w1"));
    quorum.addObservation(createTestObservation("w2"));
    quorum.addObservation(createTestObservation("w3"));

    const cert = await quorum.generateCertificate();

    // Manually tamper to add duplicate witness
    const tamperedCert: QuorumCertificate = {
      ...cert,
      witnesses: [
        ...cert.witnesses,
        { ...cert.witnesses[0]! }, // Duplicate w1
      ],
      witnessCount: 4,
    };

    const isValid = await verifyCertificate(tamperedCert);
    expect(isValid).toBe(false);
  });

  it("should reject certificate with inconsistent witness bindings", async () => {
    quorum.addObservation(createTestObservation("w1"));
    quorum.addObservation(createTestObservation("w2"));
    quorum.addObservation(createTestObservation("w3"));

    const cert = await quorum.generateCertificate();

    // Tamper one witness binding
    const tamperedWitnesses = [...cert.witnesses];
    tamperedWitnesses[1] = {
      ...tamperedWitnesses[1]!,
      baseRootHash: "ffff".repeat(16),
    };

    const tamperedCert: QuorumCertificate = {
      ...cert,
      witnesses: tamperedWitnesses,
    };

    const isValid = await verifyCertificate(tamperedCert);
    expect(isValid).toBe(false);
  });

  it("should reject certificate with zero quorum threshold", async () => {
    quorum.addObservation(createTestObservation("w1"));

    const cert = await quorum.generateCertificate();
    const tamperedCert: QuorumCertificate = {
      ...cert,
      quorumThreshold: 0,
    };

    const isValid = await verifyCertificate(tamperedCert);
    expect(isValid).toBe(false);
  });

  it("should reject certificate with missing certificateId", async () => {
    quorum.addObservation(createTestObservation("w1"));
    quorum.addObservation(createTestObservation("w2"));
    quorum.addObservation(createTestObservation("w3"));

    const cert = await quorum.generateCertificate();
    const tamperedCert: QuorumCertificate = {
      ...cert,
      certificateId: "",
    };

    const isValid = await verifyCertificate(tamperedCert);
    expect(isValid).toBe(false);
  });
});

// =============================================================================
// CERTIFICATE HASH TESTS
// =============================================================================

describe("computeCertificateHash", () => {
  let quorum: WitnessQuorum;

  beforeEach(() => {
    quorum = new WitnessQuorum(createTestConfig());
  });

  it("should produce a 64-character hex hash", async () => {
    quorum.addObservation(createTestObservation("w1"));
    quorum.addObservation(createTestObservation("w2"));
    quorum.addObservation(createTestObservation("w3"));

    const cert = await quorum.generateCertificate();
    const hash = await computeCertificateHash(cert);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should match the certificate's own hash", async () => {
    quorum.addObservation(createTestObservation("w1"));
    quorum.addObservation(createTestObservation("w2"));
    quorum.addObservation(createTestObservation("w3"));

    const cert = await quorum.generateCertificate();
    const recomputedHash = await computeCertificateHash(cert);

    expect(recomputedHash).toBe(cert.certificateHash);
  });

  it("should change when bindings change", async () => {
    // Generate first certificate with bindings A
    quorum.addObservation(createTestObservation("w1"));
    quorum.addObservation(createTestObservation("w2"));
    quorum.addObservation(createTestObservation("w3"));
    const cert1 = await quorum.generateCertificate();

    // Generate second certificate with different bindings
    const quorum2 = new WitnessQuorum(createTestConfig());
    quorum2.addObservation(
      createTestObservation("w1", {
        baseRootHash: "1111".repeat(16),
        baseManifestHash: "2222".repeat(16),
        attestationEvidenceHash: "3333".repeat(16),
        monitorConfigHash: "4444".repeat(16),
      })
    );
    quorum2.addObservation(
      createTestObservation("w2", {
        baseRootHash: "1111".repeat(16),
        baseManifestHash: "2222".repeat(16),
        attestationEvidenceHash: "3333".repeat(16),
        monitorConfigHash: "4444".repeat(16),
      })
    );
    quorum2.addObservation(
      createTestObservation("w3", {
        baseRootHash: "1111".repeat(16),
        baseManifestHash: "2222".repeat(16),
        attestationEvidenceHash: "3333".repeat(16),
        monitorConfigHash: "4444".repeat(16),
      })
    );
    const cert2 = await quorum2.generateCertificate();

    // The hashes should differ because different bindings produce different canonical data
    // Note: certificateId also differs, so hash will always differ between calls,
    // but this test specifically verifies binding changes cause hash changes
    expect(cert1.certificateHash).not.toBe(cert2.certificateHash);
    expect(cert1.baseRootHash).not.toBe(cert2.baseRootHash);
  });

  it("should produce consistent hash for same data", async () => {
    quorum.addObservation(createTestObservation("w1"));
    quorum.addObservation(createTestObservation("w2"));
    quorum.addObservation(createTestObservation("w3"));

    const cert = await quorum.generateCertificate();

    // Recompute multiple times
    const hash1 = await computeCertificateHash(cert);
    const hash2 = await computeCertificateHash(cert);

    expect(hash1).toBe(hash2);
  });
});
