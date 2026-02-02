/**
 * Hydra Batcher - Main class for high-frequency L2 commitment batching.
 * Orchestrates head management, batch accumulation, and settlement.
 */

import type {
  HydraBatcherConfig,
  BatchItem,
  CommitResult,
  SettlementResult,
  BatcherStatus,
  CommitRecord,
  HeadHandle,
  AnchorEntry,
  BatcherEvent,
  BatcherEventHandler,
} from "./types.js";
import {
  HydraBatcherError,
  HydraBatcherException,
} from "./types.js";
import { HeadManager } from "./head/head-manager.js";
import { BatchAccumulator } from "./commitment/batch-accumulator.js";
import { SettlementTrigger, createDefaultPolicy } from "./commitment/settlement-trigger.js";

export class HydraBatcher {
  private headManager: HeadManager;
  private accumulator: BatchAccumulator;
  private settlementTrigger: SettlementTrigger;

  private headHandle: HeadHandle | null = null;
  private commitRecords: CommitRecord[] = [];
  private totalItems = 0;
  private lastCommitTime?: string;
  private lastSettlementTime?: string;

  private commitInterval: ReturnType<typeof setInterval> | null = null;
  private pendingItems: BatchItem[] = [];
  private isCommitting = false;
  private isSettling = false;

  private eventHandlers: BatcherEventHandler[] = [];

  constructor(private readonly config: HydraBatcherConfig) {
    this.headManager = new HeadManager(config);
    this.accumulator = new BatchAccumulator();
    this.settlementTrigger = new SettlementTrigger(
      config.settlementPolicy ?? createDefaultPolicy()
    );

    // Forward head manager events
    this.headManager.onEvent((event) => this.handleHeadEvent(event));
  }

  /**
   * Connect to Hydra node and open a head.
   */
  async openHead(): Promise<HeadHandle> {
    if (this.headHandle && this.headHandle.status === "open") {
      throw new HydraBatcherException(
        HydraBatcherError.HEAD_ALREADY_OPEN,
        "Head is already open"
      );
    }

    // Connect to Hydra node
    await this.headManager.connect();

    // Open the head
    this.headHandle = await this.headManager.openHead();

    // Start commit interval if configured
    if (this.config.commitmentIntervalMs > 0) {
      this.startCommitInterval();
    }

    return this.headHandle;
  }

  /**
   * Close the head and settle to L1.
   */
  async closeHead(): Promise<SettlementResult> {
    if (!this.headHandle || this.headHandle.status !== "open") {
      throw new HydraBatcherException(
        HydraBatcherError.HEAD_NOT_OPEN,
        "Head is not open"
      );
    }

    // Stop commit interval
    this.stopCommitInterval();

    // Trigger settlement event
    this.settlementTrigger.triggerEvent("head-closing");

    // Commit any remaining items
    if (this.pendingItems.length > 0) {
      await this.flushPendingItems();
    }

    // Close the head
    await this.headManager.closeHead();

    // Execute fanout
    const fanoutUtxos = await this.headManager.fanout();

    // Build settlement result
    const result = await this.buildSettlementResult(fanoutUtxos);

    // Record settlement
    this.settlementTrigger.recordSettlement();
    this.lastSettlementTime = new Date().toISOString();
    this.commitRecords = [];
    this.totalItems = 0;

    // Disconnect
    this.headManager.disconnect();
    this.headHandle = null;

    return result;
  }

  /**
   * Add items to be committed in the next batch.
   */
  async queueItems(items: BatchItem[]): Promise<void> {
    this.validateItems(items);
    this.pendingItems.push(...items);

    // Check if we should commit immediately based on batch size
    if (this.pendingItems.length >= this.config.commitmentBatchSize) {
      await this.flushPendingItems();
    }
  }

