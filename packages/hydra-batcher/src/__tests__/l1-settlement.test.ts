/**
 * Location: packages/hydra-batcher/src/__tests__/l1-settlement.test.ts
 *
 * Unit tests for the L1SettlementService class.
 *
 * Tests cover:
 * - Building anchor entries from commitment state
 * - Settling to L1 with mock provider
 * - Waiting for transaction confirmation
 * - Retry logic for transient failures
 * - Network validation
 * - Error handling
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  L1SettlementService,
  createMockAnchorProvider,
  settleAndConfirm,
  type AnchorProvider,
  type L1SettlementConfig,
  type SettlementMetadata,
} from "../tx/l1-settlement.js";
import type { CommitmentDatum, AnchorEntry } from "../types.js";
import { HydraBatcherError, HydraBatcherException } from "../types.js";

/**
 * Helper to create a test CommitmentDatum.
 */
const createDatum = (
  commitCount: number = 5,
  accumulatorRoot: string = "a".repeat(64)
): CommitmentDatum => ({
  accumulatorRoot,
  commitCount,
  latestBatchRoot: "b".repeat(64),
  latestBatchTimestamp: Date.now(),
  batchHistory: Array(commitCount)
    .fill(null)
    .map((_, i) => ({
      batchRoot: i.toString(16).padStart(64, "0"),
      timestamp: Date.now() - (commitCount - i) * 1000,
      itemCount: 10,
    })),
});

/**
 * Helper to create default config with mock provider.
 */
const createConfig = (
  overrides?: Partial<L1SettlementConfig>
): L1SettlementConfig => ({
  network: "preprod",
  anchorProvider: createMockAnchorProvider({ network: "preprod" }),
  confirmationBlocks: 6,
  timeoutMs: 5000, // Short timeout for tests
  ...overrides,
});

