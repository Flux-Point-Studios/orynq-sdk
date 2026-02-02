/**
 * @fileoverview Unit tests for proof publication and cross-chain linking.
 *
 * Location: packages/midnight-prover/src/__tests__/proof-publication.test.ts
 *
 * Summary:
 * Tests for ProofPublisher, CardanoAnchorLinker, and ProofServerClient classes.
 * Covers proof publication, status monitoring, cross-chain link creation,
 * and link verification.
 *
 * Usage:
 * Run with: pnpm test -- packages/midnight-prover
 *
 * Related files:
 * - linking/proof-publication.ts: ProofPublisher implementation
 * - linking/cardano-anchor-link.ts: CardanoAnchorLinker implementation
 * - midnight/proof-server-client.ts: ProofServerClient implementation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  ProofPublisher,
  createProofPublisher,
  type ProofPublisherOptions,
} from "../linking/proof-publication.js";

import {
  CardanoAnchorLinker,
  createCardanoAnchorLinker,
  type CrossChainLink,
} from "../linking/cardano-anchor-link.js";

import {
  ProofServerClient,
  createProofServerClient,
} from "../midnight/proof-server-client.js";

import {
  MidnightProverError,
  MidnightProverException,
  type HashChainProof,
  type PolicyProof,
  type ProofServerConfig,
} from "../types.js";

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create a valid 64-character hex hash.
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
 * Create a mock hash-chain proof for testing.
 */
function createMockHashChainProof(cardanoAnchorTxHash?: string): HashChainProof {
  return {
    proofType: "hash-chain",
    proofId: `proof-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    proof: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    createdAt: new Date().toISOString(),
    provingTimeMs: 100,
    proofSizeBytes: 8,
    publicInputs: {
      rootHash: createMockHash("root"),
      eventCount: 10,
      cardanoAnchorTxHash: cardanoAnchorTxHash ?? createMockHash("anchor"),
    },
  };
}

/**
 * Create a mock policy proof for testing.
 */
function createMockPolicyProof(cardanoAnchorTxHash?: string): PolicyProof {
  return {
    proofType: "policy-compliance",
    proofId: `policy-proof-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    proof: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    createdAt: new Date().toISOString(),
    provingTimeMs: 50,
    proofSizeBytes: 8,
    publicInputs: {
      promptHash: createMockHash("prompt"),
      policyId: "test-policy",
      policyVersion: "1.0.0",
      compliant: true,
      cardanoAnchorTxHash: cardanoAnchorTxHash ?? createMockHash("anchor"),
    },
  };
}

/**
 * Create a mock proof server config.
 */
function createMockConfig(): ProofServerConfig {
  return {
    proofServerUrl: "https://mock.proof.server",
    apiKey: "test-api-key",
    timeout: 30000,
    retries: 3,
    circuitCacheDir: undefined,
  };
}

// =============================================================================
// PROOF PUBLISHER TESTS
// =============================================================================