  /**
   * Commit a batch of items immediately.
   */
  async commit(items: BatchItem[]): Promise<CommitResult> {
    if (!this.headHandle || this.headHandle.status !== "open") {
      throw new HydraBatcherException(
        HydraBatcherError.HEAD_NOT_OPEN,
        "Head is not open"
      );
    }

    if (this.isCommitting) {
      throw new HydraBatcherException(
        HydraBatcherError.COMMIT_FAILED,
        "Another commit is in progress"
      );
    }

    this.validateItems(items);

    if (items.length > this.config.commitmentBatchSize) {
      throw new HydraBatcherException(
        HydraBatcherError.BATCH_TOO_LARGE,
        `Batch size ${items.length} exceeds maximum ${this.config.commitmentBatchSize}`
      );
    }

    this.isCommitting = true;
    this.emitEvent({ type: "commit:pending", timestamp: new Date().toISOString(), data: { itemCount: items.length } });

    try {
      // Add items to accumulator
      await this.accumulator.addItems(items);

      // Commit to get new accumulator state
      const datum = await this.accumulator.commit();

      // Build and submit L2 transaction
      const txCborHex = await this.buildCommitTransaction(datum);
      const l2TxHash = await this.headManager.submitTransaction(txCborHex);

      const result: CommitResult = {
        l2TxHash,
        newAccumulatorRoot: datum.accumulatorRoot,
        commitIndex: datum.commitCount,
        timestamp: new Date().toISOString(),
        itemCount: items.length,
        snapshotNumber: this.headManager.getSnapshotNumber(),
      };

      // Record commit
      this.commitRecords.push({
        commitIndex: result.commitIndex,
        l2TxHash: result.l2TxHash,
        batchRoot: datum.latestBatchRoot,
        itemCount: result.itemCount,
        timestamp: result.timestamp,
        snapshotNumber: result.snapshotNumber,
      });

      this.totalItems += items.length;
      this.lastCommitTime = result.timestamp;

      this.emitEvent({ type: "commit:confirmed", timestamp: result.timestamp, data: result });

      // Check if we should settle
      await this.checkAndSettle();

      return result;

    } catch (error) {
      this.emitEvent({
        type: "commit:failed",
        timestamp: new Date().toISOString(),
        data: { error: String(error) },
      });
      throw error;
    } finally {
      this.isCommitting = false;
    }
  }

  /**
   * Manually trigger settlement to L1.
   */
  async settle(): Promise<SettlementResult> {
    if (!this.headHandle || this.headHandle.status !== "open") {
      throw new HydraBatcherException(
        HydraBatcherError.HEAD_NOT_OPEN,
        "Head is not open"
      );
    }

    if (this.isSettling) {
      throw new HydraBatcherException(
        HydraBatcherError.SETTLEMENT_FAILED,
        "Settlement already in progress"
      );
    }

    // Close and settle
    return this.closeHead();
  }

  /**
   * Get current batcher status.
   */
  getStatus(): BatcherStatus {
    return {
      headStatus: this.headHandle?.status ?? "closed",
      headId: this.headHandle?.headId,
      pendingItems: this.pendingItems.length,
      totalCommits: this.commitRecords.length,
      totalItems: this.totalItems,
      lastCommitTime: this.lastCommitTime,
      lastSettlementTime: this.lastSettlementTime,
      accumulatorRoot: this.accumulator.getAccumulatorRoot() || undefined,
      snapshotNumber: this.headManager.getSnapshotNumber(),
    };
  }

  /**
   * Get commit history.
   */
  getCommitHistory(): CommitRecord[] {
    return [...this.commitRecords];
  }

  /**
   * Register an event handler.
   */
  onEvent(handler: BatcherEventHandler): void {
    this.eventHandlers.push(handler);
  }

  /**
   * Remove an event handler.
   */
  offEvent(handler: BatcherEventHandler): void {
    const index = this.eventHandlers.indexOf(handler);
    if (index !== -1) {
      this.eventHandlers.splice(index, 1);
    }
  }

  /**
   * Graceful shutdown.
   */
  async shutdown(): Promise<SettlementResult | null> {
    this.stopCommitInterval();

    if (this.headHandle && this.headHandle.status === "open") {
      this.settlementTrigger.triggerEvent("shutdown");
      return this.closeHead();
    }

    return null;
  }

  // === Private Methods ===

