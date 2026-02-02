/**
 * Location: packages/hydra-batcher/src/__tests__/l2-tx-builder.test.ts
 *
 * Unit tests for the L2TransactionBuilder class.
 *
 * Tests cover:
 * - Building commitment transactions with existing UTxO
 * - Building initial commitment transactions
 * - Merkle root computation
 * - CBOR serialization
 * - Edge cases and error handling
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  L2TransactionBuilder,
  computeBatchMerkleRoot,
  buildCommitmentTransaction,
  buildInitialCommitmentTransaction,
} from "../tx/l2-tx-builder.js";
import type { BatchItem, CommitmentDatum, HydraUtxo } from "../types.js";

/**
 * Helper to create a test BatchItem.
 */
const createItem = (id: string): BatchItem => ({
  sessionId: `session-${id}`,
  rootHash: `root-${id}`.padEnd(64, "0"),
  merkleRoot: `merkle-${id}`.padEnd(64, "0"),
  manifestHash: `manifest-${id}`.padEnd(64, "0"),
  timestamp: new Date().toISOString(),
});

/**
 * Helper to create a test CommitmentDatum.
 */
const createDatum = (commitCount: number = 0, accumulatorRoot: string = ""): CommitmentDatum => ({
  accumulatorRoot,
  commitCount,
  latestBatchRoot: accumulatorRoot,
  latestBatchTimestamp: Date.now(),
  batchHistory: commitCount > 0 ? [{
    batchRoot: accumulatorRoot,
    timestamp: Date.now() - 1000,
    itemCount: 10,
  }] : [],
});

/**
 * Helper to create a test HydraUtxo.
 */
const createUtxo = (txIn: string = "abc123#0", lovelace: bigint = BigInt(5_000_000)): HydraUtxo => ({
  txIn,
  address: "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp",
  value: {
    lovelace,
  },
  datum: undefined,
  datumHash: undefined,
});

