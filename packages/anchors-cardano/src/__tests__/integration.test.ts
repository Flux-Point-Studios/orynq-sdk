/**
 * @fileoverview Integration tests for anchors-cardano package.
 *
 * Location: packages/anchors-cardano/src/__tests__/integration.test.ts
 *
 * Tests end-to-end workflows with mock providers:
 * - Building anchor metadata and verifying
 * - Complete anchor creation and verification cycle
 * - Batch anchoring workflows
 * - Error recovery scenarios
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildAnchorMetadata,
  buildBatchAnchorMetadata,
  validateAnchorEntry,
  serializeForCardanoCli,
  serializeForCbor,
} from "../anchor-builder.js";
import {
  verifyAnchor,
  parseAnchorMetadata,
  extractAnchorFromMetadata,
  findAnchorsInTx,
  isValidHashFormat,
} from "../anchor-verifier.js";
import { POI_METADATA_LABEL } from "../types.js";
import type { AnchorChainProvider, AnchorEntry, TxInfo } from "../types.js";

// =============================================================================
// TEST FIXTURES
// =============================================================================

/**
 * Valid 64-character lowercase hex hashes for testing.
 * Only contains valid hex characters: 0-9 and a-f
 */
const VALID_ROOT_HASH = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const VALID_MANIFEST_HASH = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const VALID_MERKLE_ROOT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TX_HASH = "aabbccdd00112233445566778899aabbccdd00112233445566778899aabbccdd";

// =============================================================================
// FULL INTEGRATION TESTS
// =============================================================================

describe("integration: build and verify anchor", () => {
  it("verifies anchor in transaction with mock provider", async () => {
    // Create a mock provider that returns the anchor metadata
    const mockProvider: AnchorChainProvider = {
      getTxMetadata: vi.fn().mockResolvedValue({
        "2222": {
          schema: "poi-anchor-v1",
          anchors: [
            {
              type: "process-trace",
              version: "1.0",
              rootHash: VALID_ROOT_HASH,
              manifestHash: VALID_MANIFEST_HASH,
              timestamp: "2024-01-01T00:00:00Z",
            },
          ],
        },
      }),
      getTxInfo: vi.fn().mockResolvedValue({
        txHash: TX_HASH,
        blockHash: "block" + "b".repeat(58),
        blockHeight: 1000,
        slot: 50000,
        timestamp: "2024-01-01T00:00:00Z",
        confirmations: 50,
      } as TxInfo),
      getNetworkId: () => "preprod" as const,
    };

    // Build anchor entry
    const entry: AnchorEntry = {
      type: "process-trace",
      version: "1.0",
      rootHash: VALID_ROOT_HASH,
      manifestHash: VALID_MANIFEST_HASH,
      timestamp: "2024-01-01T00:00:00Z",
    };

    // Validate entry
    const validation = validateAnchorEntry(entry);
    expect(validation.valid).toBe(true);

    // Build metadata
    const result = buildAnchorMetadata(entry);
    expect(result.label).toBe(2222);
    expect(result.metadata.schema).toBe("poi-anchor-v1");

    // Verify anchor
    const verification = await verifyAnchor(
      mockProvider,
      TX_HASH,
      VALID_ROOT_HASH
    );

    expect(verification.valid).toBe(true);
    expect(verification.anchor?.rootHash).toBe(VALID_ROOT_HASH);
    expect(verification.anchor?.manifestHash).toBe(VALID_MANIFEST_HASH);
    expect(verification.txInfo?.blockHeight).toBe(1000);
    expect(verification.txInfo?.confirmations).toBe(50);
    expect(verification.errors).toHaveLength(0);
  });

  it("complete cycle: build, serialize, parse, verify", async () => {
    // Step 1: Create and validate anchor entry
    const entry: AnchorEntry = {
      type: "process-trace",
      version: "1.0",
      rootHash: VALID_ROOT_HASH,
      manifestHash: VALID_MANIFEST_HASH,
      merkleRoot: VALID_MERKLE_ROOT,
      itemCount: 42,
      agentId: "test-agent-v1",
      storageUri: "ipfs://QmTest123456789",
      timestamp: new Date().toISOString(),
    };

    const validation = validateAnchorEntry(entry);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);

    // Step 2: Build anchor metadata
    const txResult = buildAnchorMetadata(entry);
    expect(txResult.label).toBe(POI_METADATA_LABEL);
    expect(txResult.metadata.anchors).toHaveLength(1);

    // Step 3: Serialize for cardano-cli
    const cliJson = serializeForCardanoCli(txResult);
    const parsedCli = JSON.parse(cliJson);
    expect(parsedCli[POI_METADATA_LABEL.toString()]).toBeDefined();

    // Step 4: Serialize for CBOR
    const cborData = serializeForCbor(txResult);
    expect(cborData[POI_METADATA_LABEL.toString()]).toBeDefined();

    // Step 5: Simulate on-chain storage and retrieval
    const mockMetadata = {
      [POI_METADATA_LABEL.toString()]: txResult.metadata,
    };

    // Step 6: Parse the metadata
    const parseResult = parseAnchorMetadata(mockMetadata);
    expect(parseResult.valid).toHaveLength(1);
    expect(parseResult.valid[0].rootHash).toBe(VALID_ROOT_HASH);
    expect(parseResult.errors).toHaveLength(0);

    // Step 7: Extract anchor metadata
    const extracted = extractAnchorFromMetadata(mockMetadata);
    expect(extracted).not.toBeNull();
    expect(extracted?.schema).toBe("poi-anchor-v1");

    // Step 8: Create mock provider and verify
    const mockProvider: AnchorChainProvider = {
      getTxMetadata: vi.fn().mockResolvedValue(mockMetadata),
      getTxInfo: vi.fn().mockResolvedValue({
        txHash: TX_HASH,
        blockHash: "block123",
        blockHeight: 5000,
        slot: 100000,
        timestamp: new Date().toISOString(),
        confirmations: 100,
      }),
      getNetworkId: () => "mainnet" as const,
    };

    const verifyResult = await verifyAnchor(
      mockProvider,
      TX_HASH,
      VALID_ROOT_HASH
    );

    expect(verifyResult.valid).toBe(true);
    expect(verifyResult.anchor?.type).toBe("process-trace");
    expect(verifyResult.anchor?.agentId).toBe("test-agent-v1");
    expect(verifyResult.anchor?.storageUri).toBe("ipfs://QmTest123456789");
    expect(verifyResult.warnings).toHaveLength(0);
  });
});