  private validateItems(items: BatchItem[]): void {
    for (const item of items) {
      if (!item.sessionId || !item.rootHash || !item.merkleRoot || !item.manifestHash) {
        throw new HydraBatcherException(
          HydraBatcherError.INVALID_BATCH_ITEM,
          "Invalid batch item: missing required fields"
        );
      }
    }
  }

  private async flushPendingItems(): Promise<void> {
    if (this.pendingItems.length === 0) return;

    // Take up to batch size
    const items = this.pendingItems.splice(0, this.config.commitmentBatchSize);

    try {
      await this.commit(items);
    } catch (error) {
      // Put items back on failure
      this.pendingItems.unshift(...items);
      throw error;
    }
  }

  private startCommitInterval(): void {
    if (this.commitInterval) return;

    this.commitInterval = setInterval(async () => {
      if (this.pendingItems.length > 0 && !this.isCommitting) {
        try {
          await this.flushPendingItems();
        } catch (error) {
          this.debug(`Commit interval error: ${String(error)}`);
        }
      }
    }, this.config.commitmentIntervalMs);
  }

  private stopCommitInterval(): void {
    if (this.commitInterval) {
      clearInterval(this.commitInterval);
      this.commitInterval = null;
    }
  }

  private async checkAndSettle(): Promise<void> {
    const status = this.getStatus();
    const check = this.settlementTrigger.check(status);

    if (check.shouldSettle && check.priority !== "low") {
      this.debug(`Settlement triggered: ${check.reason}`);
      // Don't await - let it happen asynchronously
      this.settle().catch(error => {
        this.debug(`Settlement error: ${String(error)}`);
      });
    }
  }

  private async buildCommitTransaction(_datum: unknown): Promise<string> {
    // In production, this would:
    // 1. Find the current commitment UTxO in the head
    // 2. Build a transaction that consumes it and produces a new one with updated datum
    // 3. Serialize to CBOR

    // For now, return a placeholder - this would be implemented with cardano-serialization-lib
    // or similar in production
    const placeholder = {
      type: "Tx BabbageEra",
      description: "Commitment update transaction",
      cborHex: "84a400818258200000000000000000000000000000000000000000000000000000000000000000000182a200581d600000000000000000000000000000000000000000000000000000000001821a001e8480a0a200581d6000000000000000000000000000000000000000000000000000000000011a001e8480021a000186a0031a00989680a0f5f6",
    };
    return placeholder.cborHex;
  }

  private async buildSettlementResult(fanoutUtxos: string[]): Promise<SettlementResult> {
    const datum = await this.accumulator.getDatum();

    // Build anchor entry for L1
    const anchorEntry: AnchorEntry = {
      schema: "poi-anchor-v2",
      rootHash: datum.accumulatorRoot,
      merkleRoot: datum.accumulatorRoot, // Same for batch accumulator
      manifestHash: datum.latestBatchRoot,
      storageUri: "", // Would be set by storage adapter
      agentId: this.config.recorderNode.nodeId,
      sessionId: this.headHandle?.headId ?? "",
      timestamp: new Date().toISOString(),
      l2Metadata: {
        headId: this.headHandle?.headId ?? "",
        totalCommits: datum.commitCount,
        settlementTxHash: "", // Would be set after L1 submission
      },
    };

    // In production, would submit anchor entry to L1 via anchors-cardano
    // and get back the L1 tx hash

    return {
      l1TxHash: `tx_settlement_${Date.now().toString(16)}`,
      finalAccumulatorRoot: datum.accumulatorRoot,
      totalCommits: datum.commitCount,
      totalItems: this.totalItems,
      anchorEntry,
      fanoutUtxos,
    };
  }

  private handleHeadEvent(event: BatcherEvent): void {
    // Forward to our handlers
    this.emitEvent(event);

    // Handle specific events
    if (event.type === "head:error") {
      this.settlementTrigger.triggerEvent("error");
    }
  }

  private emitEvent(event: BatcherEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        this.debug(`Event handler error: ${String(error)}`);
      }
    }
  }

  private debug(message: string): void {
    if (this.config.debug) {
      console.log(`[HydraBatcher] ${message}`);
    }
  }
}