describe("L2TransactionBuilder", () => {
  let builder: L2TransactionBuilder;

  beforeEach(() => {
    builder = new L2TransactionBuilder();
  });

  describe("buildCommitmentTx", () => {
    it("should build a commitment transaction with valid inputs", async () => {
      const items = [createItem("1"), createItem("2")];
      const currentDatum = createDatum(1, "a".repeat(64));
      const currentUtxo = createUtxo();

      const result = await builder.buildCommitmentTx(items, currentDatum, currentUtxo);

      expect(result.transaction).toBeDefined();
      expect(result.transaction.inputs).toEqual([currentUtxo.txIn]);
      expect(result.transaction.outputs).toHaveLength(1);
      expect(result.cborHex).toBeDefined();
      expect(result.cborHex).toMatch(/^84/); // CBOR array prefix
      expect(result.newDatum).toBeDefined();
      expect(result.newDatum.commitCount).toBe(2);
      expect(result.batchRoot).toHaveLength(64);
    });

    it("should chain accumulator root from previous commits", async () => {
      const items = [createItem("1")];
      const previousRoot = "b".repeat(64);
      const currentDatum = createDatum(5, previousRoot);
      const currentUtxo = createUtxo();

      const result = await builder.buildCommitmentTx(items, currentDatum, currentUtxo);

      // New accumulator should be different from both batch root and previous root
      expect(result.newDatum.accumulatorRoot).not.toBe(previousRoot);
      expect(result.newDatum.accumulatorRoot).not.toBe(result.batchRoot);
      expect(result.newDatum.accumulatorRoot).toHaveLength(64);
    });

    it("should preserve output address from input UTxO", async () => {
      const items = [createItem("1")];
      const currentDatum = createDatum();
      const currentUtxo = createUtxo("tx1#0", BigInt(10_000_000));

      const result = await builder.buildCommitmentTx(items, currentDatum, currentUtxo);

      expect(result.transaction.outputs[0]?.address).toBe(currentUtxo.address);
    });

    it("should ensure minimum lovelace in output", async () => {
      const items = [createItem("1")];
      const currentDatum = createDatum();
      const currentUtxo = createUtxo("tx1#0", BigInt(1_000_000)); // Less than default minimum

      const result = await builder.buildCommitmentTx(items, currentDatum, currentUtxo, {
        minLovelace: BigInt(2_000_000),
      });

      expect(result.transaction.outputs[0]?.value.lovelace).toBe(BigInt(2_000_000));
    });

    it("should preserve existing lovelace if above minimum", async () => {
      const items = [createItem("1")];
      const currentDatum = createDatum();
      const currentUtxo = createUtxo("tx1#0", BigInt(10_000_000));

      const result = await builder.buildCommitmentTx(items, currentDatum, currentUtxo);

      expect(result.transaction.outputs[0]?.value.lovelace).toBe(BigInt(10_000_000));
    });

    it("should trim batch history when exceeding max entries", async () => {
      const items = [createItem("1")];
      const currentDatum: CommitmentDatum = {
        accumulatorRoot: "a".repeat(64),
        commitCount: 100,
        latestBatchRoot: "b".repeat(64),
        latestBatchTimestamp: Date.now(),
        batchHistory: Array(100).fill(null).map((_, i) => ({
          batchRoot: i.toString(16).padStart(64, "0"),
          timestamp: Date.now() - (100 - i) * 1000,
          itemCount: 10,
        })),
      };
      const currentUtxo = createUtxo();

      const result = await builder.buildCommitmentTx(items, currentDatum, currentUtxo, {
        maxHistoryEntries: 50,
      });

      expect(result.newDatum.batchHistory.length).toBe(50);
      // Should have the most recent entries
      expect(result.newDatum.batchHistory[result.newDatum.batchHistory.length - 1]?.batchRoot)
        .toBe(result.batchRoot);
    });

    it("should update latestBatchRoot and latestBatchTimestamp", async () => {
      const items = [createItem("1"), createItem("2")];
      const currentDatum = createDatum(1, "old".padEnd(64, "0"));
      const currentUtxo = createUtxo();

      const timeBefore = Date.now();
      const result = await builder.buildCommitmentTx(items, currentDatum, currentUtxo);
      const timeAfter = Date.now();

      expect(result.newDatum.latestBatchRoot).toBe(result.batchRoot);
      expect(result.newDatum.latestBatchTimestamp).toBeGreaterThanOrEqual(timeBefore);
      expect(result.newDatum.latestBatchTimestamp).toBeLessThanOrEqual(timeAfter);
    });

    it("should include datum in output", async () => {
      const items = [createItem("1")];
      const currentDatum = createDatum();
      const currentUtxo = createUtxo();

      const result = await builder.buildCommitmentTx(items, currentDatum, currentUtxo);

      expect(result.transaction.outputs[0]?.datum).toEqual(result.newDatum);
    });
  });

  describe("buildInitialCommitmentTx", () => {
    it("should build an initial commitment transaction", async () => {
      const items = [createItem("1"), createItem("2"), createItem("3")];
      const address = "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp";

      const result = await builder.buildInitialCommitmentTx(items, address);

      expect(result.transaction).toBeDefined();
      expect(result.transaction.inputs).toHaveLength(0); // No inputs for initial
      expect(result.transaction.outputs).toHaveLength(1);
      expect(result.transaction.outputs[0]?.address).toBe(address);
      expect(result.newDatum.commitCount).toBe(1);
      expect(result.newDatum.batchHistory).toHaveLength(1);
      expect(result.newDatum.accumulatorRoot).toBe(result.batchRoot);
    });

    it("should use minimum lovelace for initial output", async () => {
      const items = [createItem("1")];
      const address = "addr_test1";

      const result = await builder.buildInitialCommitmentTx(items, address, {
        minLovelace: BigInt(5_000_000),
      });

      expect(result.transaction.outputs[0]?.value.lovelace).toBe(BigInt(5_000_000));
    });

    it("should set accumulator root equal to batch root for initial commit", async () => {
      const items = [createItem("1"), createItem("2")];
      const address = "addr_test1";

      const result = await builder.buildInitialCommitmentTx(items, address);

      expect(result.newDatum.accumulatorRoot).toBe(result.batchRoot);
      expect(result.newDatum.latestBatchRoot).toBe(result.batchRoot);
    });
  });

  describe("toCborHex", () => {
    it("should throw error if no transaction is built", () => {
      expect(() => builder.toCborHex()).toThrow("No transaction built");
    });

    it("should return valid CBOR hex after building transaction", async () => {
      const items = [createItem("1")];
      const currentDatum = createDatum();
      const currentUtxo = createUtxo();

      await builder.buildCommitmentTx(items, currentDatum, currentUtxo);
      const cborHex = builder.toCborHex();

      // Should start with CBOR array(4) prefix
      expect(cborHex).toMatch(/^84/);
      // Should be valid hex string (even length, only hex chars)
      expect(cborHex.length % 2).toBe(0);
      expect(cborHex).toMatch(/^[0-9a-f]+$/i);
    });

    it("should produce consistent CBOR for same inputs", async () => {
      const items = [createItem("1")];
      const currentDatum = createDatum(0, "");
      const currentUtxo = createUtxo("fixedtx#0", BigInt(5_000_000));

      // Build same transaction twice
      const builder1 = new L2TransactionBuilder();
      const builder2 = new L2TransactionBuilder();

      const result1 = await builder1.buildCommitmentTx(items, currentDatum, currentUtxo);
      const result2 = await builder2.buildCommitmentTx(items, currentDatum, currentUtxo);

      // Batch roots should be identical (same items)
      expect(result1.batchRoot).toBe(result2.batchRoot);
      // New accumulator roots should be identical
      expect(result1.newDatum.accumulatorRoot).toBe(result2.newDatum.accumulatorRoot);
    });
  });

  describe("getTransaction", () => {
    it("should return null before building", () => {
      expect(builder.getTransaction()).toBeNull();
    });

    it("should return transaction after building", async () => {
      const items = [createItem("1")];
      await builder.buildCommitmentTx(items, createDatum(), createUtxo());

      const tx = builder.getTransaction();
      expect(tx).not.toBeNull();
      expect(tx?.txId).toBeDefined();
    });
  });

  describe("getDatum", () => {
    it("should return null before building", () => {
      expect(builder.getDatum()).toBeNull();
    });

    it("should return datum after building", async () => {
      const items = [createItem("1")];
      await builder.buildCommitmentTx(items, createDatum(), createUtxo());

      const datum = builder.getDatum();
      expect(datum).not.toBeNull();
      expect(datum?.commitCount).toBe(1);
    });
  });

  describe("getBatchRoot", () => {
    it("should return empty string before building", () => {
      expect(builder.getBatchRoot()).toBe("");
    });

    it("should return batch root after building", async () => {
      const items = [createItem("1")];
      await builder.buildCommitmentTx(items, createDatum(), createUtxo());

      const batchRoot = builder.getBatchRoot();
      expect(batchRoot).toHaveLength(64);
    });
  });
});

