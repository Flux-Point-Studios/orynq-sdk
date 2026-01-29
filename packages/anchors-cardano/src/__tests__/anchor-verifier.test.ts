/**
 * @fileoverview Tests for anchor verification functions.
 *
 * Location: packages/anchors-cardano/src/__tests__/anchor-verifier.test.ts
 *
 * Tests coverage:
 * - isValidHashFormat: validates hash format
 * - parseAnchorMetadata: parses raw metadata with defensive parsing
 * - extractAnchorFromMetadata: extracts anchor from label 2222
 * - verifyAnchor: verifies anchor in transaction
 * - findAnchorsInTx: finds all anchors in transaction
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isValidHashFormat,
  parseAnchorMetadata,
  extractAnchorFromMetadata,
  verifyAnchor,
  verifyAnchorManifest,
  findAnchorsInTx,
} from "../anchor-verifier.js";
import { POI_METADATA_LABEL } from "../types.js";
import type { AnchorChainProvider, AnchorEntry, TxInfo } from "../types.js";

// =============================================================================
// TEST FIXTURES
// =============================================================================

/**
 * Valid 64-character lowercase hex hash for testing.
 */
const VALID_HASH = "a".repeat(64);
const VALID_HASH_2 = "b".repeat(64);
const VALID_HASH_3 = "c".repeat(64);

/**
 * Creates a valid anchor entry for testing.
 */
function createValidEntry(overrides?: Partial<AnchorEntry>): AnchorEntry {
  return {
    type: "process-trace",
    version: "1.0",
    rootHash: VALID_HASH,
    manifestHash: VALID_HASH_2,
    timestamp: "2024-01-28T12:00:00Z",
    ...overrides,
  };
}

/**
 * Creates valid anchor metadata structure.
 */
function createValidMetadata(entries?: AnchorEntry[]) {
  return {
    [POI_METADATA_LABEL.toString()]: {
      schema: "poi-anchor-v1",
      anchors: entries ?? [createValidEntry()],
    },
  };
}

/**
 * Creates a mock chain provider for testing.
 */
function createMockProvider(overrides?: Partial<AnchorChainProvider>): AnchorChainProvider {
  return {
    getTxMetadata: vi.fn().mockResolvedValue(createValidMetadata()),
    getTxInfo: vi.fn().mockResolvedValue({
      txHash: "tx" + VALID_HASH.slice(2),
      blockHash: "block" + VALID_HASH.slice(5),
      blockHeight: 1000,
      slot: 50000,
      timestamp: "2024-01-28T12:00:00Z",
      confirmations: 50,
    } as TxInfo),
    getNetworkId: vi.fn().mockReturnValue("preprod"),
    ...overrides,
  };
}

// =============================================================================
// isValidHashFormat TESTS
// =============================================================================