describe("ProofPublisher", () => {
  let publisher: ProofPublisher;
  const config = createMockConfig();

  beforeEach(async () => {
    publisher = new ProofPublisher({
      debug: false,
      maxRetries: 2,
      retryDelayMs: 10,
      pollIntervalMs: 50,
    });
    await publisher.connect(config);
  });

  afterEach(async () => {
    await publisher.disconnect();
  });

  describe("constructor", () => {
    it("should create a publisher with default options", () => {
      const defaultPublisher = new ProofPublisher();
      expect(defaultPublisher).toBeInstanceOf(ProofPublisher);
      expect(defaultPublisher.isConnected()).toBe(false);
    });

    it("should create a publisher with custom options", () => {
      const customPublisher = new ProofPublisher({
        maxRetries: 5,
        retryDelayMs: 500,
        debug: true,
      });
      expect(customPublisher).toBeInstanceOf(ProofPublisher);
    });
  });

  describe("connect/disconnect", () => {
    it("should connect successfully", async () => {
      const newPublisher = new ProofPublisher();
      expect(newPublisher.isConnected()).toBe(false);

      await newPublisher.connect(config);
      expect(newPublisher.isConnected()).toBe(true);

      await newPublisher.disconnect();
      expect(newPublisher.isConnected()).toBe(false);
    });

    it("should throw for invalid config", async () => {
      const newPublisher = new ProofPublisher();

      await expect(
        newPublisher.connect({
          proofServerUrl: "",
          apiKey: undefined,
          timeout: 30000,
          retries: 3,
          circuitCacheDir: undefined,
        })
      ).rejects.toThrow(MidnightProverException);
    });
  });

  describe("publish", () => {
    it("should publish a proof successfully", async () => {
      const proof = createMockHashChainProof();

      const result = await publisher.publish(proof);

      expect(result).toBeDefined();
      expect(result.midnightTxHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.proofId).toBe(proof.proofId);
      expect(result.cardanoAnchorTxHash).toBe(proof.publicInputs.cardanoAnchorTxHash);
      expect(result.timestamp).toBeDefined();
      expect(result.blockNumber).toBeGreaterThan(0);
    });

    it("should publish different proof types", async () => {
      const hashChainProof = createMockHashChainProof();
      const policyProof = createMockPolicyProof();

      const result1 = await publisher.publish(hashChainProof);
      const result2 = await publisher.publish(policyProof);

      expect(result1.proofId).toBe(hashChainProof.proofId);
      expect(result2.proofId).toBe(policyProof.proofId);
      expect(result1.midnightTxHash).not.toBe(result2.midnightTxHash);
    });

    it("should throw for proof without cardanoAnchorTxHash", async () => {
      const invalidProof = {
        proofType: "hash-chain",
        proofId: "test-proof",
        proof: new Uint8Array([1, 2, 3]),
        createdAt: new Date().toISOString(),
        provingTimeMs: 100,
        proofSizeBytes: 3,
        publicInputs: {
          rootHash: createMockHash("root"),
          eventCount: 10,
          // Missing cardanoAnchorTxHash
        },
      };

      await expect(publisher.publish(invalidProof as HashChainProof)).rejects.toThrow(
        MidnightProverException
      );
    });

    it("should throw when not connected", async () => {
      await publisher.disconnect();
      const proof = createMockHashChainProof();

      await expect(publisher.publish(proof)).rejects.toThrow(MidnightProverException);
    });
  });

  describe("getProofStatus", () => {
    it("should return pending status for newly published proof", async () => {
      const proof = createMockHashChainProof();
      await publisher.publish(proof);

      const status = await publisher.getProofStatus(proof.proofId);

      expect(status.status).toBe("pending");
      expect(status.proofId).toBe(proof.proofId);
      expect(status.midnightTxHash).toBeDefined();
    });

    it("should return not_found for unknown proof", async () => {
      const status = await publisher.getProofStatus("unknown-proof-id");

      expect(status.status).toBe("not_found");
      expect(status.midnightTxHash).toBeUndefined();
    });
  });

  describe("waitForConfirmation", () => {
    it("should wait for confirmation", async () => {
      const proof = createMockHashChainProof();
      await publisher.publish(proof);

      // With mock implementation, confirmation happens after ~10 seconds simulated time
      // but with fast polling, it should confirm quickly
      const confirmed = await publisher.waitForConfirmation(proof.proofId, 15000);

      expect(confirmed).toBe(true);
    });

    it("should return false for unknown proof", async () => {
      const confirmed = await publisher.waitForConfirmation("unknown-proof", 100);

      expect(confirmed).toBe(false);
    });
  });

  describe("getPublicationResult", () => {
    it("should return publication result for published proof", async () => {
      const proof = createMockHashChainProof();
      const publishResult = await publisher.publish(proof);

      const cachedResult = publisher.getPublicationResult(proof.proofId);

      expect(cachedResult).toBeDefined();
      expect(cachedResult?.midnightTxHash).toBe(publishResult.midnightTxHash);
    });

    it("should return undefined for unknown proof", () => {
      const result = publisher.getPublicationResult("unknown-proof");

      expect(result).toBeUndefined();
    });
  });
});

describe("createProofPublisher", () => {
  it("should create a publisher instance", () => {
    const publisher = createProofPublisher();
    expect(publisher).toBeInstanceOf(ProofPublisher);
  });

  it("should create a publisher with options", () => {
    const publisher = createProofPublisher({
      maxRetries: 5,
      debug: true,
    });
    expect(publisher).toBeInstanceOf(ProofPublisher);
  });
});

// =============================================================================
// CARDANO ANCHOR LINKER TESTS
// =============================================================================

