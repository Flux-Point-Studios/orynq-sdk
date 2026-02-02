/**
 * @fileoverview Tests for anchor building functions.
 *
 * Location: packages/anchors-cardano/src/__tests__/anchor-builder.test.ts
 *
 * Tests coverage:
 * - buildAnchorMetadata: builds metadata for single entry
 * - buildBatchAnchorMetadata: builds metadata for multiple entries
 * - createAnchorEntryFromBundle: creates entry from TraceBundle
 * - validateAnchorEntry: validates entry fields and format
 * - serializeForCardanoCli: serializes for cardano-cli
 * - serializeForCbor: handles 64-byte string limit
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  buildAnchorMetadata,
  buildBatchAnchorMetadata,
  createAnchorEntryFromBundle,
  validateAnchorEntry,
  serializeForCardanoCli,
  serializeForCbor,
  extractRawHash,
  normalizeHashWithPrefix,
} from "../anchor-builder.js";
import { POI_METADATA_LABEL } from "../types.js";
import type { AnchorEntry } from "../types.js";
import type { TraceBundle } from "@fluxpointstudios/orynq-sdk-process-trace";

// =============================================================================
// TEST FIXTURES
// =============================================================================

/**
 * Valid 64-character hex hash for testing.
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
 * Creates a minimal mock TraceBundle for testing.
 */
function createMockBundle(overrides?: Partial<TraceBundle>): TraceBundle {
  return {
    formatVersion: "1.0",
    rootHash: VALID_HASH,
    manifestHash: VALID_HASH_2,
    merkleRoot: VALID_HASH_3,
    publicView: {
      runId: "run-123",
      agentId: "test-agent",
      schemaVersion: "1.0",
      startedAt: "2024-01-28T11:00:00Z",
      endedAt: "2024-01-28T12:00:00Z",
      durationMs: 3600000,
      status: "completed",
      totalEvents: 42,
      totalSpans: 5,
      rootHash: VALID_HASH,
      merkleRoot: VALID_HASH_3,
      publicSpans: [],
      redactedSpanHashes: [],
    },
    privateRun: {
      id: "run-123",
      schemaVersion: "1.0",
      agentId: "test-agent",
      status: "completed",
      startedAt: "2024-01-28T11:00:00Z",
      endedAt: "2024-01-28T12:00:00Z",
      durationMs: 3600000,
      events: [],
      spans: [],
      rollingHash: VALID_HASH,
      rootHash: VALID_HASH,
      nextSeq: 1,
      nextSpanSeq: 1,
    },
    ...overrides,
  };
}

// =============================================================================
// buildAnchorMetadata TESTS
// =============================================================================

describe("buildAnchorMetadata", () => {
  it("returns correct label (POI_METADATA_LABEL = 2222)", () => {
    const entry = createValidEntry();
    const result = buildAnchorMetadata(entry);

    expect(result.label).toBe(POI_METADATA_LABEL);
    expect(result.label).toBe(2222);
  });

  it("creates valid metadata structure", () => {
    const entry = createValidEntry();
    const result = buildAnchorMetadata(entry);

    expect(result.metadata).toEqual({
      schema: "poi-anchor-v1",
      anchors: [entry],
    });
  });

  it("wraps metadata in json with label as key", () => {
    const entry = createValidEntry();
    const result = buildAnchorMetadata(entry);

    expect(result.json).toEqual({
      [POI_METADATA_LABEL]: result.metadata,
    });
    expect(result.json["2222"]).toEqual(result.metadata);
  });

  it("preserves all entry fields in metadata", () => {
    const entry = createValidEntry({
      merkleRoot: VALID_HASH_3,
      itemCount: 42,
      agentId: "test-agent",
      storageUri: "ipfs://QmTest",
    });
    const result = buildAnchorMetadata(entry);

    expect(result.metadata.anchors[0]).toEqual(entry);
  });

  it("creates metadata with single anchor in array", () => {
    const entry = createValidEntry();
    const result = buildAnchorMetadata(entry);

    expect(result.metadata.anchors).toHaveLength(1);
    expect(Array.isArray(result.metadata.anchors)).toBe(true);
  });
});