describe("L1SettlementService", () => {
  let service: L1SettlementService;
  let mockProvider: AnchorProvider;

  beforeEach(() => {
    mockProvider = createMockAnchorProvider({ network: "preprod" });
    service = new L1SettlementService({
      network: "preprod",
      anchorProvider: mockProvider,
      confirmationBlocks: 6,
      timeoutMs: 5000,
    });
  });

  describe("constructor", () => {
    it("should create service with default values", () => {
      const minimalConfig = createConfig();
      const svc = new L1SettlementService(minimalConfig);

      const config = svc.getConfig();
      expect(config.network).toBe("preprod");
      expect(config.confirmationBlocks).toBe(6);
    });

    it("should respect custom configuration", () => {
      const customConfig = createConfig({
        confirmationBlocks: 10,
        timeoutMs: 600000,
        retryConfig: {
          maxRetries: 5,
          initialDelayMs: 500,
          maxDelayMs: 10000,
          backoffMultiplier: 1.5,
        },
      });

      const svc = new L1SettlementService(customConfig);
      const config = svc.getConfig();

      expect(config.confirmationBlocks).toBe(10);
      expect(config.timeoutMs).toBe(600000);
    });
  });

  describe("buildAnchorEntry", () => {
    it("should build anchor entry with correct schema", () => {
      const datum = createDatum();
      const headId = "head-123";

      const entry = service.buildAnchorEntry(datum, headId);

      expect(entry.schema).toBe("poi-anchor-v2");
    });

    it("should include rootHash from accumulator", () => {
      const datum = createDatum(5, "my-accumulator-root".padEnd(64, "0"));
      const headId = "head-123";

      const entry = service.buildAnchorEntry(datum, headId);

      expect(entry.rootHash).toBe(datum.accumulatorRoot);
    });

    it("should include merkleRoot from latest batch", () => {
      const datum = createDatum();
      const headId = "head-123";

      const entry = service.buildAnchorEntry(datum, headId);

      expect(entry.merkleRoot).toBe(datum.latestBatchRoot);
    });

    it("should include l2Metadata with headId and totalCommits", () => {
      const datum = createDatum(10);
      const headId = "head-xyz-789";

      const entry = service.buildAnchorEntry(datum, headId);

      expect(entry.l2Metadata).toBeDefined();
      expect(entry.l2Metadata?.headId).toBe(headId);
      expect(entry.l2Metadata?.totalCommits).toBe(10);
    });

    it("should include metadata when provided", () => {
      const datum = createDatum();
      const headId = "head-123";
      const metadata: SettlementMetadata = {
        agentId: "my-agent",
        sessionId: "session-456",
        storageUri: "ipfs://QmXyz...",
      };

      const entry = service.buildAnchorEntry(datum, headId, metadata);

      expect(entry.agentId).toBe("my-agent");
      expect(entry.sessionId).toBe("session-456");
      expect(entry.storageUri).toBe("ipfs://QmXyz...");
    });

    it("should use defaults when metadata not provided", () => {
      const datum = createDatum();
      const headId = "head-123";

      const entry = service.buildAnchorEntry(datum, headId);

      expect(entry.agentId).toBe("hydra-batcher");
      expect(entry.sessionId).toBe(headId);
      expect(entry.storageUri).toBe("");
    });

    it("should include ISO timestamp", () => {
      const datum = createDatum();
      const headId = "head-123";

      const entry = service.buildAnchorEntry(datum, headId);

      expect(entry.timestamp).toBeDefined();
      // Verify it's a valid ISO string
      const parsed = Date.parse(entry.timestamp);
      expect(isNaN(parsed)).toBe(false);
    });

    it("should compute deterministic manifest hash", () => {
      const datum = createDatum(5, "abc".padEnd(64, "0"));
      const headId = "head-123";

      const entry1 = service.buildAnchorEntry(datum, headId);
      const entry2 = service.buildAnchorEntry(datum, headId);

      expect(entry1.manifestHash).toBe(entry2.manifestHash);
      expect(entry1.manifestHash).toHaveLength(64);
    });
  });

  describe("settleToL1", () => {
    it("should submit anchor and return settlement result", async () => {
      const datum = createDatum(5);
      const headId = "head-settle-test";

      const result = await service.settleToL1(datum, headId);

      expect(result.l1TxHash).toBeDefined();
      expect(result.l1TxHash).toHaveLength(64);
      expect(result.finalAccumulatorRoot).toBe(datum.accumulatorRoot);
      expect(result.totalCommits).toBe(5);
      expect(result.anchorEntry).toBeDefined();
      expect(result.anchorEntry.schema).toBe("poi-anchor-v2");
    });

    it("should calculate total items from batch history", async () => {
      const datum = createDatum(3);
      // Each batch has 10 items, 3 commits = 30 items
      const headId = "head-123";

      const result = await service.settleToL1(datum, headId);

      expect(result.totalItems).toBe(30);
    });

    it("should include settlement tx hash in anchor l2Metadata", async () => {
      const datum = createDatum();
      const headId = "head-123";

      const result = await service.settleToL1(datum, headId);

      expect(result.anchorEntry.l2Metadata?.settlementTxHash).toBe(result.l1TxHash);
    });

    it("should pass metadata to anchor entry", async () => {
      const datum = createDatum();
      const headId = "head-123";
      const metadata: SettlementMetadata = {
        agentId: "custom-agent",
        sessionId: "custom-session",
        storageUri: "ar://storage-uri",
      };

      const result = await service.settleToL1(datum, headId, metadata);

      expect(result.anchorEntry.agentId).toBe("custom-agent");
      expect(result.anchorEntry.sessionId).toBe("custom-session");
      expect(result.anchorEntry.storageUri).toBe("ar://storage-uri");
    });

    it("should throw if provider is not ready", async () => {
      const notReadyProvider = createMockAnchorProvider({
        network: "preprod",
        isReady: false,
      });
      const svc = new L1SettlementService(
        createConfig({ anchorProvider: notReadyProvider })
      );

      const datum = createDatum();
      const headId = "head-123";

      await expect(svc.settleToL1(datum, headId)).rejects.toThrow(
        HydraBatcherException
      );
      await expect(svc.settleToL1(datum, headId)).rejects.toMatchObject({
        code: HydraBatcherError.L1_SUBMISSION_FAILED,
      });
    });

    it("should throw on network mismatch", async () => {
      const mainnetProvider = createMockAnchorProvider({ network: "mainnet" });
      const svc = new L1SettlementService(
        createConfig({ network: "preprod", anchorProvider: mainnetProvider })
      );

      const datum = createDatum();
      const headId = "head-123";

      await expect(svc.settleToL1(datum, headId)).rejects.toThrow(
        /Network mismatch/
      );
    });

    it("should invoke onSubmit callback", async () => {
      const submittedEntries: AnchorEntry[] = [];
      const providerWithCallback = createMockAnchorProvider({
        network: "preprod",
        onSubmit: (entry) => submittedEntries.push(entry),
      });
      const svc = new L1SettlementService(
        createConfig({ anchorProvider: providerWithCallback })
      );

      const datum = createDatum();
      const headId = "head-callback-test";

      await svc.settleToL1(datum, headId);

      expect(submittedEntries).toHaveLength(1);
      expect(submittedEntries[0]?.l2Metadata?.headId).toBe(headId);
    });
  });

  describe("retry logic", () => {
    it("should retry on transient failures", async () => {
      let attempts = 0;
      const failTwiceProvider: AnchorProvider = {
        async submitAnchor(entry: AnchorEntry): Promise<string> {
          attempts++;
          if (attempts < 3) {
            throw new Error("Transient failure");
          }
          return "success_tx_" + "0".repeat(54);
        },
        async getConfirmations(): Promise<number> {
          return 10;
        },
        async isReady(): Promise<boolean> {
          return true;
        },
        getNetwork(): "preprod" {
          return "preprod";
        },
      };

      const svc = new L1SettlementService({
        network: "preprod",
        anchorProvider: failTwiceProvider,
        retryConfig: {
          maxRetries: 3,
          initialDelayMs: 10, // Fast for tests
          maxDelayMs: 50,
          backoffMultiplier: 2,
        },
      });

      const datum = createDatum();
      const result = await svc.settleToL1(datum, "head-retry-test");

      expect(attempts).toBe(3);
      expect(result.l1TxHash).toContain("success_tx_");
    });

    it("should throw after max retries exceeded", async () => {
      const alwaysFailProvider = createMockAnchorProvider({
        network: "preprod",
        submitError: new Error("Permanent failure"),
      });

      const svc = new L1SettlementService({
        network: "preprod",
        anchorProvider: alwaysFailProvider,
        retryConfig: {
          maxRetries: 2,
          initialDelayMs: 10,
          maxDelayMs: 50,
          backoffMultiplier: 2,
        },
      });

      const datum = createDatum();

      await expect(svc.settleToL1(datum, "head-fail-test")).rejects.toThrow(
        HydraBatcherException
      );
      await expect(svc.settleToL1(datum, "head-fail-test")).rejects.toMatchObject(
        {
          code: HydraBatcherError.L1_SUBMISSION_FAILED,
        }
      );
    });

    it("should include original error in exception", async () => {
      const originalError = new Error("Original network error");
      const failProvider = createMockAnchorProvider({
        network: "preprod",
        submitError: originalError,
      });

      const svc = new L1SettlementService({
        network: "preprod",
        anchorProvider: failProvider,
        retryConfig: {
          maxRetries: 0,
          initialDelayMs: 10,
          maxDelayMs: 50,
          backoffMultiplier: 2,
        },
      });

      const datum = createDatum();

      try {
        await svc.settleToL1(datum, "head-error-test");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(HydraBatcherException);
        const batcherError = error as HydraBatcherException;
        expect(batcherError.cause).toBe(originalError);
      }
    });
  });

  describe("waitForConfirmation", () => {
    it("should return true when confirmations reached", async () => {
      const provider = createMockAnchorProvider({
        network: "preprod",
        confirmations: 10,
      });
      const svc = new L1SettlementService(
        createConfig({ anchorProvider: provider, confirmationBlocks: 6 })
      );

      // First settle to get a tx hash
      const datum = createDatum();
      const result = await svc.settleToL1(datum, "head-123");

      const confirmed = await svc.waitForConfirmation(result.l1TxHash);

      expect(confirmed).toBe(true);
    });

    it("should return false on timeout", async () => {
      const provider = createMockAnchorProvider({
        network: "preprod",
        confirmations: 2, // Less than required
      });
      const svc = new L1SettlementService(
        createConfig({
          anchorProvider: provider,
          confirmationBlocks: 10,
          timeoutMs: 500, // Very short timeout
        })
      );

      const datum = createDatum();
      const result = await svc.settleToL1(datum, "head-123");

      const confirmed = await svc.waitForConfirmation(result.l1TxHash, 500, {
        pollIntervalMs: 100,
      });

      expect(confirmed).toBe(false);
    });

    it("should invoke progress callback", async () => {
      const provider = createMockAnchorProvider({
        network: "preprod",
        confirmations: 10,
      });
      const svc = new L1SettlementService(
        createConfig({ anchorProvider: provider })
      );

      const datum = createDatum();
      const result = await svc.settleToL1(datum, "head-123");

      const progressUpdates: number[] = [];
      await svc.waitForConfirmation(result.l1TxHash, 5000, {
        pollIntervalMs: 50,
        onProgress: (confirmations) => progressUpdates.push(confirmations),
      });

      expect(progressUpdates.length).toBeGreaterThan(0);
      expect(progressUpdates[0]).toBe(10);
    });

    it("should handle dynamic confirmation counts", async () => {
      let callCount = 0;
      const provider = createMockAnchorProvider({
        network: "preprod",
        confirmations: () => {
          callCount++;
          return callCount * 2; // Increases each call
        },
      });
      const svc = new L1SettlementService(
        createConfig({ anchorProvider: provider, confirmationBlocks: 6 })
      );

      const datum = createDatum();
      const result = await svc.settleToL1(datum, "head-123");

      const progressUpdates: number[] = [];
      await svc.waitForConfirmation(result.l1TxHash, 5000, {
        pollIntervalMs: 10,
        onProgress: (c) => progressUpdates.push(c),
      });

      // Should have increased over time
      expect(progressUpdates[progressUpdates.length - 1]).toBeGreaterThanOrEqual(6);
    });

    it("should continue polling on provider errors", async () => {
      let errorCount = 0;
      const flakyProvider: AnchorProvider = {
        async submitAnchor(): Promise<string> {
          return "tx_" + "0".repeat(61);
        },
        async getConfirmations(): Promise<number> {
          errorCount++;
          if (errorCount < 3) {
            throw new Error("Flaky network");
          }
          return 10;
        },
        async isReady(): Promise<boolean> {
          return true;
        },
        getNetwork(): "preprod" {
          return "preprod";
        },
      };

      const svc = new L1SettlementService(
        createConfig({ anchorProvider: flakyProvider, confirmationBlocks: 6 })
      );

      const datum = createDatum();
      const result = await svc.settleToL1(datum, "head-123");

      const confirmed = await svc.waitForConfirmation(result.l1TxHash, 5000, {
        pollIntervalMs: 50,
      });

      expect(confirmed).toBe(true);
      expect(errorCount).toBeGreaterThanOrEqual(3);
    });
  });

  describe("getConfig", () => {
    it("should return immutable config copy", () => {
      const config = service.getConfig();

      expect(config.network).toBe("preprod");
      expect(config.confirmationBlocks).toBe(6);
      expect(config.timeoutMs).toBe(5000);
    });
  });
});

