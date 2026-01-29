/**
 * @fileoverview Tests for type guards and constants in anchors-cardano.
 *
 * Location: packages/anchors-cardano/src/__tests__/types.test.ts
 *
 * Tests coverage:
 * - isAnchorType: validates correct anchor types
 * - isCardanoNetwork: validates correct network identifiers
 * - isAnchorEntry: validates anchor entry structure
 * - isAnchorMetadata: validates anchor metadata structure
 * - POI_METADATA_LABEL constant equals 2222
 */

import { describe, it, expect } from "vitest";
import {
  POI_METADATA_LABEL,
  isAnchorType,
  isCardanoNetwork,
  isAnchorEntry,
  isAnchorMetadata,
  isAnchorSchema,
} from "../types.js";
import type { AnchorEntry, AnchorMetadata } from "../types.js";

// =============================================================================
// POI_METADATA_LABEL CONSTANT
// =============================================================================

describe("POI_METADATA_LABEL", () => {
  it("equals 2222", () => {
    expect(POI_METADATA_LABEL).toBe(2222);
  });

  it("is a number", () => {
    expect(typeof POI_METADATA_LABEL).toBe("number");
  });
});

// =============================================================================
// isAnchorType TYPE GUARD
// =============================================================================

describe("isAnchorType", () => {
  describe("valid anchor types", () => {
    it("returns true for 'process-trace'", () => {
      expect(isAnchorType("process-trace")).toBe(true);
    });

    it("returns true for 'proof-of-intent'", () => {
      expect(isAnchorType("proof-of-intent")).toBe(true);
    });

    it("returns true for 'custom'", () => {
      expect(isAnchorType("custom")).toBe(true);
    });
  });

  describe("invalid anchor types", () => {
    it("returns false for empty string", () => {
      expect(isAnchorType("")).toBe(false);
    });

    it("returns false for unknown string value", () => {
      expect(isAnchorType("unknown-type")).toBe(false);
    });

    it("returns false for null", () => {
      expect(isAnchorType(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isAnchorType(undefined)).toBe(false);
    });

    it("returns false for number", () => {
      expect(isAnchorType(123)).toBe(false);
    });

    it("returns false for object", () => {
      expect(isAnchorType({})).toBe(false);
    });

    it("returns false for array", () => {
      expect(isAnchorType(["process-trace"])).toBe(false);
    });

    it("returns false for boolean", () => {
      expect(isAnchorType(true)).toBe(false);
    });

    it("returns false for similar but incorrect string", () => {
      expect(isAnchorType("process_trace")).toBe(false);
      expect(isAnchorType("Process-Trace")).toBe(false);
      expect(isAnchorType("PROCESS-TRACE")).toBe(false);
    });
  });
});

// =============================================================================
// isCardanoNetwork TYPE GUARD
// =============================================================================

describe("isCardanoNetwork", () => {
  describe("valid networks", () => {
    it("returns true for 'mainnet'", () => {
      expect(isCardanoNetwork("mainnet")).toBe(true);
    });

    it("returns true for 'preprod'", () => {
      expect(isCardanoNetwork("preprod")).toBe(true);
    });

    it("returns true for 'preview'", () => {
      expect(isCardanoNetwork("preview")).toBe(true);
    });
  });

  describe("invalid networks", () => {
    it("returns false for empty string", () => {
      expect(isCardanoNetwork("")).toBe(false);
    });

    it("returns false for unknown network", () => {
      expect(isCardanoNetwork("testnet")).toBe(false);
    });

    it("returns false for null", () => {
      expect(isCardanoNetwork(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isCardanoNetwork(undefined)).toBe(false);
    });

    it("returns false for number", () => {
      expect(isCardanoNetwork(1)).toBe(false);
    });

    it("returns false for similar but incorrect string", () => {
      expect(isCardanoNetwork("Mainnet")).toBe(false);
      expect(isCardanoNetwork("MAINNET")).toBe(false);
      expect(isCardanoNetwork("main-net")).toBe(false);
    });
  });
});

// =============================================================================
// isAnchorSchema TYPE GUARD
// =============================================================================

describe("isAnchorSchema", () => {
  it("returns true for 'poi-anchor-v1'", () => {
    expect(isAnchorSchema("poi-anchor-v1")).toBe(true);
  });

  it("returns false for other schema versions", () => {
    expect(isAnchorSchema("poi-anchor-v2")).toBe(false);
    expect(isAnchorSchema("poi-anchor-v0")).toBe(false);
    expect(isAnchorSchema("anchor-v1")).toBe(false);
  });

  it("returns false for non-string values", () => {
    expect(isAnchorSchema(null)).toBe(false);
    expect(isAnchorSchema(undefined)).toBe(false);
    expect(isAnchorSchema(1)).toBe(false);
    expect(isAnchorSchema({})).toBe(false);
  });
});

// =============================================================================
// isAnchorEntry TYPE GUARD
// =============================================================================

describe("isAnchorEntry", () => {
  const validEntry: AnchorEntry = {
    type: "process-trace",
    version: "1.0",
    rootHash: "abc123def456789012345678901234567890123456789012345678901234",
    manifestHash: "def456789012345678901234567890123456789012345678901234567890",
    timestamp: "2024-01-28T12:00:00Z",
  };

  describe("valid entries", () => {
    it("returns true for minimal valid entry", () => {
      expect(isAnchorEntry(validEntry)).toBe(true);
    });

    it("returns true for entry with all optional fields", () => {
      const fullEntry: AnchorEntry = {
        ...validEntry,
        merkleRoot: "789012345678901234567890123456789012345678901234567890123456",
        itemCount: 42,
        agentId: "agent-claude-v1",
        storageUri: "ipfs://QmXyz123",
      };
      expect(isAnchorEntry(fullEntry)).toBe(true);
    });

    it("returns true for entry with type 'proof-of-intent'", () => {
      const entry = { ...validEntry, type: "proof-of-intent" as const };
      expect(isAnchorEntry(entry)).toBe(true);
    });

    it("returns true for entry with type 'custom'", () => {
      const entry = { ...validEntry, type: "custom" as const };
      expect(isAnchorEntry(entry)).toBe(true);
    });
  });

  describe("invalid entries - wrong types", () => {
    it("returns false for null", () => {
      expect(isAnchorEntry(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isAnchorEntry(undefined)).toBe(false);
    });

    it("returns false for string", () => {
      expect(isAnchorEntry("entry")).toBe(false);
    });

    it("returns false for number", () => {
      expect(isAnchorEntry(123)).toBe(false);
    });

    it("returns false for array", () => {
      expect(isAnchorEntry([validEntry])).toBe(false);
    });
  });

  describe("invalid entries - missing required fields", () => {
    it("returns false when missing type", () => {
      const { type, ...entry } = validEntry;
      expect(isAnchorEntry(entry)).toBe(false);
    });

    it("returns false when missing version", () => {
      const { version, ...entry } = validEntry;
      expect(isAnchorEntry(entry)).toBe(false);
    });

    it("returns false when missing rootHash", () => {
      const { rootHash, ...entry } = validEntry;
      expect(isAnchorEntry(entry)).toBe(false);
    });

    it("returns false when missing manifestHash", () => {
      const { manifestHash, ...entry } = validEntry;
      expect(isAnchorEntry(entry)).toBe(false);
    });

    it("returns false when missing timestamp", () => {
      const { timestamp, ...entry } = validEntry;
      expect(isAnchorEntry(entry)).toBe(false);
    });
  });

  describe("invalid entries - wrong field types", () => {
    it("returns false for invalid type value", () => {
      const entry = { ...validEntry, type: "invalid-type" };
      expect(isAnchorEntry(entry)).toBe(false);
    });

    it("returns false for wrong version", () => {
      const entry = { ...validEntry, version: "2.0" };
      expect(isAnchorEntry(entry)).toBe(false);
    });

    it("returns false for non-string rootHash", () => {
      const entry = { ...validEntry, rootHash: 123 };
      expect(isAnchorEntry(entry)).toBe(false);
    });

    it("returns false for non-string manifestHash", () => {
      const entry = { ...validEntry, manifestHash: null };
      expect(isAnchorEntry(entry)).toBe(false);
    });

    it("returns false for non-string timestamp", () => {
      const entry = { ...validEntry, timestamp: Date.now() };
      expect(isAnchorEntry(entry)).toBe(false);
    });
  });

  describe("invalid entries - wrong optional field types", () => {
    it("returns false for non-string merkleRoot", () => {
      const entry = { ...validEntry, merkleRoot: 123 };
      expect(isAnchorEntry(entry)).toBe(false);
    });

    it("returns false for non-number itemCount", () => {
      const entry = { ...validEntry, itemCount: "42" };
      expect(isAnchorEntry(entry)).toBe(false);
    });

    it("returns false for non-string agentId", () => {
      const entry = { ...validEntry, agentId: 123 };
      expect(isAnchorEntry(entry)).toBe(false);
    });

    it("returns false for non-string storageUri", () => {
      const entry = { ...validEntry, storageUri: { uri: "ipfs://test" } };
      expect(isAnchorEntry(entry)).toBe(false);
    });
  });
});

// =============================================================================
// isAnchorMetadata TYPE GUARD
// =============================================================================

describe("isAnchorMetadata", () => {
  const validEntry: AnchorEntry = {
    type: "process-trace",
    version: "1.0",
    rootHash: "abc123def456789012345678901234567890123456789012345678901234",
    manifestHash: "def456789012345678901234567890123456789012345678901234567890",
    timestamp: "2024-01-28T12:00:00Z",
  };

  const validMetadata: AnchorMetadata = {
    schema: "poi-anchor-v1",
    anchors: [validEntry],
  };

  describe("valid metadata", () => {
    it("returns true for valid metadata with single anchor", () => {
      expect(isAnchorMetadata(validMetadata)).toBe(true);
    });

    it("returns true for valid metadata with multiple anchors", () => {
      const metadata: AnchorMetadata = {
        schema: "poi-anchor-v1",
        anchors: [
          validEntry,
          { ...validEntry, rootHash: "fff456789012345678901234567890123456789012345678901234567890" },
        ],
      };
      expect(isAnchorMetadata(metadata)).toBe(true);
    });

    it("returns true for valid metadata with empty anchors array", () => {
      const metadata = {
        schema: "poi-anchor-v1",
        anchors: [],
      };
      expect(isAnchorMetadata(metadata)).toBe(true);
    });
  });

  describe("invalid metadata - wrong types", () => {
    it("returns false for null", () => {
      expect(isAnchorMetadata(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isAnchorMetadata(undefined)).toBe(false);
    });

    it("returns false for string", () => {
      expect(isAnchorMetadata("metadata")).toBe(false);
    });

    it("returns false for number", () => {
      expect(isAnchorMetadata(123)).toBe(false);
    });

    it("returns false for array", () => {
      expect(isAnchorMetadata([validMetadata])).toBe(false);
    });
  });

  describe("invalid metadata - missing fields", () => {
    it("returns false when missing schema", () => {
      const { schema, ...metadata } = validMetadata;
      expect(isAnchorMetadata(metadata)).toBe(false);
    });

    it("returns false when missing anchors", () => {
      const { anchors, ...metadata } = validMetadata;
      expect(isAnchorMetadata(metadata)).toBe(false);
    });
  });

  describe("invalid metadata - wrong field types", () => {
    it("returns false for invalid schema", () => {
      const metadata = { ...validMetadata, schema: "invalid-schema" };
      expect(isAnchorMetadata(metadata)).toBe(false);
    });

    it("returns false for non-array anchors", () => {
      const metadata = { ...validMetadata, anchors: validEntry };
      expect(isAnchorMetadata(metadata)).toBe(false);
    });

    it("returns false when anchors contains invalid entry", () => {
      const invalidEntry = { ...validEntry, type: "invalid" };
      const metadata = { ...validMetadata, anchors: [invalidEntry] };
      expect(isAnchorMetadata(metadata)).toBe(false);
    });

    it("returns false when any anchor in array is invalid", () => {
      const invalidEntry = { ...validEntry, version: "2.0" };
      const metadata = { ...validMetadata, anchors: [validEntry, invalidEntry] };
      expect(isAnchorMetadata(metadata)).toBe(false);
    });
  });
});