// =============================================================================
// buildBatchAnchorMetadata TESTS
// =============================================================================

describe("buildBatchAnchorMetadata", () => {
  it("handles multiple entries", () => {
    const entry1 = createValidEntry({ rootHash: VALID_HASH });
    const entry2 = createValidEntry({ rootHash: VALID_HASH_2 });
    const result = buildBatchAnchorMetadata([entry1, entry2]);

    expect(result.metadata.anchors).toHaveLength(2);
    expect(result.metadata.anchors[0]).toEqual(entry1);
    expect(result.metadata.anchors[1]).toEqual(entry2);
  });

  it("validates all entries before building", () => {
    const validEntry = createValidEntry();
    const invalidEntry = {
      ...createValidEntry(),
      rootHash: "invalid", // Too short
    } as AnchorEntry;

    expect(() =>
      buildBatchAnchorMetadata([validEntry, invalidEntry])
    ).toThrow(/Entry 1/);
  });

  it("throws error for empty entries array", () => {
    expect(() => buildBatchAnchorMetadata([])).toThrow(
      "Cannot build batch metadata with empty entries array"
    );
  });

  it("returns same structure as single entry build", () => {
    const entry = createValidEntry();
    const batchResult = buildBatchAnchorMetadata([entry]);
    const singleResult = buildAnchorMetadata(entry);

    expect(batchResult.label).toBe(singleResult.label);
    expect(batchResult.metadata.schema).toBe(singleResult.metadata.schema);
  });

  it("includes all validation errors in thrown message", () => {
    const invalid1 = { ...createValidEntry(), rootHash: "bad" } as AnchorEntry;
    const invalid2 = { ...createValidEntry(), manifestHash: "bad" } as AnchorEntry;

    expect(() => buildBatchAnchorMetadata([invalid1, invalid2])).toThrow(
      /Entry 0.*Entry 1/s
    );
  });
});

// =============================================================================
// createAnchorEntryFromBundle TESTS
// =============================================================================

describe("createAnchorEntryFromBundle", () => {
  it("extracts correct hashes from bundle", () => {
    const bundle = createMockBundle();
    const entry = createAnchorEntryFromBundle(bundle);

    expect(entry.rootHash).toBe(bundle.rootHash);
    expect(entry.manifestHash).toBe(bundle.manifestHash);
    expect(entry.merkleRoot).toBe(bundle.merkleRoot);
  });

  it("sets type to 'process-trace'", () => {
    const bundle = createMockBundle();
    const entry = createAnchorEntryFromBundle(bundle);

    expect(entry.type).toBe("process-trace");
  });

  it("sets version to '1.0'", () => {
    const bundle = createMockBundle();
    const entry = createAnchorEntryFromBundle(bundle);

    expect(entry.version).toBe("1.0");
  });

  it("includes timestamp in ISO 8601 format", () => {
    const bundle = createMockBundle();
    const entry = createAnchorEntryFromBundle(bundle);

    expect(entry.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
    );
  });

  it("includes storageUri when provided in options", () => {
    const bundle = createMockBundle();
    const entry = createAnchorEntryFromBundle(bundle, {
      storageUri: "ipfs://QmTest123",
    });

    expect(entry.storageUri).toBe("ipfs://QmTest123");
  });

  it("includes agentId from options when provided", () => {
    const bundle = createMockBundle();
    const entry = createAnchorEntryFromBundle(bundle, {
      agentId: "custom-agent",
    });

    expect(entry.agentId).toBe("custom-agent");
  });

  it("uses agentId from bundle privateRun when not in options", () => {
    const bundle = createMockBundle();
    bundle.privateRun.agentId = "bundle-agent";
    const entry = createAnchorEntryFromBundle(bundle);

    expect(entry.agentId).toBe("bundle-agent");
  });

  it("includes itemCount from publicView totalEvents", () => {
    const bundle = createMockBundle();
    bundle.publicView.totalEvents = 100;
    const entry = createAnchorEntryFromBundle(bundle);

    expect(entry.itemCount).toBe(100);
  });

  it("includes merkleRoot by default", () => {
    const bundle = createMockBundle();
    const entry = createAnchorEntryFromBundle(bundle);

    expect(entry.merkleRoot).toBe(VALID_HASH_3);
  });

  it("excludes merkleRoot when includeMerkleRoot is false", () => {
    const bundle = createMockBundle();
    const entry = createAnchorEntryFromBundle(bundle, {
      includeMerkleRoot: false,
    });

    expect(entry.merkleRoot).toBeUndefined();
  });

  it("throws error when bundle is missing rootHash", () => {
    const bundle = createMockBundle();
    bundle.rootHash = undefined as unknown as string;

    expect(() => createAnchorEntryFromBundle(bundle)).toThrow(
      "Bundle is missing required rootHash"
    );
  });

  it("throws error when bundle is missing manifestHash", () => {
    const bundle = createMockBundle();
    bundle.manifestHash = undefined;

    expect(() => createAnchorEntryFromBundle(bundle)).toThrow(
      "Bundle is missing required manifestHash"
    );
  });
});