describe("createMockAnchorProvider", () => {
  it("should create provider with default options", () => {
    const provider = createMockAnchorProvider();

    expect(provider.getNetwork()).toBe("preprod");
  });

  it("should respect network option", () => {
    const provider = createMockAnchorProvider({ network: "mainnet" });

    expect(provider.getNetwork()).toBe("mainnet");
  });

  it("should respect isReady option", async () => {
    const notReady = createMockAnchorProvider({ isReady: false });
    const ready = createMockAnchorProvider({ isReady: true });

    expect(await notReady.isReady()).toBe(false);
    expect(await ready.isReady()).toBe(true);
  });

  it("should throw submitError when configured", async () => {
    const errorProvider = createMockAnchorProvider({
      submitError: new Error("Test error"),
    });

    await expect(
      errorProvider.submitAnchor({} as AnchorEntry)
    ).rejects.toThrow("Test error");
  });

  it("should generate unique tx hashes", async () => {
    const provider = createMockAnchorProvider();

    const hash1 = await provider.submitAnchor({} as AnchorEntry);
    const hash2 = await provider.submitAnchor({} as AnchorEntry);

    expect(hash1).not.toBe(hash2);
    expect(hash1).toHaveLength(64);
    expect(hash2).toHaveLength(64);
  });

  it("should track submissions and return confirmations", async () => {
    const provider = createMockAnchorProvider({ confirmations: 15 });

    // Unknown tx should return 0
    expect(await provider.getConfirmations("unknown_tx")).toBe(0);

    // Submit and check
    const hash = await provider.submitAnchor({} as AnchorEntry);
    expect(await provider.getConfirmations(hash)).toBe(15);
  });

  it("should support dynamic confirmations function", async () => {
    let counter = 0;
    const provider = createMockAnchorProvider({
      confirmations: () => ++counter,
    });

    const hash = await provider.submitAnchor({} as AnchorEntry);

    expect(await provider.getConfirmations(hash)).toBe(1);
    expect(await provider.getConfirmations(hash)).toBe(2);
    expect(await provider.getConfirmations(hash)).toBe(3);
  });

  it("should invoke onSubmit callback", async () => {
    const submissions: AnchorEntry[] = [];
    const provider = createMockAnchorProvider({
      onSubmit: (entry) => submissions.push(entry),
    });

    const entry: AnchorEntry = {
      schema: "poi-anchor-v2",
      rootHash: "test-root",
      merkleRoot: "test-merkle",
      manifestHash: "test-manifest",
      storageUri: "",
      agentId: "test-agent",
      sessionId: "test-session",
      timestamp: new Date().toISOString(),
    };

    await provider.submitAnchor(entry);

    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toBe(entry);
  });
});