describe("computeBatchMerkleRoot", () => {
  it("should compute a deterministic root for items", async () => {
    const items = [createItem("1"), createItem("2")];

    const root1 = await computeBatchMerkleRoot(items);
    const root2 = await computeBatchMerkleRoot(items);

    expect(root1).toBe(root2);
    expect(root1).toHaveLength(64);
  });

  it("should produce different roots for different items", async () => {
    const items1 = [createItem("1")];
    const items2 = [createItem("2")];

    const root1 = await computeBatchMerkleRoot(items1);
    const root2 = await computeBatchMerkleRoot(items2);

    expect(root1).not.toBe(root2);
  });

  it("should handle empty items array", async () => {
    const root = await computeBatchMerkleRoot([]);

    expect(root).toHaveLength(64);
    // Empty batch has a specific domain-separated hash
    expect(root).toBeDefined();
  });

  it("should handle single item", async () => {
    const items = [createItem("1")];

    const root = await computeBatchMerkleRoot(items);

    expect(root).toHaveLength(64);
  });

  it("should handle many items", async () => {
    const items = Array(100).fill(null).map((_, i) => createItem(i.toString()));

    const root = await computeBatchMerkleRoot(items);

    expect(root).toHaveLength(64);
  });

  it("should be order-sensitive", async () => {
    const items1 = [createItem("1"), createItem("2")];
    const items2 = [createItem("2"), createItem("1")];

    const root1 = await computeBatchMerkleRoot(items1);
    const root2 = await computeBatchMerkleRoot(items2);

    expect(root1).not.toBe(root2);
  });
});