// =============================================================================
// validateAnchorEntry TESTS
// =============================================================================

describe("validateAnchorEntry", () => {
  describe("valid entries", () => {
    it("valid entry passes validation", () => {
      const entry = createValidEntry();
      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("valid entry with all optional fields passes", () => {
      const entry = createValidEntry({
        merkleRoot: VALID_HASH_3,
        itemCount: 42,
        agentId: "test-agent",
        storageUri: "ipfs://QmTest",
      });
      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("accepts sha256: prefixed hash", () => {
      const entry = createValidEntry({
        rootHash: `sha256:${VALID_HASH}`,
      });
      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(true);
    });
  });

  describe("missing required fields", () => {
    it("missing rootHash fails validation", () => {
      const entry = createValidEntry();
      delete (entry as Record<string, unknown>).rootHash;

      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Missing required field: rootHash");
    });

    it("missing manifestHash fails validation", () => {
      const entry = createValidEntry();
      delete (entry as Record<string, unknown>).manifestHash;

      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Missing required field: manifestHash");
    });

    it("missing type fails validation", () => {
      const entry = createValidEntry();
      delete (entry as Record<string, unknown>).type;

      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Missing required field: type");
    });

    it("missing version fails validation", () => {
      const entry = createValidEntry();
      delete (entry as Record<string, unknown>).version;

      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Missing required field: version");
    });

    it("missing timestamp fails validation", () => {
      const entry = createValidEntry();
      delete (entry as Record<string, unknown>).timestamp;

      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Missing required field: timestamp");
    });
  });

  describe("invalid hash format", () => {
    it("invalid rootHash format fails (too short)", () => {
      const entry = createValidEntry({
        rootHash: "abc123",
      });

      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/rootHash format/i);
    });

    it("invalid rootHash format fails (too long)", () => {
      const entry = createValidEntry({
        rootHash: VALID_HASH + "extra",
      });

      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(false);
    });

    it("invalid rootHash format fails (non-hex chars)", () => {
      const entry = createValidEntry({
        rootHash: "g".repeat(64), // 'g' is not hex
      });

      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(false);
    });

    it("invalid manifestHash format fails", () => {
      const entry = createValidEntry({
        manifestHash: "invalid-hash",
      });

      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/manifestHash format/i);
    });

    it("invalid merkleRoot format fails", () => {
      const entry = createValidEntry({
        merkleRoot: "short",
      });

      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(false);
    });
  });

  describe("invalid timestamp format", () => {
    it("invalid timestamp fails validation", () => {
      const entry = createValidEntry({
        timestamp: "not-a-date",
      });

      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/timestamp format/i);
    });

    it("unix timestamp fails validation", () => {
      const entry = createValidEntry({
        timestamp: "1706443200",
      });

      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(false);
    });

    it("valid ISO 8601 with timezone offset passes", () => {
      const entry = createValidEntry({
        timestamp: "2024-01-28T12:00:00+05:00",
      });

      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(true);
    });

    it("valid ISO 8601 with milliseconds passes", () => {
      const entry = createValidEntry({
        timestamp: "2024-01-28T12:00:00.123Z",
      });

      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(true);
    });
  });

  describe("invalid optional fields", () => {
    it("negative itemCount fails validation", () => {
      const entry = createValidEntry({
        itemCount: -1,
      });

      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(false);
    });

    it("empty agentId fails validation", () => {
      const entry = createValidEntry({
        agentId: "",
      });

      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(false);
    });

    it("empty storageUri fails validation", () => {
      const entry = createValidEntry({
        storageUri: "",
      });

      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(false);
    });

    it("invalid storageUri scheme fails", () => {
      const entry = createValidEntry({
        storageUri: "ftp://invalid.com/file",
      });

      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(false);
    });

    it("valid ipfs:// storageUri passes", () => {
      const entry = createValidEntry({
        storageUri: "ipfs://QmTest",
      });

      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(true);
    });

    it("valid ar:// storageUri passes", () => {
      const entry = createValidEntry({
        storageUri: "ar://TxId123",
      });

      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(true);
    });

    it("valid https:// storageUri passes", () => {
      const entry = createValidEntry({
        storageUri: "https://example.com/trace",
      });

      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(true);
    });
  });

  describe("type and version validation", () => {
    it("invalid type fails validation", () => {
      const entry = {
        ...createValidEntry(),
        type: "invalid-type",
      } as unknown as AnchorEntry;

      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/Invalid type/);
    });

    it("invalid version fails validation", () => {
      const entry = {
        ...createValidEntry(),
        version: "2.0",
      } as unknown as AnchorEntry;

      const result = validateAnchorEntry(entry);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/Invalid version/);
    });
  });
});