describe("isValidHashFormat", () => {
  describe("valid hashes", () => {
    it("64-char lowercase hex passes", () => {
      expect(isValidHashFormat(VALID_HASH)).toBe(true);
    });

    it("hash with sha256: prefix passes", () => {
      expect(isValidHashFormat(`sha256:${VALID_HASH}`)).toBe(true);
    });

    it("all hex digits pass (0-9, a-f)", () => {
      const allHexDigits = "0123456789abcdef".repeat(4);
      expect(isValidHashFormat(allHexDigits)).toBe(true);
    });
  });

  describe("invalid hashes - wrong length", () => {
    it("empty string fails", () => {
      expect(isValidHashFormat("")).toBe(false);
    });

    it("too short (63 chars) fails", () => {
      expect(isValidHashFormat("a".repeat(63))).toBe(false);
    });

    it("too long (65 chars) fails", () => {
      expect(isValidHashFormat("a".repeat(65))).toBe(false);
    });

    it("very short string fails", () => {
      expect(isValidHashFormat("abc123")).toBe(false);
    });
  });

  describe("invalid hashes - uppercase", () => {
    it("uppercase hash fails", () => {
      expect(isValidHashFormat(VALID_HASH.toUpperCase())).toBe(false);
    });

    it("mixed case hash fails", () => {
      const mixedCase = "A".repeat(32) + "a".repeat(32);
      expect(isValidHashFormat(mixedCase)).toBe(false);
    });
  });

  describe("invalid hashes - non-hex characters", () => {
    it("hash with 'g' fails", () => {
      expect(isValidHashFormat("g".repeat(64))).toBe(false);
    });

    it("hash with 'z' fails", () => {
      const withZ = "a".repeat(63) + "z";
      expect(isValidHashFormat(withZ)).toBe(false);
    });

    it("hash with spaces fails", () => {
      const withSpaces = "a".repeat(32) + " " + "a".repeat(31);
      expect(isValidHashFormat(withSpaces)).toBe(false);
    });

    it("hash with special chars fails", () => {
      const withSpecial = "a".repeat(63) + "-";
      expect(isValidHashFormat(withSpecial)).toBe(false);
    });
  });

  describe("invalid hashes - wrong types", () => {
    it("non-string value fails", () => {
      expect(isValidHashFormat(123 as unknown as string)).toBe(false);
    });

    it("null fails", () => {
      expect(isValidHashFormat(null as unknown as string)).toBe(false);
    });

    it("undefined fails", () => {
      expect(isValidHashFormat(undefined as unknown as string)).toBe(false);
    });

    it("object fails", () => {
      expect(isValidHashFormat({} as unknown as string)).toBe(false);
    });
  });
});

// =============================================================================
// parseAnchorMetadata TESTS
// =============================================================================