describe("integration: batch anchoring", () => {
  it("builds and verifies batch of anchors", async () => {
    // Create multiple entries
    const entries: AnchorEntry[] = [
      {
        type: "process-trace",
        version: "1.0",
        rootHash: "a".repeat(64),
        manifestHash: "b".repeat(64),
        timestamp: "2024-01-01T00:00:00Z",
        agentId: "agent-1",
      },
      {
        type: "proof-of-intent",
        version: "1.0",
        rootHash: "c".repeat(64),
        manifestHash: "d".repeat(64),
        timestamp: "2024-01-01T01:00:00Z",
        agentId: "agent-2",
      },
      {
        type: "custom",
        version: "1.0",
        rootHash: "e".repeat(64),
        manifestHash: "f".repeat(64),
        timestamp: "2024-01-01T02:00:00Z",
        agentId: "agent-3",
      },
    ];

    // Build batch metadata
    const batchResult = buildBatchAnchorMetadata(entries);
    expect(batchResult.metadata.anchors).toHaveLength(3);

    // Create mock provider with batch metadata
    const mockProvider: AnchorChainProvider = {
      getTxMetadata: vi.fn().mockResolvedValue({
        [POI_METADATA_LABEL.toString()]: batchResult.metadata,
      }),
      getTxInfo: vi.fn().mockResolvedValue({
        txHash: TX_HASH,
        blockHash: "block123",
        blockHeight: 5000,
        slot: 100000,
        timestamp: new Date().toISOString(),
        confirmations: 100,
      }),
      getNetworkId: () => "preprod" as const,
    };

    // Find all anchors
    const findResult = await findAnchorsInTx(mockProvider, TX_HASH);
    expect(findResult.anchors).toHaveLength(3);
    expect(findResult.anchors.map((a) => a.type)).toEqual([
      "process-trace",
      "proof-of-intent",
      "custom",
    ]);

    // Verify each anchor individually
    for (const entry of entries) {
      const verifyResult = await verifyAnchor(
        mockProvider,
        TX_HASH,
        entry.rootHash
      );
      expect(verifyResult.valid).toBe(true);
      expect(verifyResult.anchor?.rootHash).toBe(entry.rootHash);
    }
  });
});

