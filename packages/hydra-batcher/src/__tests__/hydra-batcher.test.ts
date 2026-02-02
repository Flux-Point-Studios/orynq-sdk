/**
 * Tests for hydra-batcher package.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { BatchAccumulator } from "../commitment/batch-accumulator.js";
import {
  SettlementTrigger,
  createDefaultPolicy,
  createHighFrequencyPolicy,
  createLowFrequencyPolicy,
} from "../commitment/settlement-trigger.js";
import { MetricsCollector, HealthChecker } from "../monitor/metrics.js";
import type { BatchItem, BatcherStatus } from "../types.js";

describe("BatchAccumulator", () => {
  let accumulator: BatchAccumulator;

  beforeEach(() => {
    accumulator = new BatchAccumulator();
  });

  const createItem = (id: string): BatchItem => ({
    sessionId: `session-${id}`,
    rootHash: `root-${id}`,
    merkleRoot: `merkle-${id}`,
    manifestHash: `manifest-${id}`,
    timestamp: new Date().toISOString(),
  });

  it("should start empty", () => {
    expect(accumulator.getBatchSize()).toBe(0);
    expect(accumulator.getCommitCount()).toBe(0);
    expect(accumulator.getAccumulatorRoot()).toBe("");
  });

  it("should add items to batch", async () => {
    await accumulator.addItems([createItem("1"), createItem("2")]);
    expect(accumulator.getBatchSize()).toBe(2);
  });

  it("should compute batch root", async () => {
    await accumulator.addItems([createItem("1")]);
    const root = await accumulator.computeBatchRoot();
    expect(root).toHaveLength(64);
  });

  it("should commit and update accumulator", async () => {
    await accumulator.addItems([createItem("1"), createItem("2")]);
    const datum = await accumulator.commit();

    expect(datum.commitCount).toBe(1);
    expect(datum.accumulatorRoot).toHaveLength(64);
    expect(datum.latestBatchRoot).toHaveLength(64);
    expect(datum.batchHistory).toHaveLength(1);

    // Batch should be cleared
    expect(accumulator.getBatchSize()).toBe(0);
  });

  it("should chain multiple commits", async () => {
    await accumulator.addItems([createItem("1")]);
    const datum1 = await accumulator.commit();

    await accumulator.addItems([createItem("2")]);
    const datum2 = await accumulator.commit();

    expect(datum2.commitCount).toBe(2);
    expect(datum2.accumulatorRoot).not.toBe(datum1.accumulatorRoot);
    expect(datum2.batchHistory).toHaveLength(2);
  });

  it("should generate inclusion proofs", async () => {
    await accumulator.addItems([
      createItem("1"),
      createItem("2"),
      createItem("3"),
      createItem("4"),
    ]);

    const proof = await accumulator.generateInclusionProof(1);
    expect(proof.length).toBeGreaterThan(0);
  });

  it("should export and import state", async () => {
    await accumulator.addItems([createItem("1")]);
    await accumulator.commit();
    await accumulator.addItems([createItem("2")]);

    const state = accumulator.exportState();

    const newAccumulator = new BatchAccumulator();
    newAccumulator.importState(state);

    expect(newAccumulator.getCommitCount()).toBe(1);
    expect(newAccumulator.getBatchSize()).toBe(1);
    expect(newAccumulator.getAccumulatorRoot()).toBe(state.accumulatorRoot);
  });

  it("should reset state", async () => {
    await accumulator.addItems([createItem("1")]);
    await accumulator.commit();

    accumulator.reset();

    expect(accumulator.getBatchSize()).toBe(0);
    expect(accumulator.getCommitCount()).toBe(0);
    expect(accumulator.getAccumulatorRoot()).toBe("");
  });
});

describe("SettlementTrigger", () => {
  describe("with default policy", () => {
    let trigger: SettlementTrigger;

    beforeEach(() => {
      trigger = new SettlementTrigger(createDefaultPolicy());
    });

    const createStatus = (totalCommits: number): BatcherStatus => ({
      headStatus: "open",
      headId: "test-head-id",
      pendingItems: 0,
      totalCommits,
      totalItems: totalCommits * 10,
      lastCommitTime: undefined,
      lastSettlementTime: undefined,
      accumulatorRoot: undefined,
      snapshotNumber: totalCommits,
    });

    it("should not trigger settlement below thresholds", () => {
      const check = trigger.check(createStatus(10));
      expect(check.shouldSettle).toBe(false);
    });

    it("should trigger settlement at max commits", () => {
      const check = trigger.check(createStatus(1000));
      expect(check.shouldSettle).toBe(true);
      expect(check.reason).toBe("max_commits_reached");
    });

    it("should trigger settlement on event", () => {
      trigger.triggerEvent("shutdown");
      const check = trigger.check(createStatus(10));
      expect(check.shouldSettle).toBe(true);
      expect(check.reason).toBe("event_triggered");
      expect(check.priority).toBe("critical");
    });

    it("should clear events after settlement", () => {
      trigger.triggerEvent("error");
      trigger.recordSettlement();
      const check = trigger.check(createStatus(10));
      expect(check.shouldSettle).toBe(false);
    });
  });

  describe("policy variants", () => {
    it("should create high frequency policy", () => {
      const policy = createHighFrequencyPolicy();
      expect(policy.maxCommitsBeforeSettlement).toBe(100);
      expect(policy.maxTimeBeforeSettlementMs).toBe(300000);
    });

    it("should create low frequency policy", () => {
      const policy = createLowFrequencyPolicy();
      expect(policy.maxCommitsBeforeSettlement).toBe(10000);
      expect(policy.maxTimeBeforeSettlementMs).toBe(86400000);
    });
  });
});

describe("MetricsCollector", () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  it("should record commits", () => {
    collector.recordCommit(10, 50, 1024);
    collector.recordCommit(20, 100, 2048);

    const metrics = collector.getMetrics(100, 5);

    expect(metrics.totalItems).toBe(30);
    expect(metrics.totalCommits).toBe(2);
    expect(metrics.avgCommitLatency).toBe(75);
  });

  it("should record failures", () => {
    collector.recordCommitFailure();
    collector.recordCommitFailure();
    collector.recordSettlementFailure();

    const metrics = collector.getMetrics(0, 0);

    expect(metrics.failedCommits).toBe(2);
    expect(metrics.failedSettlements).toBe(1);
  });

  it("should calculate percentiles", () => {
    // Add samples
    for (let i = 1; i <= 100; i++) {
      collector.recordCommit(1, i);
    }

    const metrics = collector.getMetrics(0, 0);

    expect(metrics.p95CommitLatency).toBe(95);
    expect(metrics.p99CommitLatency).toBe(99);
  });

  it("should track head status", () => {
    collector.recordHeadConnect();

    // Uptime should be >= 0 after connection (may be 0 if called immediately)
    const metrics = collector.getMetrics(0, 0);
    expect(metrics.headUptime).toBeGreaterThanOrEqual(0);

    collector.recordHeadDisconnect();

    // Uptime should be 0 after disconnect
    const metricsAfterDisconnect = collector.getMetrics(0, 0);
    expect(metricsAfterDisconnect.headUptime).toBe(0);

    collector.recordHeadReconnect();

    const metrics2 = collector.getMetrics(0, 0);
    expect(metrics2.headReconnects).toBe(1);
    expect(metrics2.headUptime).toBeGreaterThanOrEqual(0);
  });

  it("should export prometheus format", () => {
    collector.recordCommit(10, 50);

    const prometheus = collector.toPrometheus();

    expect(prometheus).toContain("poi_hydra_batcher_items_total 10");
    expect(prometheus).toContain("poi_hydra_batcher_commits_total 1");
  });

  it("should reset metrics", () => {
    collector.recordCommit(10, 50);
    collector.reset();

    const metrics = collector.getMetrics(0, 0);
    expect(metrics.totalItems).toBe(0);
    expect(metrics.totalCommits).toBe(0);
  });
});

describe("HealthChecker", () => {
  let checker: HealthChecker;

  beforeEach(() => {
    checker = new HealthChecker(5000, 60000);
  });

  it("should report healthy when all checks pass", () => {
    const metrics = {
      itemsPerSecond: 10,
      commitsPerSecond: 1,
      bytesPerSecond: 1000,
      totalItems: 100,
      totalCommits: 10,
      totalSettlements: 1,
      failedCommits: 0,
      failedSettlements: 0,
      avgCommitLatency: 50,
      p95CommitLatency: 100,
      p99CommitLatency: 200,
      avgSettlementLatency: 1000,
      headUptime: 3600,
      headReconnects: 0,
      accumulatorSize: 100,
      pendingItems: 5,
      startTime: new Date().toISOString(),
      lastCommitTime: undefined,
      lastSettlementTime: undefined,
    };

    const status = checker.check(metrics, true);

    expect(status.healthy).toBe(true);
    expect(status.status).toBe("healthy");
    expect(status.checks.headConnected).toBe(true);
    expect(status.checks.commitsWorking).toBe(true);
    expect(status.checks.latencyAcceptable).toBe(true);
    expect(status.checks.noRecentErrors).toBe(true);
  });

  it("should report unhealthy when head disconnected", () => {
    const metrics = {
      itemsPerSecond: 0,
      commitsPerSecond: 0,
      bytesPerSecond: 0,
      totalItems: 0,
      totalCommits: 0,
      totalSettlements: 0,
      failedCommits: 0,
      failedSettlements: 0,
      avgCommitLatency: 0,
      p95CommitLatency: 0,
      p99CommitLatency: 0,
      avgSettlementLatency: 0,
      headUptime: 0,
      headReconnects: 0,
      accumulatorSize: 0,
      pendingItems: 0,
      startTime: new Date().toISOString(),
      lastCommitTime: undefined,
      lastSettlementTime: undefined,
    };

    const status = checker.check(metrics, false);

    expect(status.healthy).toBe(false);
    expect(status.checks.headConnected).toBe(false);
  });

  it("should report degraded with recent errors", () => {
    checker.recordError("Test error");

    const metrics = {
      itemsPerSecond: 10,
      commitsPerSecond: 1,
      bytesPerSecond: 1000,
      totalItems: 100,
      totalCommits: 10,
      totalSettlements: 1,
      failedCommits: 0,
      failedSettlements: 0,
      avgCommitLatency: 50,
      p95CommitLatency: 100,
      p99CommitLatency: 200,
      avgSettlementLatency: 1000,
      headUptime: 3600,
      headReconnects: 0,
      accumulatorSize: 100,
      pendingItems: 5,
      startTime: new Date().toISOString(),
      lastCommitTime: undefined,
      lastSettlementTime: undefined,
    };

    const status = checker.check(metrics, true);

    expect(status.healthy).toBe(false);
    expect(status.status).toBe("degraded");
    expect(status.checks.noRecentErrors).toBe(false);
    expect(status.lastError).toBe("Test error");
  });

  it("should clear error state", () => {
    checker.recordError("Test error");
    checker.clearError();

    const metrics = {
      itemsPerSecond: 10,
      commitsPerSecond: 1,
      bytesPerSecond: 1000,
      totalItems: 100,
      totalCommits: 10,
      totalSettlements: 1,
      failedCommits: 0,
      failedSettlements: 0,
      avgCommitLatency: 50,
      p95CommitLatency: 100,
      p99CommitLatency: 200,
      avgSettlementLatency: 1000,
      headUptime: 3600,
      headReconnects: 0,
      accumulatorSize: 100,
      pendingItems: 5,
      startTime: new Date().toISOString(),
      lastCommitTime: undefined,
      lastSettlementTime: undefined,
    };

    const status = checker.check(metrics, true);
    expect(status.checks.noRecentErrors).toBe(true);
    expect(status.lastError).toBeUndefined();
  });
});