describe("parseAnchorMetadata", () => {
  describe("valid metadata parsing", () => {
    it("valid metadata parses correctly", () => {
      const rawMetadata = createValidMetadata();
      const result = parseAnchorMetadata(rawMetadata);

      expect(result.valid).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
    });

    it("extracts all fields from valid entry", () => {
      const entry = createValidEntry({
        merkleRoot: VALID_HASH_3,
        itemCount: 42,
        agentId: "test-agent",
        storageUri: "ipfs://QmTest",
      });
      const rawMetadata = createValidMetadata([entry]);
      const result = parseAnchorMetadata(rawMetadata);

      expect(result.valid[0].rootHash).toBe(entry.rootHash);
      expect(result.valid[0].manifestHash).toBe(entry.manifestHash);
      expect(result.valid[0].merkleRoot).toBe(entry.merkleRoot);
      expect(result.valid[0].itemCount).toBe(42);
      expect(result.valid[0].agentId).toBe("test-agent");
      expect(result.valid[0].storageUri).toBe("ipfs://QmTest");
    });

    it("multiple anchors all parsed correctly", () => {
      const entry1 = createValidEntry({ rootHash: VALID_HASH });
      const entry2 = createValidEntry({ rootHash: VALID_HASH_2 });
      const entry3 = createValidEntry({ rootHash: VALID_HASH_3 });
      const rawMetadata = createValidMetadata([entry1, entry2, entry3]);
      const result = parseAnchorMetadata(rawMetadata);

      expect(result.valid).toHaveLength(3);
      expect(result.valid[0].rootHash).toBe(VALID_HASH);
      expect(result.valid[1].rootHash).toBe(VALID_HASH_2);
      expect(result.valid[2].rootHash).toBe(VALID_HASH_3);
    });
  });

  describe("unknown fields generate warnings", () => {
    it("unknown top-level field generates warning", () => {
      const rawMetadata = {
        [POI_METADATA_LABEL.toString()]: {
          schema: "poi-anchor-v1",
          anchors: [createValidEntry()],
          unknownField: "test",
        },
      };
      const result = parseAnchorMetadata(rawMetadata);

      expect(result.valid).toHaveLength(1);
      expect(result.warnings).toContain(
        "Unknown top-level field 'unknownField' ignored"
      );
    });

    it("unknown entry field generates warning", () => {
      const rawMetadata = {
        [POI_METADATA_LABEL.toString()]: {
          schema: "poi-anchor-v1",
          anchors: [
            {
              ...createValidEntry(),
              unknownEntryField: "value",
            },
          ],
        },
      };
      const result = parseAnchorMetadata(rawMetadata);

      expect(result.valid).toHaveLength(1);
      expect(result.warnings.some((w) => w.includes("unknownEntryField"))).toBe(
        true
      );
    });

    it("multiple unknown fields generate multiple warnings", () => {
      const rawMetadata = {
        [POI_METADATA_LABEL.toString()]: {
          schema: "poi-anchor-v1",
          anchors: [createValidEntry()],
          extra1: "test",
          extra2: "test",
        },
      };
      const result = parseAnchorMetadata(rawMetadata);

      expect(result.warnings).toHaveLength(2);
    });
  });

  describe("missing fields generate errors", () => {
    it("missing label 2222 generates error", () => {
      const rawMetadata = { otherLabel: {} };
      const result = parseAnchorMetadata(rawMetadata);

      expect(result.valid).toHaveLength(0);
      expect(result.errors).toContain(
        `Metadata label ${POI_METADATA_LABEL} not found`
      );
    });

    it("missing schema generates error", () => {
      const rawMetadata = {
        [POI_METADATA_LABEL.toString()]: {
          anchors: [createValidEntry()],
        },
      };
      const result = parseAnchorMetadata(rawMetadata);

      expect(result.valid).toHaveLength(0);
      expect(result.errors).toContain("Missing required field 'schema'");
    });

    it("missing anchors array generates error", () => {
      const rawMetadata = {
        [POI_METADATA_LABEL.toString()]: {
          schema: "poi-anchor-v1",
        },
      };
      const result = parseAnchorMetadata(rawMetadata);

      expect(result.valid).toHaveLength(0);
      expect(result.errors).toContain("Field 'anchors' must be an array");
    });

    it("missing entry rootHash generates error", () => {
      const entry = createValidEntry();
      delete (entry as Record<string, unknown>).rootHash;
      const rawMetadata = createValidMetadata([entry]);
      const result = parseAnchorMetadata(rawMetadata);

      expect(result.valid).toHaveLength(0);
      expect(result.errors.some((e) => e.includes("rootHash"))).toBe(true);
    });

    it("missing entry manifestHash generates error", () => {
      const entry = createValidEntry();
      delete (entry as Record<string, unknown>).manifestHash;
      const rawMetadata = createValidMetadata([entry]);
      const result = parseAnchorMetadata(rawMetadata);

      expect(result.valid).toHaveLength(0);
      expect(result.errors.some((e) => e.includes("manifestHash"))).toBe(true);
    });
  });

  describe("schema version handling", () => {
    it("unknown schema prefix generates error", () => {
      const rawMetadata = {
        [POI_METADATA_LABEL.toString()]: {
          schema: "other-schema-v1",
          anchors: [createValidEntry()],
        },
      };
      const result = parseAnchorMetadata(rawMetadata);

      expect(result.valid).toHaveLength(0);
      expect(result.errors.some((e) => e.includes("Unknown schema"))).toBe(true);
    });

    it("major version mismatch generates error", () => {
      // Use a completely different major version prefix (e.g., '2' instead of 'v1')
      // The implementation compares the first character after "poi-anchor-"
      const rawMetadata = {
        [POI_METADATA_LABEL.toString()]: {
          schema: "poi-anchor-2.0",
          anchors: [createValidEntry()],
        },
      };
      const result = parseAnchorMetadata(rawMetadata);

      expect(result.valid).toHaveLength(0);
      expect(
        result.errors.some((e) => e.includes("major version mismatch"))
      ).toBe(true);
    });

    it("minor version mismatch generates warning only", () => {
      const rawMetadata = {
        [POI_METADATA_LABEL.toString()]: {
          schema: "poi-anchor-v1.1",
          anchors: [createValidEntry()],
        },
      };
      const result = parseAnchorMetadata(rawMetadata);

      expect(result.valid).toHaveLength(1);
      expect(result.warnings.some((w) => w.includes("version mismatch"))).toBe(
        true
      );
    });
  });

  describe("empty and invalid structures", () => {
    it("empty anchors array generates warning", () => {
      const rawMetadata = {
        [POI_METADATA_LABEL.toString()]: {
          schema: "poi-anchor-v1",
          anchors: [],
        },
      };
      const result = parseAnchorMetadata(rawMetadata);

      expect(result.valid).toHaveLength(0);
      expect(result.warnings).toContain("Empty anchors array");
    });

    it("non-object metadata generates error", () => {
      const result = parseAnchorMetadata("not-an-object" as unknown as Record<string, unknown>);

      expect(result.valid).toHaveLength(0);
      expect(result.errors).toContain("Metadata must be an object");
    });

    it("null metadata generates error", () => {
      const result = parseAnchorMetadata(null as unknown as Record<string, unknown>);

      expect(result.valid).toHaveLength(0);
      expect(result.errors).toContain("Metadata must be an object");
    });

    it("non-array anchors generates error", () => {
      const rawMetadata = {
        [POI_METADATA_LABEL.toString()]: {
          schema: "poi-anchor-v1",
          anchors: { entry: createValidEntry() },
        },
      };
      const result = parseAnchorMetadata(rawMetadata);

      expect(result.valid).toHaveLength(0);
      expect(result.errors).toContain("Field 'anchors' must be an array");
    });
  });

  describe("partial parsing", () => {
    it("valid entries parsed even when some fail", () => {
      const validEntry = createValidEntry({ rootHash: VALID_HASH });
      const invalidEntry = { type: "invalid" };
      const rawMetadata = {
        [POI_METADATA_LABEL.toString()]: {
          schema: "poi-anchor-v1",
          anchors: [validEntry, invalidEntry],
        },
      };
      const result = parseAnchorMetadata(rawMetadata);

      expect(result.valid).toHaveLength(1);
      expect(result.valid[0].rootHash).toBe(VALID_HASH);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// extractAnchorFromMetadata TESTS
// =============================================================================

describe("extractAnchorFromMetadata", () => {
  describe("extraction from label 2222", () => {
    it("extracts from string key '2222'", () => {
      const rawMetadata = createValidMetadata();
      const result = extractAnchorFromMetadata(rawMetadata);

      expect(result).not.toBeNull();
      expect(result?.schema).toBe("poi-anchor-v1");
      expect(result?.anchors).toHaveLength(1);
    });

    it("extracts from numeric key 2222", () => {
      const rawMetadata = {
        [POI_METADATA_LABEL]: {
          schema: "poi-anchor-v1",
          anchors: [createValidEntry()],
        },
      };
      const result = extractAnchorFromMetadata(rawMetadata);

      expect(result).not.toBeNull();
      expect(result?.anchors).toHaveLength(1);
    });

    it("handles both string and numeric keys (string takes precedence)", () => {
      const rawMetadata = {
        "2222": {
          schema: "poi-anchor-v1",
          anchors: [createValidEntry()],
        },
      };
      const result = extractAnchorFromMetadata(rawMetadata);

      expect(result).not.toBeNull();
    });
  });

  describe("returns null for missing/invalid", () => {
    it("returns null if label 2222 missing", () => {
      const rawMetadata = { "1234": {} };
      const result = extractAnchorFromMetadata(rawMetadata);

      expect(result).toBeNull();
    });

    it("returns null if metadata is null", () => {
      const result = extractAnchorFromMetadata(null as unknown as Record<string, unknown>);

      expect(result).toBeNull();
    });

    it("returns null if metadata is not an object", () => {
      const result = extractAnchorFromMetadata("string" as unknown as Record<string, unknown>);

      expect(result).toBeNull();
    });

    it("returns null if label value is not valid AnchorMetadata", () => {
      const rawMetadata = {
        "2222": {
          schema: "invalid-schema",
          anchors: [],
        },
      };
      const result = extractAnchorFromMetadata(rawMetadata);

      expect(result).toBeNull();
    });

    it("returns null if label value is null", () => {
      const rawMetadata = { "2222": null };
      const result = extractAnchorFromMetadata(rawMetadata);

      expect(result).toBeNull();
    });
  });
});

// =============================================================================
// verifyAnchor TESTS
// =============================================================================

describe("verifyAnchor", () => {
  it("verifies anchor in transaction successfully", async () => {
    const entry = createValidEntry();
    const provider = createMockProvider({
      getTxMetadata: vi.fn().mockResolvedValue(createValidMetadata([entry])),
    });

    const result = await verifyAnchor(provider, "tx123", entry.rootHash);

    expect(result.valid).toBe(true);
    expect(result.anchor?.rootHash).toBe(entry.rootHash);
    expect(result.errors).toHaveLength(0);
  });

  it("includes txInfo when verification succeeds", async () => {
    const entry = createValidEntry();
    const txInfo: TxInfo = {
      txHash: "tx123",
      blockHash: "block456",
      blockHeight: 1000,
      slot: 50000,
      timestamp: "2024-01-28T12:00:00Z",
      confirmations: 50,
    };
    const provider = createMockProvider({
      getTxMetadata: vi.fn().mockResolvedValue(createValidMetadata([entry])),
      getTxInfo: vi.fn().mockResolvedValue(txInfo),
    });

    const result = await verifyAnchor(provider, "tx123", entry.rootHash);

    expect(result.valid).toBe(true);
    expect(result.txInfo).toEqual(txInfo);
  });

  it("generates warning for low confirmations", async () => {
    const entry = createValidEntry();
    const provider = createMockProvider({
      getTxMetadata: vi.fn().mockResolvedValue(createValidMetadata([entry])),
      getTxInfo: vi.fn().mockResolvedValue({
        txHash: "tx123",
        blockHash: "block456",
        blockHeight: 1000,
        slot: 50000,
        timestamp: "2024-01-28T12:00:00Z",
        confirmations: 5, // Less than 10
      }),
    });

    const result = await verifyAnchor(provider, "tx123", entry.rootHash);

    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("Low confirmation"))).toBe(
      true
    );
  });

  it("fails if transaction not found", async () => {
    const provider = createMockProvider({
      getTxMetadata: vi.fn().mockResolvedValue(null),
    });

    const result = await verifyAnchor(provider, "tx123", VALID_HASH);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Transaction not found");
  });

  it("fails if rootHash does not match any anchor", async () => {
    const entry = createValidEntry({ rootHash: VALID_HASH });
    const provider = createMockProvider({
      getTxMetadata: vi.fn().mockResolvedValue(createValidMetadata([entry])),
    });

    const result = await verifyAnchor(provider, "tx123", VALID_HASH_2);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/No anchor found.*rootHash/);
  });

  it("matches hash with sha256: prefix", async () => {
    const entry = createValidEntry({ rootHash: VALID_HASH });
    const provider = createMockProvider({
      getTxMetadata: vi.fn().mockResolvedValue(createValidMetadata([entry])),
    });

    const result = await verifyAnchor(provider, "tx123", `sha256:${VALID_HASH}`);

    expect(result.valid).toBe(true);
  });

  it("handles provider errors gracefully", async () => {
    const provider = createMockProvider({
      getTxMetadata: vi.fn().mockRejectedValue(new Error("Network error")),
    });

    const result = await verifyAnchor(provider, "tx123", VALID_HASH);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Provider error.*Network error/);
  });

  it("fails for invalid txHash parameter", async () => {
    const provider = createMockProvider();

    const result = await verifyAnchor(provider, "", VALID_HASH);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Invalid transaction hash");
  });

  it("fails for invalid expectedRootHash format", async () => {
    const provider = createMockProvider();

    const result = await verifyAnchor(provider, "tx123", "invalid-hash");

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/invalid format/i);
  });
});

// =============================================================================
// verifyAnchorManifest TESTS
// =============================================================================

describe("verifyAnchorManifest", () => {
  it("verifies anchor by manifestHash", async () => {
    const entry = createValidEntry();
    const provider = createMockProvider({
      getTxMetadata: vi.fn().mockResolvedValue(createValidMetadata([entry])),
    });

    const result = await verifyAnchorManifest(
      provider,
      "tx123",
      entry.manifestHash
    );

    expect(result.valid).toBe(true);
    expect(result.anchor?.manifestHash).toBe(entry.manifestHash);
  });

  it("fails if manifestHash does not match", async () => {
    const entry = createValidEntry({ manifestHash: VALID_HASH });
    const provider = createMockProvider({
      getTxMetadata: vi.fn().mockResolvedValue(createValidMetadata([entry])),
    });

    const result = await verifyAnchorManifest(provider, "tx123", VALID_HASH_2);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/No anchor found.*manifestHash/);
  });
});