describe("integration: error recovery", () => {
  it("handles transaction not found gracefully", async () => {
    const mockProvider: AnchorChainProvider = {
      getTxMetadata: vi.fn().mockResolvedValue(null),
      getTxInfo: vi.fn().mockResolvedValue(null),
      getNetworkId: () => "preprod" as const,
    };

    const result = await verifyAnchor(mockProvider, TX_HASH, VALID_ROOT_HASH);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Transaction not found");
    expect(result.anchor).toBeUndefined();
    expect(result.txInfo).toBeUndefined();
  });

  it("handles malformed metadata gracefully", async () => {
    const mockProvider: AnchorChainProvider = {
      getTxMetadata: vi.fn().mockResolvedValue({
        "2222": {
          schema: "poi-anchor-v1",
          anchors: [
            {
              // Missing required fields
              type: "process-trace",
            },
          ],
        },
      }),
      getTxInfo: vi.fn().mockResolvedValue({
        txHash: TX_HASH,
        blockHash: "block123",
        blockHeight: 1000,
        slot: 50000,
        timestamp: "2024-01-01T00:00:00Z",
        confirmations: 50,
      }),
      getNetworkId: () => "preprod" as const,
    };

    const result = await verifyAnchor(mockProvider, TX_HASH, VALID_ROOT_HASH);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("handles provider network errors", async () => {
    const mockProvider: AnchorChainProvider = {
      getTxMetadata: vi.fn().mockRejectedValue(new Error("Network timeout")),
      getTxInfo: vi.fn().mockResolvedValue(null),
      getNetworkId: () => "preprod" as const,
    };

    const result = await verifyAnchor(mockProvider, TX_HASH, VALID_ROOT_HASH);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Provider error.*Network timeout/);
  });

  it("handles hash mismatch", async () => {
    const storedHash = "a".repeat(64);
    const searchHash = "b".repeat(64);

    const mockProvider: AnchorChainProvider = {
      getTxMetadata: vi.fn().mockResolvedValue({
        "2222": {
          schema: "poi-anchor-v1",
          anchors: [
            {
              type: "process-trace",
              version: "1.0",
              rootHash: storedHash,
              manifestHash: "c".repeat(64),
              timestamp: "2024-01-01T00:00:00Z",
            },
          ],
        },
      }),
      getTxInfo: vi.fn().mockResolvedValue({
        txHash: TX_HASH,
        blockHash: "block123",
        blockHeight: 1000,
        slot: 50000,
        timestamp: "2024-01-01T00:00:00Z",
        confirmations: 50,
      }),
      getNetworkId: () => "preprod" as const,
    };

    const result = await verifyAnchor(mockProvider, TX_HASH, searchHash);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/No anchor found with rootHash/);
  });
});

describe("integration: hash format handling", () => {
  it("handles sha256: prefixed hashes in verification", async () => {
    const rawHash = "a".repeat(64);
    const prefixedHash = `sha256:${rawHash}`;

    const mockProvider: AnchorChainProvider = {
      getTxMetadata: vi.fn().mockResolvedValue({
        "2222": {
          schema: "poi-anchor-v1",
          anchors: [
            {
              type: "process-trace",
              version: "1.0",
              rootHash: rawHash, // Stored without prefix
              manifestHash: "b".repeat(64),
              timestamp: "2024-01-01T00:00:00Z",
            },
          ],
        },
      }),
      getTxInfo: vi.fn().mockResolvedValue({
        txHash: TX_HASH,
        blockHash: "block123",
        blockHeight: 1000,
        slot: 50000,
        timestamp: "2024-01-01T00:00:00Z",
        confirmations: 50,
      }),
      getNetworkId: () => "preprod" as const,
    };

    // Verify with prefixed hash
    const result = await verifyAnchor(mockProvider, TX_HASH, prefixedHash);

    expect(result.valid).toBe(true);
    expect(result.anchor?.rootHash).toBe(rawHash);
  });

  it("validates all hash formats before anchoring", () => {
    const testCases = [
      { hash: "a".repeat(64), valid: true },
      { hash: `sha256:${"b".repeat(64)}`, valid: true },
      { hash: "A".repeat(64), valid: false }, // uppercase
      { hash: "short", valid: false },
      { hash: "g".repeat(64), valid: false }, // non-hex
    ];

    for (const { hash, valid } of testCases) {
      expect(isValidHashFormat(hash)).toBe(valid);
    }
  });
});

describe("integration: network-specific behavior", () => {
  it("correctly identifies network from provider", async () => {
    const networks = ["mainnet", "preprod", "preview"] as const;

    for (const network of networks) {
      const mockProvider: AnchorChainProvider = {
        getTxMetadata: vi.fn().mockResolvedValue({
          "2222": {
            schema: "poi-anchor-v1",
            anchors: [
              {
                type: "process-trace",
                version: "1.0",
                rootHash: "a".repeat(64),
                manifestHash: "b".repeat(64),
                timestamp: "2024-01-01T00:00:00Z",
              },
            ],
          },
        }),
        getTxInfo: vi.fn().mockResolvedValue({
          txHash: TX_HASH,
          blockHash: "block123",
          blockHeight: 1000,
          slot: 50000,
          timestamp: "2024-01-01T00:00:00Z",
          confirmations: 50,
        }),
        getNetworkId: () => network,
      };

      expect(mockProvider.getNetworkId()).toBe(network);
    }
  });
});

