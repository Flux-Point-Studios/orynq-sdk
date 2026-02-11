/**
 * @summary Tests for the feature-telemetry package.
 *
 * Location: packages/feature-telemetry/src/__tests__/feature-telemetry.test.ts
 *
 * Covers:
 * - MockFeatureExtractor deterministic outputs
 * - DefaultFeatureExtractorRegistry register/get/list/has
 * - computeActivationDigest consistent hashing
 * - FeatureTelemetryRecorder end-to-end snapshot recording
 * - Snapshot provenance fields (activationDigest, extractorId, versionHash, schemaHash)
 * - Optional blobRef and keyRef passthrough
 * - Safety vector utilities (merge, normalize, similarity)
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  MockFeatureExtractor,
  DefaultFeatureExtractorRegistry,
  FeatureTelemetryRecorder,
  FeatureTelemetryError,
  FeatureTelemetryException,
  computeActivationDigest,
  mergeSafetyVectors,
  normalizeSafetyVector,
  computeVectorSimilarity,
} from "../index.js";
import type {
  TokenBlock,
  FeatureExtractor,
  FeatureExtractorRegistry,
  SafetyFeatureVector,
  ActivationVector,
} from "../index.js";

// =============================================================================
// TEST FIXTURES
// =============================================================================

function createTokenBlock(overrides: Partial<TokenBlock> = {}): TokenBlock {
  return {
    tokens: [100, 200, 300],
    startIndex: 0,
    endIndex: 3,
    modelId: "mock-model-v1",
    ...overrides,
  };
}

function createActivationVector(
  values: number[],
  overrides: Partial<ActivationVector> = {},
): ActivationVector {
  return {
    values: new Float64Array(values),
    layerId: "layer_0",
    position: 0,
    ...overrides,
  };
}

function createSafetyFeatureVector(
  activations: ActivationVector[],
  overrides: Partial<SafetyFeatureVector> = {},
): SafetyFeatureVector {
  let featureCount = 0;
  for (const a of activations) {
    featureCount += a.values.length;
  }
  return {
    features: activations,
    featureCount,
    extractorId: "test-extractor",
    ...overrides,
  };
}

// =============================================================================
// MockFeatureExtractor Tests
// =============================================================================

describe("MockFeatureExtractor", () => {
  let extractor: MockFeatureExtractor;

  beforeEach(() => {
    extractor = new MockFeatureExtractor();
  });

  it("should have default properties", () => {
    expect(extractor.extractorId).toBe("mock-extractor-v1");
    expect(extractor.modelId).toBe("mock-model-v1");
    expect(extractor.versionHash).toBeDefined();
    expect(extractor.schemaHash).toBeDefined();
    expect(extractor.versionHash.length).toBe(64);
    expect(extractor.schemaHash.length).toBe(64);
  });

  it("should accept custom configuration", () => {
    const custom = new MockFeatureExtractor({
      extractorId: "my-extractor",
      modelId: "my-model",
      versionHash: "abc123",
      schemaHash: "def456",
    });
    expect(custom.extractorId).toBe("my-extractor");
    expect(custom.modelId).toBe("my-model");
    expect(custom.versionHash).toBe("abc123");
    expect(custom.schemaHash).toBe("def456");
  });

  it("should produce deterministic outputs for the same input", async () => {
    const tokenBlock = createTokenBlock();
    const result1 = await extractor.extract(tokenBlock);
    const result2 = await extractor.extract(tokenBlock);

    expect(result1.features.length).toBe(result2.features.length);
    expect(result1.featureCount).toBe(result2.featureCount);
    expect(result1.extractorId).toBe(result2.extractorId);

    // Check that individual activation values are identical
    for (let i = 0; i < result1.features.length; i++) {
      const f1 = result1.features[i]!;
      const f2 = result2.features[i]!;
      expect(f1.layerId).toBe(f2.layerId);
      expect(f1.position).toBe(f2.position);
      expect(Array.from(f1.values)).toEqual(Array.from(f2.values));
    }
  });

  it("should produce different outputs for different tokens", async () => {
    const block1 = createTokenBlock({ tokens: [100, 200, 300] });
    const block2 = createTokenBlock({ tokens: [400, 500, 600] });

    const result1 = await extractor.extract(block1);
    const result2 = await extractor.extract(block2);

    // Structures are the same shape
    expect(result1.features.length).toBe(result2.features.length);

    // But values differ
    const f1 = result1.features[0]!;
    const f2 = result2.features[0]!;
    const valuesMatch = Array.from(f1.values).every(
      (v, i) => v === f2.values[i],
    );
    expect(valuesMatch).toBe(false);
  });

  it("should generate one activation per token per layer", async () => {
    const tokenBlock = createTokenBlock({ tokens: [1, 2, 3, 4, 5] });
    const result = await extractor.extract(tokenBlock);
    // Default: 1 layer, 5 tokens = 5 activation vectors
    expect(result.features.length).toBe(5);
  });

  it("should support multiple layers", async () => {
    const multiLayerExtractor = new MockFeatureExtractor({
      layerIds: ["layer_0", "layer_1", "layer_2"],
    });
    const tokenBlock = createTokenBlock({ tokens: [1, 2] });
    const result = await multiLayerExtractor.extract(tokenBlock);
    // 3 layers * 2 tokens = 6 activation vectors
    expect(result.features.length).toBe(6);
  });

  it("should throw INVALID_TOKEN_BLOCK for empty tokens", async () => {
    const tokenBlock = createTokenBlock({ tokens: [] });
    await expect(extractor.extract(tokenBlock)).rejects.toThrow(
      FeatureTelemetryException,
    );
    try {
      await extractor.extract(tokenBlock);
    } catch (err) {
      expect(err).toBeInstanceOf(FeatureTelemetryException);
      expect((err as FeatureTelemetryException).code).toBe(
        FeatureTelemetryError.INVALID_TOKEN_BLOCK,
      );
    }
  });

  it("should throw INVALID_TOKEN_BLOCK for invalid range", async () => {
    const tokenBlock = createTokenBlock({ startIndex: 5, endIndex: 3 });
    await expect(extractor.extract(tokenBlock)).rejects.toThrow(
      FeatureTelemetryException,
    );
  });
});

// =============================================================================
// DefaultFeatureExtractorRegistry Tests
// =============================================================================

describe("DefaultFeatureExtractorRegistry", () => {
  let registry: DefaultFeatureExtractorRegistry;

  beforeEach(() => {
    registry = new DefaultFeatureExtractorRegistry();
  });

  it("should start empty", () => {
    expect(registry.list()).toEqual([]);
    expect(registry.has("anything")).toBe(false);
    expect(registry.get("anything")).toBeUndefined();
  });

  it("should register and retrieve an extractor", () => {
    const extractor = new MockFeatureExtractor();
    registry.register(extractor);

    expect(registry.has(extractor.extractorId)).toBe(true);
    expect(registry.get(extractor.extractorId)).toBe(extractor);
    expect(registry.list()).toContain(extractor.extractorId);
  });

  it("should register multiple extractors", () => {
    const ext1 = new MockFeatureExtractor({ extractorId: "ext-1" });
    const ext2 = new MockFeatureExtractor({ extractorId: "ext-2" });
    registry.register(ext1);
    registry.register(ext2);

    expect(registry.list()).toHaveLength(2);
    expect(registry.list()).toContain("ext-1");
    expect(registry.list()).toContain("ext-2");
    expect(registry.get("ext-1")).toBe(ext1);
    expect(registry.get("ext-2")).toBe(ext2);
  });

  it("should throw on duplicate registration", () => {
    const ext1 = new MockFeatureExtractor({ extractorId: "dup-id" });
    const ext2 = new MockFeatureExtractor({ extractorId: "dup-id" });
    registry.register(ext1);

    expect(() => registry.register(ext2)).toThrow(FeatureTelemetryException);
    try {
      registry.register(ext2);
    } catch (err) {
      expect((err as FeatureTelemetryException).code).toBe(
        FeatureTelemetryError.EXTRACTOR_REGISTRATION_FAILED,
      );
    }
  });

  it("should return undefined for unknown extractor", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });
});

// =============================================================================
// computeActivationDigest Tests
// =============================================================================

describe("computeActivationDigest", () => {
  it("should produce a valid digest with SHA-256 hash", async () => {
    const vector = createSafetyFeatureVector([
      createActivationVector([0.5, -0.3, 0.8, 0.1]),
    ]);

    const digest = await computeActivationDigest(vector, 4);

    expect(digest.algorithm).toBe("sha256");
    expect(digest.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(digest.topK).toBe(4);
    expect(digest.featureCount).toBe(4);
  });

  it("should produce consistent hashes for the same input", async () => {
    const vector = createSafetyFeatureVector([
      createActivationVector([1.0, 2.0, 3.0, -4.0, 0.5]),
    ]);

    const digest1 = await computeActivationDigest(vector, 3);
    const digest2 = await computeActivationDigest(vector, 3);

    expect(digest1.hash).toBe(digest2.hash);
    expect(digest1.topK).toBe(digest2.topK);
    expect(digest1.featureCount).toBe(digest2.featureCount);
  });

  it("should produce different hashes for different inputs", async () => {
    const vector1 = createSafetyFeatureVector([
      createActivationVector([1.0, 2.0, 3.0]),
    ]);
    const vector2 = createSafetyFeatureVector([
      createActivationVector([4.0, 5.0, 6.0]),
    ]);

    const digest1 = await computeActivationDigest(vector1, 3);
    const digest2 = await computeActivationDigest(vector2, 3);

    expect(digest1.hash).not.toBe(digest2.hash);
  });

  it("should respect topK parameter", async () => {
    const vector = createSafetyFeatureVector([
      createActivationVector([0.1, 0.5, 0.9, 0.2, 0.8, 0.3]),
    ]);

    const digest2 = await computeActivationDigest(vector, 2);
    const digest4 = await computeActivationDigest(vector, 4);

    expect(digest2.topK).toBe(2);
    expect(digest4.topK).toBe(4);
    // Different topK should produce different hashes
    expect(digest2.hash).not.toBe(digest4.hash);
  });

  it("should handle topK larger than feature count", async () => {
    const vector = createSafetyFeatureVector([
      createActivationVector([1.0, 2.0]),
    ]);

    const digest = await computeActivationDigest(vector, 100);

    // topK should be clamped to actual feature count
    expect(digest.topK).toBe(2);
  });

  it("should handle empty features", async () => {
    const vector = createSafetyFeatureVector([], {
      featureCount: 0,
    });

    const digest = await computeActivationDigest(vector, 10);
    expect(digest.topK).toBe(0);
    expect(digest.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should throw INVALID_ACTIVATION for NaN values", async () => {
    const vector = createSafetyFeatureVector([
      createActivationVector([1.0, NaN, 3.0]),
    ]);

    await expect(computeActivationDigest(vector)).rejects.toThrow(
      FeatureTelemetryException,
    );
  });

  it("should throw INVALID_ACTIVATION for Infinity values", async () => {
    const vector = createSafetyFeatureVector([
      createActivationVector([1.0, Infinity, 3.0]),
    ]);

    await expect(computeActivationDigest(vector)).rejects.toThrow(
      FeatureTelemetryException,
    );
  });
});

// =============================================================================
// FeatureTelemetryRecorder Tests
// =============================================================================

describe("FeatureTelemetryRecorder", () => {
  let registry: DefaultFeatureExtractorRegistry;
  let recorder: FeatureTelemetryRecorder;
  let extractor: MockFeatureExtractor;

  beforeEach(() => {
    registry = new DefaultFeatureExtractorRegistry();
    extractor = new MockFeatureExtractor();
    registry.register(extractor);
    recorder = new FeatureTelemetryRecorder(registry);
  });

  it("should record a snapshot with all required provenance fields", async () => {
    const tokenBlock = createTokenBlock();
    const artifact = await recorder.recordSnapshot(
      extractor.extractorId,
      tokenBlock,
    );

    // All required fields must be present and non-empty
    expect(artifact.activationDigest).toBeDefined();
    expect(artifact.activationDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.featureExtractorId).toBe(extractor.extractorId);
    expect(artifact.featureExtractorVersionHash).toBe(extractor.versionHash);
    expect(artifact.featureSchemaHash).toBe(extractor.schemaHash);
    expect(artifact.modelId).toBe(extractor.modelId);
    expect(artifact.tokenRange).toEqual([0, 3]);
    expect(artifact.featureCount).toBeGreaterThan(0);
  });

  it("should always include activationDigest, extractorId, versionHash, schemaHash", async () => {
    const tokenBlock = createTokenBlock();
    const artifact = await recorder.recordSnapshot(
      extractor.extractorId,
      tokenBlock,
    );

    // These four provenance fields are the non-negotiable core
    expect(typeof artifact.activationDigest).toBe("string");
    expect(artifact.activationDigest.length).toBe(64);
    expect(typeof artifact.featureExtractorId).toBe("string");
    expect(artifact.featureExtractorId.length).toBeGreaterThan(0);
    expect(typeof artifact.featureExtractorVersionHash).toBe("string");
    expect(artifact.featureExtractorVersionHash.length).toBeGreaterThan(0);
    expect(typeof artifact.featureSchemaHash).toBe("string");
    expect(artifact.featureSchemaHash.length).toBeGreaterThan(0);
  });

  it("should pass through optional blobRef", async () => {
    const tokenBlock = createTokenBlock();
    const artifact = await recorder.recordSnapshot(
      extractor.extractorId,
      tokenBlock,
      { blobRef: "ipfs://QmTest123" },
    );

    expect(artifact.blobRef).toBe("ipfs://QmTest123");
  });

  it("should pass through optional keyRef", async () => {
    const tokenBlock = createTokenBlock();
    const artifact = await recorder.recordSnapshot(
      extractor.extractorId,
      tokenBlock,
      { keyRef: "tee://sealed-key-456" },
    );

    expect(artifact.keyRef).toBe("tee://sealed-key-456");
  });

  it("should pass through both blobRef and keyRef", async () => {
    const tokenBlock = createTokenBlock();
    const artifact = await recorder.recordSnapshot(
      extractor.extractorId,
      tokenBlock,
      {
        blobRef: "ipfs://QmBlob789",
        keyRef: "tee://sealed-key-xyz",
      },
    );

    expect(artifact.blobRef).toBe("ipfs://QmBlob789");
    expect(artifact.keyRef).toBe("tee://sealed-key-xyz");
  });

  it("should not include blobRef or keyRef when not provided", async () => {
    const tokenBlock = createTokenBlock();
    const artifact = await recorder.recordSnapshot(
      extractor.extractorId,
      tokenBlock,
    );

    expect(artifact.blobRef).toBeUndefined();
    expect(artifact.keyRef).toBeUndefined();
  });

  it("should produce deterministic snapshots for the same input", async () => {
    const tokenBlock = createTokenBlock();
    const artifact1 = await recorder.recordSnapshot(
      extractor.extractorId,
      tokenBlock,
    );
    const artifact2 = await recorder.recordSnapshot(
      extractor.extractorId,
      tokenBlock,
    );

    expect(artifact1.activationDigest).toBe(artifact2.activationDigest);
    expect(artifact1.featureExtractorId).toBe(artifact2.featureExtractorId);
    expect(artifact1.featureExtractorVersionHash).toBe(
      artifact2.featureExtractorVersionHash,
    );
    expect(artifact1.featureSchemaHash).toBe(artifact2.featureSchemaHash);
    expect(artifact1.featureCount).toBe(artifact2.featureCount);
  });

  it("should throw EXTRACTOR_NOT_FOUND for unknown extractor", async () => {
    const tokenBlock = createTokenBlock();
    await expect(
      recorder.recordSnapshot("nonexistent-extractor", tokenBlock),
    ).rejects.toThrow(FeatureTelemetryException);

    try {
      await recorder.recordSnapshot("nonexistent-extractor", tokenBlock);
    } catch (err) {
      expect((err as FeatureTelemetryException).code).toBe(
        FeatureTelemetryError.EXTRACTOR_NOT_FOUND,
      );
    }
  });

  it("should throw INVALID_TOKEN_BLOCK for empty tokens", async () => {
    const tokenBlock = createTokenBlock({ tokens: [] });
    await expect(
      recorder.recordSnapshot(extractor.extractorId, tokenBlock),
    ).rejects.toThrow(FeatureTelemetryException);

    try {
      await recorder.recordSnapshot(extractor.extractorId, tokenBlock);
    } catch (err) {
      expect((err as FeatureTelemetryException).code).toBe(
        FeatureTelemetryError.INVALID_TOKEN_BLOCK,
      );
    }
  });

  it("should set tokenRange from the token block", async () => {
    const tokenBlock = createTokenBlock({
      tokens: [10, 20, 30, 40],
      startIndex: 5,
      endIndex: 9,
    });
    const artifact = await recorder.recordSnapshot(
      extractor.extractorId,
      tokenBlock,
    );

    expect(artifact.tokenRange).toEqual([5, 9]);
  });
});

// =============================================================================
// Safety Vector Utilities Tests
// =============================================================================

describe("mergeSafetyVectors", () => {
  it("should merge multiple vectors into one", () => {
    const v1 = createSafetyFeatureVector([
      createActivationVector([1.0, 2.0]),
    ]);
    const v2 = createSafetyFeatureVector([
      createActivationVector([3.0, 4.0]),
    ]);

    const merged = mergeSafetyVectors([v1, v2]);

    expect(merged.features.length).toBe(2);
    expect(merged.featureCount).toBe(4); // 2 + 2
    expect(merged.extractorId).toBe("merged");
  });

  it("should preserve all activation values when merging", () => {
    const v1 = createSafetyFeatureVector([
      createActivationVector([1.0, 2.0]),
    ]);
    const v2 = createSafetyFeatureVector([
      createActivationVector([3.0, 4.0]),
    ]);

    const merged = mergeSafetyVectors([v1, v2]);

    expect(Array.from(merged.features[0]!.values)).toEqual([1.0, 2.0]);
    expect(Array.from(merged.features[1]!.values)).toEqual([3.0, 4.0]);
  });

  it("should record merged-from metadata", () => {
    const v1 = createSafetyFeatureVector([], {
      extractorId: "ext-a",
      featureCount: 0,
    });
    const v2 = createSafetyFeatureVector([], {
      extractorId: "ext-b",
      featureCount: 0,
    });

    const merged = mergeSafetyVectors([v1, v2]);

    expect(merged.metadata?.mergedFrom).toEqual(["ext-a", "ext-b"]);
    expect(merged.metadata?.mergedCount).toBe(2);
  });

  it("should throw for empty input array", () => {
    expect(() => mergeSafetyVectors([])).toThrow(FeatureTelemetryException);
  });

  it("should handle single vector merge", () => {
    const v1 = createSafetyFeatureVector([
      createActivationVector([5.0, 6.0]),
    ]);

    const merged = mergeSafetyVectors([v1]);
    expect(merged.features.length).toBe(1);
    expect(merged.featureCount).toBe(2);
  });
});

describe("normalizeSafetyVector", () => {
  it("should produce unit-length activation vectors", () => {
    const vector = createSafetyFeatureVector([
      createActivationVector([3.0, 4.0]), // L2 norm = 5.0
    ]);

    const normalized = normalizeSafetyVector(vector);

    const values = Array.from(normalized.features[0]!.values);
    expect(values[0]).toBeCloseTo(0.6, 10); // 3/5
    expect(values[1]).toBeCloseTo(0.8, 10); // 4/5

    // Verify L2 norm is 1.0
    const norm = Math.sqrt(
      values.reduce((sum, v) => sum + v * v, 0),
    );
    expect(norm).toBeCloseTo(1.0, 10);
  });

  it("should handle zero vectors without error", () => {
    const vector = createSafetyFeatureVector([
      createActivationVector([0.0, 0.0, 0.0]),
    ]);

    const normalized = normalizeSafetyVector(vector);

    const values = Array.from(normalized.features[0]!.values);
    expect(values).toEqual([0.0, 0.0, 0.0]);
  });

  it("should preserve extractorId and featureCount", () => {
    const vector = createSafetyFeatureVector(
      [createActivationVector([1.0, 0.0])],
      { extractorId: "my-ext" },
    );

    const normalized = normalizeSafetyVector(vector);

    expect(normalized.extractorId).toBe("my-ext");
    expect(normalized.featureCount).toBe(vector.featureCount);
  });

  it("should add normalized metadata", () => {
    const vector = createSafetyFeatureVector([
      createActivationVector([1.0]),
    ]);

    const normalized = normalizeSafetyVector(vector);
    expect(normalized.metadata?.normalized).toBe(true);
  });

  it("should not mutate the original vector", () => {
    const original = createActivationVector([3.0, 4.0]);
    const vector = createSafetyFeatureVector([original]);

    normalizeSafetyVector(vector);

    // Original should be unchanged
    expect(Array.from(original.values)).toEqual([3.0, 4.0]);
  });
});

describe("computeVectorSimilarity", () => {
  it("should return 1.0 for identical vectors", () => {
    const v = createSafetyFeatureVector([
      createActivationVector([1.0, 2.0, 3.0]),
    ]);

    const similarity = computeVectorSimilarity(v, v);
    expect(similarity).toBeCloseTo(1.0, 10);
  });

  it("should return -1.0 for opposite vectors", () => {
    const v1 = createSafetyFeatureVector([
      createActivationVector([1.0, 2.0, 3.0]),
    ]);
    const v2 = createSafetyFeatureVector([
      createActivationVector([-1.0, -2.0, -3.0]),
    ]);

    const similarity = computeVectorSimilarity(v1, v2);
    expect(similarity).toBeCloseTo(-1.0, 10);
  });

  it("should return 0.0 for orthogonal vectors", () => {
    const v1 = createSafetyFeatureVector([
      createActivationVector([1.0, 0.0]),
    ]);
    const v2 = createSafetyFeatureVector([
      createActivationVector([0.0, 1.0]),
    ]);

    const similarity = computeVectorSimilarity(v1, v2);
    expect(similarity).toBeCloseTo(0.0, 10);
  });

  it("should return 0.0 when one vector is all zeros", () => {
    const v1 = createSafetyFeatureVector([
      createActivationVector([1.0, 2.0]),
    ]);
    const v2 = createSafetyFeatureVector([
      createActivationVector([0.0, 0.0]),
    ]);

    const similarity = computeVectorSimilarity(v1, v2);
    expect(similarity).toBe(0.0);
  });

  it("should throw for vectors of different dimensions", () => {
    const v1 = createSafetyFeatureVector([
      createActivationVector([1.0, 2.0]),
    ]);
    const v2 = createSafetyFeatureVector([
      createActivationVector([1.0, 2.0, 3.0]),
    ]);

    expect(() => computeVectorSimilarity(v1, v2)).toThrow(
      FeatureTelemetryException,
    );
  });

  it("should handle multi-feature vectors", () => {
    const v1 = createSafetyFeatureVector([
      createActivationVector([1.0, 0.0], { layerId: "l0", position: 0 }),
      createActivationVector([0.0, 1.0], { layerId: "l1", position: 1 }),
    ]);
    const v2 = createSafetyFeatureVector([
      createActivationVector([1.0, 0.0], { layerId: "l0", position: 0 }),
      createActivationVector([0.0, 1.0], { layerId: "l1", position: 1 }),
    ]);

    const similarity = computeVectorSimilarity(v1, v2);
    expect(similarity).toBeCloseTo(1.0, 10);
  });

  it("should compute correct similarity for known values", () => {
    // cos([1,2,3], [4,5,6]) = (4+10+18) / (sqrt(14) * sqrt(77))
    //                        = 32 / sqrt(1078)
    //                        ≈ 0.9746
    const v1 = createSafetyFeatureVector([
      createActivationVector([1.0, 2.0, 3.0]),
    ]);
    const v2 = createSafetyFeatureVector([
      createActivationVector([4.0, 5.0, 6.0]),
    ]);

    const similarity = computeVectorSimilarity(v1, v2);
    const expected = 32 / Math.sqrt(14 * 77);
    expect(similarity).toBeCloseTo(expected, 10);
  });
});