describe("CardanoAnchorLinker", () => {
  let linker: CardanoAnchorLinker;

  beforeEach(() => {
    linker = new CardanoAnchorLinker({ debug: false });
  });

  describe("constructor", () => {
    it("should create a linker with default options", () => {
      const defaultLinker = new CardanoAnchorLinker();
      expect(defaultLinker).toBeInstanceOf(CardanoAnchorLinker);
    });

    it("should create a linker with custom verifiers", () => {
      const customLinker = new CardanoAnchorLinker({
        cardanoVerifier: async () => true,
        midnightVerifier: async () => true,
      });
      expect(customLinker).toBeInstanceOf(CardanoAnchorLinker);
    });
  });

  describe("linkToAnchor", () => {
    it("should create a cross-chain link for hash-chain proof", () => {
      const cardanoTxHash = createMockHash("cardano-tx");
      const proof = createMockHashChainProof(cardanoTxHash);

      const link = linker.linkToAnchor(proof, cardanoTxHash);

      expect(link).toBeDefined();
      expect(link.linkId).toMatch(/^link-[0-9a-f]+$/);
      expect(link.version).toBe("1.0.0");
      expect(link.midnightProofId).toBe(proof.proofId);
      expect(link.proofType).toBe("hash-chain");
      expect(link.cardanoAnchorTxHash).toBe(cardanoTxHash.toLowerCase());
      expect(link.anchoredRootHash).toBe(proof.publicInputs.rootHash);
      expect(link.linkCommitment).toMatch(/^[0-9a-f]{64}$/);
      expect(link.createdAt).toBeDefined();
    });

    it("should create a cross-chain link for policy proof", () => {
      const cardanoTxHash = createMockHash("cardano-tx");
      const proof = createMockPolicyProof(cardanoTxHash);

      const link = linker.linkToAnchor(proof, cardanoTxHash);

      expect(link.proofType).toBe("policy-compliance");
      expect(link.anchoredRootHash).toBe(proof.publicInputs.promptHash);
    });

    it("should include midnightTxHash when provided", () => {
      const cardanoTxHash = createMockHash("cardano-tx");
      const midnightTxHash = createMockHash("midnight-tx");
      const proof = createMockHashChainProof(cardanoTxHash);

      const link = linker.linkToAnchor(proof, cardanoTxHash, midnightTxHash);

      expect(link.midnightTxHash).toBe(midnightTxHash);
    });

    it("should throw for mismatched cardanoAnchorTxHash", () => {
      const proofCardanoTx = createMockHash("proof-cardano");
      const differentCardanoTx = createMockHash("different-cardano");
      const proof = createMockHashChainProof(proofCardanoTx);

      expect(() => linker.linkToAnchor(proof, differentCardanoTx)).toThrow(
        MidnightProverException
      );
    });

    it("should throw for invalid cardano tx hash format", () => {
      const cardanoTxHash = createMockHash("cardano-tx");
      const proof = createMockHashChainProof(cardanoTxHash);

      expect(() => linker.linkToAnchor(proof, "invalid-hash")).toThrow(
        MidnightProverException
      );
    });
  });

  describe("verifyLink", () => {
    it("should verify a valid link", async () => {
      const cardanoTxHash = createMockHash("cardano-tx");
      const proof = createMockHashChainProof(cardanoTxHash);
      const link = linker.linkToAnchor(proof, cardanoTxHash);

      const result = await linker.verifyLink(link);

      expect(result.valid).toBe(true);
      expect(result.linkId).toBe(link.linkId);
      expect(result.commitmentVerified).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should detect tampered commitment", async () => {
      const cardanoTxHash = createMockHash("cardano-tx");
      const proof = createMockHashChainProof(cardanoTxHash);
      const link = linker.linkToAnchor(proof, cardanoTxHash);

      // Tamper with commitment
      const tamperedLink: CrossChainLink = {
        ...link,
        linkCommitment: createMockHash("tampered"),
      };

      const result = await linker.verifyLink(tamperedLink);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Link commitment does not match");
    });

    it("should detect invalid link structure", async () => {
      const invalidLink = {
        linkId: "test-link",
        version: "1.0.0",
        midnightProofId: "",
        proofType: "hash-chain",
        publicInputsHash: "invalid",
        cardanoAnchorTxHash: "invalid",
        anchoredRootHash: "invalid",
        createdAt: new Date().toISOString(),
        linkCommitment: "invalid",
      } as CrossChainLink;

      const result = await linker.verifyLink(invalidLink);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("cache operations", () => {
    it("should cache created links", () => {
      const cardanoTxHash = createMockHash("cardano-tx");
      const proof = createMockHashChainProof(cardanoTxHash);
      const link = linker.linkToAnchor(proof, cardanoTxHash);

      const cached = linker.getCachedLink(link.linkId);

      expect(cached).toBeDefined();
      expect(cached?.linkId).toBe(link.linkId);
    });

    it("should find link by proof ID", () => {
      const cardanoTxHash = createMockHash("cardano-tx");
      const proof = createMockHashChainProof(cardanoTxHash);
      linker.linkToAnchor(proof, cardanoTxHash);

      const found = linker.getLinkByProofId(proof.proofId);

      expect(found).toBeDefined();
      expect(found?.midnightProofId).toBe(proof.proofId);
    });

    it("should find links by cardano anchor", () => {
      const cardanoTxHash = createMockHash("cardano-tx");
      const proof1 = createMockHashChainProof(cardanoTxHash);
      const proof2 = createMockPolicyProof(cardanoTxHash);

      linker.linkToAnchor(proof1, cardanoTxHash);
      linker.linkToAnchor(proof2, cardanoTxHash);

      const links = linker.getLinksByCardanoAnchor(cardanoTxHash);

      expect(links).toHaveLength(2);
    });
  });
});

describe("createCardanoAnchorLinker", () => {
  it("should create a linker instance", () => {
    const linker = createCardanoAnchorLinker();
    expect(linker).toBeInstanceOf(CardanoAnchorLinker);
  });

  it("should create a linker with options", () => {
    const linker = createCardanoAnchorLinker({
      debug: true,
    });
    expect(linker).toBeInstanceOf(CardanoAnchorLinker);
  });
});

// =============================================================================
// PROOF SERVER CLIENT TESTS
// =============================================================================

describe("ProofServerClient", () => {
  let client: ProofServerClient;
  const config = createMockConfig();

  beforeEach(async () => {
    client = new ProofServerClient({
      debug: false,
      simulatedProvingTimeMs: 10,
    });
    await client.connect(config);
  });

  afterEach(async () => {
    await client.disconnect();
  });

  describe("constructor", () => {
    it("should create a client with default options", () => {
      const defaultClient = new ProofServerClient();
      expect(defaultClient).toBeInstanceOf(ProofServerClient);
      expect(defaultClient.isConnected()).toBe(false);
    });
  });

  describe("connect/disconnect", () => {
    it("should connect and disconnect successfully", async () => {
      const newClient = new ProofServerClient();

      expect(newClient.isConnected()).toBe(false);
      await newClient.connect(config);
      expect(newClient.isConnected()).toBe(true);
      expect(newClient.getConfig()).toBeDefined();

      await newClient.disconnect();
      expect(newClient.isConnected()).toBe(false);
      expect(newClient.getConfig()).toBeUndefined();
    });

    it("should throw for invalid config", async () => {
      const newClient = new ProofServerClient();

      await expect(
        newClient.connect({
          proofServerUrl: "",
          apiKey: undefined,
          timeout: 30000,
          retries: 3,
          circuitCacheDir: undefined,
        })
      ).rejects.toThrow(MidnightProverException);
    });
  });

  describe("submitProof", () => {
    it("should submit a proof successfully", async () => {
      const witness = { events: [], genesisHash: createMockHash("genesis") };
      const publicInputs = { rootHash: createMockHash("root"), eventCount: 0 };

      const result = await client.submitProof("hash-chain", witness, publicInputs);

      expect(result).toBeDefined();
      expect(result.proofId).toMatch(/^proof-[0-9a-f]+$/);
      expect(result.proof).toBeInstanceOf(Uint8Array);
      expect(result.proof.length).toBeGreaterThan(0);
      expect(result.provingTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.circuit).toBe("poi_hash_chain_v1");
    });

    it("should submit different circuit types", async () => {
      const witness = {};
      const publicInputs = {};

      const hashChainResult = await client.submitProof("hash-chain", witness, publicInputs);
      const policyResult = await client.submitProof("policy-compliance", witness, publicInputs);

      expect(hashChainResult.circuit).toBe("poi_hash_chain_v1");
      expect(policyResult.circuit).toBe("poi_policy_compliance_v1");
    });

    it("should throw when not connected", async () => {
      await client.disconnect();

      await expect(client.submitProof("hash-chain", {}, {})).rejects.toThrow(
        MidnightProverException
      );
    });
  });

  describe("getCircuitInfo", () => {
    it("should return circuit information", async () => {
      const info = await client.getCircuitInfo("poi_hash_chain_v1");

      expect(info).toBeDefined();
      expect(info.name).toBe("poi_hash_chain_v1");
      expect(info.version).toBeDefined();
      expect(info.constraintCount).toBeGreaterThan(0);
      expect(info.available).toBe(true);
    });

    it("should report zkml circuit as unavailable", async () => {
      const info = await client.getCircuitInfo("poi_inference_v1");

      expect(info.available).toBe(false);
    });
  });

  describe("listCircuits", () => {
    it("should return list of circuits", async () => {
      const circuits = await client.listCircuits();

      expect(circuits).toBeInstanceOf(Array);
      expect(circuits).toContain("poi_hash_chain_v1");
      expect(circuits).toContain("poi_policy_compliance_v1");
    });
  });

  describe("isCircuitAvailable", () => {
    it("should return true for available circuits", async () => {
      const available = await client.isCircuitAvailable("hash-chain");

      expect(available).toBe(true);
    });

    it("should return false for unavailable circuits", async () => {
      const available = await client.isCircuitAvailable("zkml-inference");

      expect(available).toBe(false);
    });
  });
});

describe("createProofServerClient", () => {
  it("should create a client instance", () => {
    const client = createProofServerClient();
    expect(client).toBeInstanceOf(ProofServerClient);
  });

  it("should create a client with options", () => {
    const client = createProofServerClient({
      debug: true,
      simulatedProvingTimeMs: 100,
    });
    expect(client).toBeInstanceOf(ProofServerClient);
  });
});