describe("integration: CBOR serialization round-trip", () => {
  it("serializes long strings correctly for CBOR", () => {
    const longStorageUri = "ipfs://Qm" + "a".repeat(100);
    const entry: AnchorEntry = {
      type: "process-trace",
      version: "1.0",
      rootHash: VALID_ROOT_HASH,
      manifestHash: VALID_MANIFEST_HASH,
      storageUri: longStorageUri,
      timestamp: "2024-01-01T00:00:00Z",
    };

    const txResult = buildAnchorMetadata(entry);
    const cborData = serializeForCbor(txResult);

    const anchors = (cborData[POI_METADATA_LABEL.toString()] as Record<string, unknown>)
      .anchors as unknown[];
    const firstAnchor = anchors[0] as Record<string, unknown>;

    // StorageUri should be chunked
    expect(Array.isArray(firstAnchor.storageUri)).toBe(true);

    // Reconstruct and verify
    const reconstructed = (firstAnchor.storageUri as string[]).join("");
    expect(reconstructed).toBe(longStorageUri);
  });

  it("preserves short strings as-is in CBOR serialization", () => {
    const shortUri = "ipfs://QmShort";
    const entry: AnchorEntry = {
      type: "process-trace",
      version: "1.0",
      rootHash: VALID_ROOT_HASH,
      manifestHash: VALID_MANIFEST_HASH,
      storageUri: shortUri,
      timestamp: "2024-01-01T00:00:00Z",
    };

    const txResult = buildAnchorMetadata(entry);
    const cborData = serializeForCbor(txResult);

    const anchors = (cborData[POI_METADATA_LABEL.toString()] as Record<string, unknown>)
      .anchors as unknown[];
    const firstAnchor = anchors[0] as Record<string, unknown>;

    // Short storageUri should remain a string
    expect(typeof firstAnchor.storageUri).toBe("string");
    expect(firstAnchor.storageUri).toBe(shortUri);
  });
});

describe("integration: low confirmation warning", () => {
  it("warns when confirmations are below threshold", async () => {
    const mockProvider: AnchorChainProvider = {
      getTxMetadata: vi.fn().mockResolvedValue({
        "2222": {
          schema: "poi-anchor-v1",
          anchors: [
            {
              type: "process-trace",
              version: "1.0",
              rootHash: VALID_ROOT_HASH,
              manifestHash: VALID_MANIFEST_HASH,
              timestamp: "2024-01-01T00:00:00Z",
            },
          ],
        },
      }),
      getTxInfo: vi.fn().mockResolvedValue({
        txHash: TX_HASH,
        blockHash: "block123",
        blockHeight: 1000,
        slot: 50000,
        timestamp: "2024-01-01T00:00:00Z",
        confirmations: 3, // Low confirmations
      }),
      getNetworkId: () => "mainnet" as const,
    };

    const result = await verifyAnchor(mockProvider, TX_HASH, VALID_ROOT_HASH);

    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("Low confirmation"))).toBe(
      true
    );
    expect(result.warnings.some((w) => w.includes("3"))).toBe(true);
  });

  it("does not warn when confirmations are sufficient", async () => {
    const mockProvider: AnchorChainProvider = {
      getTxMetadata: vi.fn().mockResolvedValue({
        "2222": {
          schema: "poi-anchor-v1",
          anchors: [
            {
              type: "process-trace",
              version: "1.0",
              rootHash: VALID_ROOT_HASH,
              manifestHash: VALID_MANIFEST_HASH,
              timestamp: "2024-01-01T00:00:00Z",
            },
          ],
        },
      }),
      getTxInfo: vi.fn().mockResolvedValue({
        txHash: TX_HASH,
        blockHash: "block123",
        blockHeight: 1000,
        slot: 50000,
        timestamp: "2024-01-01T00:00:00Z",
        confirmations: 100, // Sufficient confirmations
      }),
      getNetworkId: () => "mainnet" as const,
    };

    const result = await verifyAnchor(mockProvider, TX_HASH, VALID_ROOT_HASH);

    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("Low confirmation"))).toBe(
      false
    );
  });
});
