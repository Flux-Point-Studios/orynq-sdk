/**
 * Tests for the attestor package.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  AttestationBundleBuilder,
  serializeBundle,
  deserializeBundle,
  hashBundle,
  validateBinding,
} from "../attestation-bundle.js";
import {
  evaluatePolicy,
  createPermissivePolicy,
  createStrictPolicy,
} from "../verification/policy-engine.js";
import {
  DefaultAttestorRegistry,
} from "../attestor-interface.js";
import {
  VerifierRegistry,
  verifyBundle,
} from "../verification/verifier-interface.js";
// Import index to trigger backend registration
import "../index.js";
import { createNitroAttestor } from "../backends/nitro/nitro-attestor.js";
import { createNitroVerifier } from "../backends/nitro/nitro-verifier.js";
import { createSevSnpAttestor } from "../backends/sev-snp/sev-snp-attestor.js";
import { createSevSnpVerifier } from "../backends/sev-snp/sev-snp-verifier.js";
import type { AttestationBundle, Measurements, VerifierPolicy } from "../types.js";

describe("AttestationBundleBuilder", () => {
  it("should build a valid attestation bundle", () => {
    const builder = new AttestationBundleBuilder();

    const bundle = builder
      .setTee("nitro", "1.0")
      .setInlineEvidence("dGVzdC1ldmlkZW5jZQ==", "base64")
      .setBinding("abc123", "rootHash")
      .setAttestor("test-attestor")
      .build();

    expect(bundle.teeType).toBe("nitro");
    expect(bundle.teeVersion).toBe("1.0");
    expect(bundle.evidence.data).toBe("dGVzdC1ldmlkZW5jZQ==");
    expect(bundle.binding.hash).toBe("abc123");
    expect(bundle.binding.hashType).toBe("rootHash");
    expect(bundle.attestorId).toBe("test-attestor");
  });

  it("should throw if required fields are missing", () => {
    const builder = new AttestationBundleBuilder();

    expect(() => builder.build()).toThrow("TEE type is required");

    builder.setTee("nitro", "1.0");
    expect(() => builder.build()).toThrow("Evidence is required");

    builder.setInlineEvidence("test");
    expect(() => builder.build()).toThrow("Binding is required");

    builder.setBinding("hash", "rootHash");
    expect(() => builder.build()).toThrow("Attestor ID is required");
  });

  it("should support external evidence", () => {
    const builder = new AttestationBundleBuilder();

    const bundle = builder
      .setTee("nitro", "1.0")
      .setExternalEvidence("hash123", "ipfs://Qm...")
      .setBinding("abc123", "rootHash")
      .setAttestor("test-attestor")
      .build();

    expect(bundle.evidence.hash).toBe("hash123");
    expect(bundle.evidence.storageUri).toBe("ipfs://Qm...");
    expect(bundle.evidence.data).toBeUndefined();
  });
});

describe("Bundle Serialization", () => {
  let bundle: AttestationBundle;

  beforeEach(() => {
    const builder = new AttestationBundleBuilder();
    bundle = builder
      .setTee("nitro", "1.0")
      .setInlineEvidence("dGVzdA==", "base64")
      .setBinding("abc123", "rootHash")
      .setAttestor("test-attestor")
      .build();
  });

  it("should serialize and deserialize a bundle", () => {
    const json = serializeBundle(bundle);
    const deserialized = deserializeBundle(json);

    expect(deserialized.teeType).toBe(bundle.teeType);
    expect(deserialized.binding.hash).toBe(bundle.binding.hash);
    expect(deserialized.attestorId).toBe(bundle.attestorId);
  });

  it("should compute consistent hash", async () => {
    const hash1 = await hashBundle(bundle);
    const hash2 = await hashBundle(bundle);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it("should validate binding", () => {
    expect(validateBinding(bundle, "abc123", "rootHash")).toBe(true);
    expect(validateBinding(bundle, "wrong", "rootHash")).toBe(false);
    expect(validateBinding(bundle, "abc123", "merkleRoot")).toBe(false);
  });
});

describe("Policy Engine", () => {
  it("should create permissive policy", () => {
    const policy = createPermissivePolicy();

    expect(policy.expectedMeasurements).toBeUndefined();
    expect(policy.checkRevocation).toBe(false);
  });

  it("should create strict policy", () => {
    const policy = createStrictPolicy(["measurement1", "measurement2"], {
      minFirmwareVersion: "1.0.0",
      checkRevocation: true,
    });

    expect(policy.expectedMeasurements).toEqual(["measurement1", "measurement2"]);
    expect(policy.minFirmwareVersion).toBe("1.0.0");
    expect(policy.checkRevocation).toBe(true);
  });

  it("should evaluate policy with matching measurements", () => {
    const measurements: Measurements = {
      firmwareVersion: "2.0.0",
      sevSnp: undefined,
      tdx: undefined,
      sgx: undefined,
      nitro: {
        pcrs: { 0: "abc", 1: "def", 2: "ghi" },
        moduleId: "test",
      },
    };

    const policy: VerifierPolicy = {
      expectedMeasurements: ["abc:def:ghi"],
      allowedSignerKeys: undefined,
      minFirmwareVersion: "1.0.0",
      minSvn: undefined,
      checkRevocation: false,
      revocationListUri: undefined,
    };

    const result = evaluatePolicy(measurements, policy, "nitro");

    expect(result.passed).toBe(true);
    expect(result.measurementsMatch).toBe(true);
    expect(result.firmwareVersionOk).toBe(true);
  });

  it("should fail policy with mismatched measurements", () => {
    const measurements: Measurements = {
      firmwareVersion: "1.0.0",
      sevSnp: undefined,
      tdx: undefined,
      sgx: undefined,
      nitro: {
        pcrs: { 0: "abc", 1: "def", 2: "ghi" },
        moduleId: "test",
      },
    };

    const policy: VerifierPolicy = {
      expectedMeasurements: ["wrong:measurement:here"],
      allowedSignerKeys: undefined,
      minFirmwareVersion: undefined,
      minSvn: undefined,
      checkRevocation: false,
      revocationListUri: undefined,
    };

    const result = evaluatePolicy(measurements, policy, "nitro");

    expect(result.passed).toBe(false);
    expect(result.measurementsMatch).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("should fail policy with old firmware version", () => {
    const measurements: Measurements = {
      firmwareVersion: "1.0.0",
      sevSnp: undefined,
      tdx: undefined,
      sgx: undefined,
      nitro: undefined,
    };

    const policy: VerifierPolicy = {
      expectedMeasurements: undefined,
      allowedSignerKeys: undefined,
      minFirmwareVersion: "2.0.0",
      minSvn: undefined,
      checkRevocation: false,
      revocationListUri: undefined,
    };

    const result = evaluatePolicy(measurements, policy, "nitro");

    expect(result.passed).toBe(false);
    expect(result.firmwareVersionOk).toBe(false);
  });
});

describe("Attestor Registry", () => {
  it("should detect no TEE in normal environment", async () => {
    const registry = new DefaultAttestorRegistry();
    const detected = await registry.detectEnvironment();

    // In a normal test environment, no TEE should be detected
    expect(detected).toBeUndefined();
  });

  it("should register and retrieve attestors", () => {
    const registry = new DefaultAttestorRegistry();

    registry.register("nitro", (config) => createNitroAttestor(config.attestorId));

    const attestor = registry.get("nitro", { attestorId: "test", debug: false });
    expect(attestor).toBeDefined();
    expect(attestor?.teeType).toBe("nitro");
  });

  it("should list available types after registration", () => {
    const registry = new DefaultAttestorRegistry();

    // Register backends
    registry.register("nitro", (config) => createNitroAttestor(config.attestorId));
    registry.register("sev-snp", (config) => createSevSnpAttestor(config.attestorId));

    expect(registry.availableTypes()).toContain("nitro");
    expect(registry.availableTypes()).toContain("sev-snp");
  });
});

describe("Verifier Registry", () => {
  it("should register and retrieve verifiers", () => {
    const registry = new VerifierRegistry();

    // Register verifiers
    registry.register("nitro", () => createNitroVerifier());
    registry.register("sev-snp", () => createSevSnpVerifier());

    expect(registry.availableTypes()).toContain("nitro");
    expect(registry.availableTypes()).toContain("sev-snp");

    const nitroVerifier = registry.get("nitro");
    expect(nitroVerifier).toBeDefined();
    expect(nitroVerifier?.teeType).toBe("nitro");

    const sevSnpVerifier = registry.get("sev-snp");
    expect(sevSnpVerifier).toBeDefined();
    expect(sevSnpVerifier?.teeType).toBe("sev-snp");
  });
});

describe("NitroAttestor", () => {
  it("should create attestor instance", () => {
    const attestor = createNitroAttestor("test-attestor");

    expect(attestor.teeType).toBe("nitro");
    expect(attestor.attestorId).toBe("test-attestor");
  });

  it("should detect non-enclave environment", () => {
    const attestor = createNitroAttestor("test-attestor");

    // In normal test environment, should not be attested
    expect(attestor.isAttested()).toBe(false);
  });
});

describe("NitroVerifier", () => {
  it("should create verifier instance", () => {
    const verifier = createNitroVerifier();

    expect(verifier.teeType).toBe("nitro");
  });

  it("should verify bundle with correct type", async () => {
    const builder = new AttestationBundleBuilder();
    const bundle = builder
      .setTee("nitro", "1.0")
      .setInlineEvidence("dGVzdA==", "base64")
      .setBinding("abc123", "rootHash")
      .setAttestor("test-attestor")
      .build();

    const result = await verifyBundle(bundle);

    expect(result.teeType).toBe("nitro");
    // Note: Verification may fail due to mock data, but should not error
  });

  it("should fail verification for wrong TEE type", async () => {
    const builder = new AttestationBundleBuilder();
    const bundle = builder
      .setTee("sgx", "1.0") // SGX not implemented
      .setInlineEvidence("dGVzdA==", "base64")
      .setBinding("abc123", "rootHash")
      .setAttestor("test-attestor")
      .build();

    const result = await verifyBundle(bundle);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("SevSnpAttestor", () => {
  it("should create attestor instance", () => {
    const attestor = createSevSnpAttestor("test-attestor");

    expect(attestor.teeType).toBe("sev-snp");
    expect(attestor.attestorId).toBe("test-attestor");
  });

  it("should detect non-SEV environment", () => {
    const attestor = createSevSnpAttestor("test-attestor");

    // In normal test environment, should not be attested
    expect(attestor.isAttested()).toBe(false);
  });
});

describe("SevSnpVerifier", () => {
  it("should create verifier instance", () => {
    const verifier = createSevSnpVerifier();

    expect(verifier.teeType).toBe("sev-snp");
  });

  it("should verify bundle with correct type", async () => {
    const builder = new AttestationBundleBuilder();
    const bundle = builder
      .setTee("sev-snp", "1.0")
      .setInlineEvidence("dGVzdA==", "base64")
      .setBinding("abc123", "rootHash")
      .setAttestor("test-attestor")
      .build();

    const verifier = createSevSnpVerifier();
    const result = await verifier.verify(bundle);

    expect(result.teeType).toBe("sev-snp");
  });
});