describe("settleAndConfirm", () => {
  it("should settle and wait for confirmation", async () => {
    const provider = createMockAnchorProvider({
      network: "preprod",
      confirmations: 10,
    });
    const service = new L1SettlementService({
      network: "preprod",
      anchorProvider: provider,
      confirmationBlocks: 6,
    });

    const datum = createDatum(3);
    const result = await settleAndConfirm(service, datum, "head-combined", {
      agentId: "test-agent",
    });

    expect(result.l1TxHash).toBeDefined();
    expect(result.totalCommits).toBe(3);
    expect(result.anchorEntry.agentId).toBe("test-agent");
  });

  it("should throw on timeout", async () => {
    const provider = createMockAnchorProvider({
      network: "preprod",
      confirmations: 1, // Not enough
    });
    const service = new L1SettlementService({
      network: "preprod",
      anchorProvider: provider,
      confirmationBlocks: 100, // Requires many confirmations
      timeoutMs: 200, // Very short
    });

    const datum = createDatum();

    await expect(
      settleAndConfirm(service, datum, "head-timeout", undefined, {
        pollIntervalMs: 50,
      })
    ).rejects.toThrow(HydraBatcherException);

    await expect(
      settleAndConfirm(service, datum, "head-timeout", undefined, {
        pollIntervalMs: 50,
      })
    ).rejects.toMatchObject({
      code: HydraBatcherError.SETTLEMENT_TIMEOUT,
    });
  });
});