describe("buildCommitmentTransaction (convenience function)", () => {
  it("should build a commitment transaction", async () => {
    const items = [createItem("1")];
    const currentDatum = createDatum();
    const currentUtxo = createUtxo();

    const result = await buildCommitmentTransaction(items, currentDatum, currentUtxo);

    expect(result.transaction).toBeDefined();
    expect(result.cborHex).toBeDefined();
    expect(result.newDatum).toBeDefined();
    expect(result.batchRoot).toBeDefined();
  });
});

describe("buildInitialCommitmentTransaction (convenience function)", () => {
  it("should build an initial commitment transaction", async () => {
    const items = [createItem("1")];
    const address = "addr_test1";

    const result = await buildInitialCommitmentTransaction(items, address);

    expect(result.transaction).toBeDefined();
    expect(result.cborHex).toBeDefined();
    expect(result.newDatum).toBeDefined();
    expect(result.newDatum.commitCount).toBe(1);
  });
});

describe("Edge cases", () => {
  it("should handle items with special characters in fields", async () => {
    const item: BatchItem = {
      sessionId: "session-with-\"quotes\"-and-\\backslashes",
      rootHash: "root".padEnd(64, "0"),
      merkleRoot: "merkle".padEnd(64, "0"),
      manifestHash: "manifest".padEnd(64, "0"),
      timestamp: new Date().toISOString(),
    };

    const builder = new L2TransactionBuilder();
    const result = await builder.buildCommitmentTx([item], createDatum(), createUtxo());

    expect(result.batchRoot).toHaveLength(64);
    expect(result.transaction).toBeDefined();
  });

  it("should handle UTxO with assets", async () => {
    const items = [createItem("1")];
    const currentDatum = createDatum();
    const currentUtxo: HydraUtxo = {
      ...createUtxo(),
      value: {
        lovelace: BigInt(5_000_000),
        assets: {
          "policyId.assetName": BigInt(1000),
        },
      },
    };

    const builder = new L2TransactionBuilder();
    const result = await builder.buildCommitmentTx(items, currentDatum, currentUtxo);

    expect(result.transaction.outputs[0]?.value.assets).toEqual(currentUtxo.value.assets);
  });

  it("should handle first commit (empty accumulator root)", async () => {
    const items = [createItem("1")];
    const currentDatum = createDatum(0, "");
    const currentUtxo = createUtxo();

    const builder = new L2TransactionBuilder();
    const result = await builder.buildCommitmentTx(items, currentDatum, currentUtxo);

    // First commit should have accumulator root equal to batch root
    expect(result.newDatum.accumulatorRoot).toBe(result.batchRoot);
    expect(result.newDatum.commitCount).toBe(1);
  });

  it("should generate unique transaction IDs for different transactions", async () => {
    const builder1 = new L2TransactionBuilder();
    const builder2 = new L2TransactionBuilder();

    const result1 = await builder1.buildCommitmentTx(
      [createItem("1")],
      createDatum(),
      createUtxo("tx1#0")
    );

    // Small delay to ensure different timestamp
    await new Promise(resolve => setTimeout(resolve, 10));

    const result2 = await builder2.buildCommitmentTx(
      [createItem("1")],
      createDatum(),
      createUtxo("tx2#0")
    );

    expect(result1.transaction.txId).not.toBe(result2.transaction.txId);
  });
});