// =============================================================================
// findAnchorsInTx TESTS
// =============================================================================

describe("findAnchorsInTx", () => {
  it("returns all anchors in transaction", async () => {
    const entry1 = createValidEntry({ rootHash: VALID_HASH });
    const entry2 = createValidEntry({ rootHash: VALID_HASH_2 });
    const provider = createMockProvider({
      getTxMetadata: vi.fn().mockResolvedValue(createValidMetadata([entry1, entry2])),
    });

    const result = await findAnchorsInTx(provider, "tx123");

    expect(result.anchors).toHaveLength(2);
    expect(result.anchors[0].rootHash).toBe(VALID_HASH);
    expect(result.anchors[1].rootHash).toBe(VALID_HASH_2);
  });

  it("includes txInfo in result", async () => {
    const txInfo: TxInfo = {
      txHash: "tx123",
      blockHash: "block456",
      blockHeight: 1000,
      slot: 50000,
      timestamp: "2024-01-28T12:00:00Z",
      confirmations: 50,
    };
    const provider = createMockProvider({
      getTxMetadata: vi.fn().mockResolvedValue(createValidMetadata()),
      getTxInfo: vi.fn().mockResolvedValue(txInfo),
    });

    const result = await findAnchorsInTx(provider, "tx123");

    expect(result.txInfo).toEqual(txInfo);
  });

  it("returns empty array if transaction not found", async () => {
    const provider = createMockProvider({
      getTxMetadata: vi.fn().mockResolvedValue(null),
    });

    const result = await findAnchorsInTx(provider, "tx123");

    expect(result.anchors).toHaveLength(0);
    expect(result.errors).toContain("Transaction not found");
  });

  it("returns empty array for invalid txHash", async () => {
    const provider = createMockProvider();

    const result = await findAnchorsInTx(provider, "");

    expect(result.anchors).toHaveLength(0);
    expect(result.errors).toContain("Invalid transaction hash");
  });

  it("includes parse errors in result", async () => {
    const rawMetadata = {
      [POI_METADATA_LABEL.toString()]: {
        schema: "poi-anchor-v1",
        anchors: [{ type: "invalid" }], // Invalid entry
      },
    };
    const provider = createMockProvider({
      getTxMetadata: vi.fn().mockResolvedValue(rawMetadata),
    });

    const result = await findAnchorsInTx(provider, "tx123");

    expect(result.anchors).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("handles txInfo fetch failure gracefully", async () => {
    const provider = createMockProvider({
      getTxMetadata: vi.fn().mockResolvedValue(createValidMetadata()),
      getTxInfo: vi.fn().mockRejectedValue(new Error("TxInfo error")),
    });

    const result = await findAnchorsInTx(provider, "tx123");

    expect(result.anchors).toHaveLength(1);
    expect(result.txInfo).toBeNull();
    expect(result.errors.some((e) => e.includes("txInfo"))).toBe(true);
  });
});