describe("Edge cases", () => {
  it("should handle empty batch history", async () => {
    const provider = createMockAnchorProvider({ network: "preprod" });
    const service = new L1SettlementService({
      network: "preprod",
      anchorProvider: provider,
    });

    const emptyDatum: CommitmentDatum = {
      accumulatorRoot: "empty".padEnd(64, "0"),
      commitCount: 0,
      latestBatchRoot: "empty".padEnd(64, "0"),
      latestBatchTimestamp: Date.now(),
      batchHistory: [],
    };

    const result = await service.settleToL1(emptyDatum, "head-empty");

    expect(result.totalItems).toBe(0);
    expect(result.totalCommits).toBe(0);
  });

  it("should handle very long headId", async () => {
    const provider = createMockAnchorProvider({ network: "preprod" });
    const service = new L1SettlementService({
      network: "preprod",
      anchorProvider: provider,
    });

    const longHeadId = "head-" + "x".repeat(1000);
    const datum = createDatum();

    const result = await service.settleToL1(datum, longHeadId);

    expect(result.anchorEntry.l2Metadata?.headId).toBe(longHeadId);
  });

  it("should handle special characters in metadata", async () => {
    const provider = createMockAnchorProvider({ network: "preprod" });
    const service = new L1SettlementService({
      network: "preprod",
      anchorProvider: provider,
    });

    const datum = createDatum();
    const metadata: SettlementMetadata = {
      agentId: 'agent-with-"quotes"-and-\\backslashes',
      sessionId: "session/with/slashes",
      storageUri: "ipfs://Qm?query=value&other=123",
    };

    const result = await service.settleToL1(datum, "head-special", metadata);

    expect(result.anchorEntry.agentId).toBe(metadata.agentId);
    expect(result.anchorEntry.sessionId).toBe(metadata.sessionId);
    expect(result.anchorEntry.storageUri).toBe(metadata.storageUri);
  });

  it("should support all network types", async () => {
    const networks: Array<"mainnet" | "preprod" | "preview"> = [
      "mainnet",
      "preprod",
      "preview",
    ];

    for (const network of networks) {
      const provider = createMockAnchorProvider({ network });
      const service = new L1SettlementService({
        network,
        anchorProvider: provider,
      });

      const datum = createDatum();
      const result = await service.settleToL1(datum, `head-${network}`);

      expect(result.l1TxHash).toBeDefined();
    }
  });
});