// =============================================================================
// serializeForCardanoCli TESTS
// =============================================================================

describe("serializeForCardanoCli", () => {
  it("produces valid JSON output", () => {
    const entry = createValidEntry();
    const txResult = buildAnchorMetadata(entry);
    const json = serializeForCardanoCli(txResult);

    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("has label as top-level key", () => {
    const entry = createValidEntry();
    const txResult = buildAnchorMetadata(entry);
    const json = serializeForCardanoCli(txResult);
    const parsed = JSON.parse(json);

    expect(parsed).toHaveProperty("2222");
  });

  it("contains correct metadata structure", () => {
    const entry = createValidEntry();
    const txResult = buildAnchorMetadata(entry);
    const json = serializeForCardanoCli(txResult);
    const parsed = JSON.parse(json);

    expect(parsed["2222"].schema).toBe("poi-anchor-v1");
    expect(parsed["2222"].anchors).toHaveLength(1);
    expect(parsed["2222"].anchors[0].rootHash).toBe(entry.rootHash);
  });

  it("is pretty-printed with 2-space indent", () => {
    const entry = createValidEntry();
    const txResult = buildAnchorMetadata(entry);
    const json = serializeForCardanoCli(txResult);

    // Check for newlines and indentation
    expect(json).toContain("\n");
    expect(json).toContain("  ");
  });
});

// =============================================================================
// serializeForCbor TESTS
// =============================================================================

describe("serializeForCbor", () => {
  it("handles strings within 64-byte limit", () => {
    const entry = createValidEntry();
    const txResult = buildAnchorMetadata(entry);
    const result = serializeForCbor(txResult);

    // The 64-char hex hash should remain as a string (not split)
    const anchors = (result["2222"] as Record<string, unknown>).anchors as unknown[];
    const firstAnchor = anchors[0] as Record<string, unknown>;

    expect(typeof firstAnchor.rootHash).toBe("string");
  });

  it("splits strings exceeding 64-byte limit into array", () => {
    // Create an entry with a very long storageUri
    const longUri = "https://example.com/" + "x".repeat(100);
    const entry = createValidEntry({
      storageUri: longUri,
    });
    const txResult = buildAnchorMetadata(entry);
    const result = serializeForCbor(txResult);

    const anchors = (result["2222"] as Record<string, unknown>).anchors as unknown[];
    const firstAnchor = anchors[0] as Record<string, unknown>;

    // The storageUri should be split into an array
    expect(Array.isArray(firstAnchor.storageUri)).toBe(true);

    // Verify all chunks are <= 64 bytes
    const chunks = firstAnchor.storageUri as string[];
    for (const chunk of chunks) {
      const bytes = new TextEncoder().encode(chunk);
      expect(bytes.length).toBeLessThanOrEqual(64);
    }

    // Verify joining chunks recreates original
    expect(chunks.join("")).toBe(longUri);
  });

  it("preserves numbers unchanged", () => {
    const entry = createValidEntry({
      itemCount: 42,
    });
    const txResult = buildAnchorMetadata(entry);
    const result = serializeForCbor(txResult);

    const anchors = (result["2222"] as Record<string, unknown>).anchors as unknown[];
    const firstAnchor = anchors[0] as Record<string, unknown>;

    expect(firstAnchor.itemCount).toBe(42);
    expect(typeof firstAnchor.itemCount).toBe("number");
  });

  it("handles nested objects recursively", () => {
    const entry = createValidEntry();
    const txResult = buildAnchorMetadata(entry);
    const result = serializeForCbor(txResult);

    expect(result).toHaveProperty("2222");
    expect((result["2222"] as Record<string, unknown>)).toHaveProperty("anchors");
  });

  it("handles UTF-8 multi-byte characters correctly", () => {
    // UTF-8 emoji takes 4 bytes
    const longEmoji = "https://example.com/" + "\u{1F600}".repeat(20);
    const entry = createValidEntry({
      storageUri: longEmoji,
    });
    const txResult = buildAnchorMetadata(entry);
    const result = serializeForCbor(txResult);

    const anchors = (result["2222"] as Record<string, unknown>).anchors as unknown[];
    const firstAnchor = anchors[0] as Record<string, unknown>;
    const chunks = firstAnchor.storageUri as string[];

    // Verify chunks don't split multi-byte chars
    for (const chunk of chunks) {
      const bytes = new TextEncoder().encode(chunk);
      expect(bytes.length).toBeLessThanOrEqual(64);
    }
  });
});

// =============================================================================
// HASH UTILITY FUNCTIONS
// =============================================================================

describe("extractRawHash", () => {
  it("removes sha256: prefix", () => {
    const result = extractRawHash(`sha256:${VALID_HASH}`);
    expect(result).toBe(VALID_HASH);
  });

  it("returns hash unchanged if no prefix", () => {
    const result = extractRawHash(VALID_HASH);
    expect(result).toBe(VALID_HASH);
  });

  it("handles uppercase prefix", () => {
    const result = extractRawHash(`SHA256:${VALID_HASH}`);
    expect(result).toBe(VALID_HASH);
  });

  it("returns lowercase hash", () => {
    const upperHash = VALID_HASH.toUpperCase();
    const result = extractRawHash(upperHash);
    expect(result).toBe(VALID_HASH);
  });
});

describe("normalizeHashWithPrefix", () => {
  it("adds sha256: prefix to raw hash", () => {
    const result = normalizeHashWithPrefix(VALID_HASH);
    expect(result).toBe(`sha256:${VALID_HASH}`);
  });

  it("keeps existing prefix (normalized)", () => {
    const result = normalizeHashWithPrefix(`sha256:${VALID_HASH}`);
    expect(result).toBe(`sha256:${VALID_HASH}`);
  });

  it("lowercases the hash", () => {
    const upperHash = VALID_HASH.toUpperCase();
    const result = normalizeHashWithPrefix(upperHash);
    expect(result).toBe(`sha256:${VALID_HASH}`);
  });
});
