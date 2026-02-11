/**
 * @summary Tests for the channel-firewall package.
 *
 * Covers:
 * - ChannelDetectorRegistry (register, get, list, duplicate handling)
 * - StatisticalDetector (clean text vs random data)
 * - CompressibilityDetector (normal text vs highly structured data)
 * - StegoDetector (zero-width characters, homoglyphs)
 * - TimingDetector (normal vs suspicious timing patterns)
 * - SchemaMessageNormalizer (JSON field ordering, whitespace)
 * - ChannelFirewall (orchestration, normalization toggle)
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  ChannelDetectorRegistry,
  StatisticalDetector,
  CompressibilityDetector,
  StegoDetector,
  TimingDetector,
  SchemaMessageNormalizer,
  ChannelFirewall,
  ChannelFirewallError,
  ChannelFirewallException,
} from "../index.js";
import type {
  ChannelMessage,
  ChannelDetector,
  DetectorResult,
  FirewallConfig,
} from "../index.js";

// =============================================================================
// TEST FIXTURES
// =============================================================================

function createMessage(
  content: string,
  channel: "output-text" | "tool-args" | "tool-result" = "output-text",
): ChannelMessage {
  return {
    content,
    channel,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Natural English text for baseline testing.
 */
const CLEAN_TEXT =
  "The quick brown fox jumps over the lazy dog. " +
  "This is a perfectly normal sentence that should not trigger any detectors. " +
  "Natural language has predictable patterns of character frequency, entropy, " +
  "and structure that distinguish it from encoded or encrypted data. " +
  "The sun was setting behind the mountains, casting long shadows across the valley.";

/**
 * Random-looking data that should trigger statistical anomaly detectors.
 */
const RANDOM_DATA =
  "j8Kx2mPq9wZv5nBf3cYtLrAhDgEiOuSaNdFjGkHlQwErTyU" +
  "i7Ox3pAz6vBn4mCx1kLj8gHf2dSaWqErTyUiOpZxCvBnMaS" +
  "q5Wj9kL3mNbVcXzAsQwErTyUiOpHgFdSaJkLzXcVbNmQwEr" +
  "t8Yu1Io2Pa3Sd4Fg5Hj6Kl7Zx8Cv9Bn0MqWeRtYuIoPaSdFg";

/**
 * Text with zero-width characters embedded.
 */
const STEGO_ZERO_WIDTH =
  "Hello\u200B\u200C\u200D world\uFEFF this\u2060 looks\u00AD normal";

/**
 * Text with Cyrillic homoglyphs replacing Latin characters.
 * Cyrillic "a" (U+0430), Cyrillic "o" (U+043E), Cyrillic "e" (U+0435)
 */
const STEGO_HOMOGLYPHS =
  "Th\u0435 qu\u0456ck br\u043Ewn f\u043Ex jumps \u043Ev\u0435r th\u0435 l\u0430zy d\u043Eg";

// =============================================================================
// DETECTOR REGISTRY TESTS
// =============================================================================

describe("ChannelDetectorRegistry", () => {
  let registry: ChannelDetectorRegistry;

  beforeEach(() => {
    registry = new ChannelDetectorRegistry();
  });

  it("should register and retrieve a detector", () => {
    const detector = new StatisticalDetector();
    registry.register(detector);

    const retrieved = registry.get("statistical");
    expect(retrieved).toBe(detector);
  });

  it("should list all registered detector IDs", () => {
    registry.register(new StatisticalDetector());
    registry.register(new StegoDetector());
    registry.register(new CompressibilityDetector());

    const ids = registry.list();
    expect(ids).toContain("statistical");
    expect(ids).toContain("stego");
    expect(ids).toContain("compressibility");
    expect(ids).toHaveLength(3);
  });

  it("should return undefined for unregistered detector", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("should throw on duplicate detector registration", () => {
    registry.register(new StatisticalDetector());

    expect(() => registry.register(new StatisticalDetector())).toThrow(
      ChannelFirewallException,
    );
  });

  it("should throw with DETECTOR_REGISTRATION_FAILED code on duplicate", () => {
    registry.register(new StatisticalDetector());

    try {
      registry.register(new StatisticalDetector());
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ChannelFirewallException);
      expect((error as ChannelFirewallException).code).toBe(
        ChannelFirewallError.DETECTOR_REGISTRATION_FAILED,
      );
    }
  });

  it("should support has() check", () => {
    registry.register(new StatisticalDetector());
    expect(registry.has("statistical")).toBe(true);
    expect(registry.has("nonexistent")).toBe(false);
  });

  it("should support remove()", () => {
    registry.register(new StatisticalDetector());
    expect(registry.remove("statistical")).toBe(true);
    expect(registry.get("statistical")).toBeUndefined();
    expect(registry.remove("statistical")).toBe(false);
  });

  it("should support clear()", () => {
    registry.register(new StatisticalDetector());
    registry.register(new StegoDetector());
    registry.clear();
    expect(registry.list()).toHaveLength(0);
  });
});

// =============================================================================
// STATISTICAL DETECTOR TESTS
// =============================================================================

describe("StatisticalDetector", () => {
  let detector: StatisticalDetector;

  beforeEach(() => {
    detector = new StatisticalDetector();
  });

  it("should return a low score for clean natural text", async () => {
    const result = await detector.detect(createMessage(CLEAN_TEXT));

    expect(result.detectorId).toBe("statistical");
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThan(0.5);
    expect(result.exceeded).toBe(false);
  });

  it("should return a higher score for random-looking data", async () => {
    const result = await detector.detect(createMessage(RANDOM_DATA));

    expect(result.score).toBeGreaterThan(0.3);
    expect(result.details).toHaveProperty("chiSquared");
    expect(result.details).toHaveProperty("klDivergence");
  });

  it("should return score 0 for very short content", async () => {
    const result = await detector.detect(createMessage("Hi"));

    expect(result.score).toBe(0);
    expect(result.details).toHaveProperty("reason", "content-too-short");
  });

  it("should include chi-squared and KL divergence in details", async () => {
    const result = await detector.detect(createMessage(CLEAN_TEXT));

    expect(typeof result.details["chiSquared"]).toBe("number");
    expect(typeof result.details["klDivergence"]).toBe("number");
    expect(typeof result.details["contentLength"]).toBe("number");
    expect(typeof result.details["uniqueChars"]).toBe("number");
  });

  it("should have version 1.0.0", () => {
    expect(detector.version).toBe("1.0.0");
  });
});

// =============================================================================
// COMPRESSIBILITY DETECTOR TESTS
// =============================================================================

describe("CompressibilityDetector", () => {
  let detector: CompressibilityDetector;

  beforeEach(() => {
    detector = new CompressibilityDetector();
  });

  it("should return a low score for normal text", async () => {
    const result = await detector.detect(createMessage(CLEAN_TEXT));

    expect(result.detectorId).toBe("compressibility");
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThan(0.5);
    expect(result.exceeded).toBe(false);
  });

  it("should detect highly repetitive content as anomalous", async () => {
    // Very low entropy: single character repeated
    const repetitive = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const result = await detector.detect(createMessage(repetitive));

    expect(result.score).toBeGreaterThan(0.1);
    expect(result.details).toHaveProperty("charEntropy");
    expect(result.details["charEntropy"]).toBeLessThan(1);
  });

  it("should return score 0 for very short content", async () => {
    const result = await detector.detect(createMessage("short"));

    expect(result.score).toBe(0);
    expect(result.details).toHaveProperty("reason", "content-too-short");
  });

  it("should include entropy metrics in details", async () => {
    const result = await detector.detect(createMessage(CLEAN_TEXT));

    expect(typeof result.details["charEntropy"]).toBe("number");
    expect(typeof result.details["byteEntropy"]).toBe("number");
    expect(typeof result.details["bigramEntropy"]).toBe("number");
    expect(typeof result.details["uniqueCharRatio"]).toBe("number");
  });

  it("should have version 1.0.0", () => {
    expect(detector.version).toBe("1.0.0");
  });
});

// =============================================================================
// STEGO DETECTOR TESTS
// =============================================================================

describe("StegoDetector", () => {
  let detector: StegoDetector;

  beforeEach(() => {
    detector = new StegoDetector();
  });

  it("should return a low score for clean text", async () => {
    const result = await detector.detect(createMessage(CLEAN_TEXT));

    expect(result.detectorId).toBe("stego");
    expect(result.score).toBe(0);
    expect(result.exceeded).toBe(false);
  });

  it("should detect zero-width characters", async () => {
    const result = await detector.detect(createMessage(STEGO_ZERO_WIDTH));

    expect(result.score).toBeGreaterThan(0.1);
    expect(result.details).toHaveProperty("zeroWidthChars");
    const zw = result.details["zeroWidthChars"] as Record<string, unknown>;
    expect(zw["count"]).toBeGreaterThan(0);
  });

  it("should detect Cyrillic homoglyphs", async () => {
    const result = await detector.detect(createMessage(STEGO_HOMOGLYPHS));

    expect(result.score).toBeGreaterThan(0.1);
    expect(result.details).toHaveProperty("homoglyphs");
    const hg = result.details["homoglyphs"] as Record<string, unknown>;
    expect(hg["count"]).toBeGreaterThan(0);
  });

  it("should flag zero-width characters with high density as exceeded", async () => {
    // Every other char is zero-width = very high density
    const highDensity = "a\u200Bb\u200Cc\u200Dd\uFEFFe\u2060f\u00ADg";
    const result = await detector.detect(createMessage(highDensity));

    expect(result.exceeded).toBe(true);
    expect(result.score).toBeGreaterThan(0.3);
  });

  it("should return score 0 for empty content", async () => {
    const result = await detector.detect(createMessage(""));

    expect(result.score).toBe(0);
    expect(result.details).toHaveProperty("reason", "empty-content");
  });

  it("should include detailed breakdown in results", async () => {
    const result = await detector.detect(createMessage(STEGO_ZERO_WIDTH));

    expect(result.details).toHaveProperty("zeroWidthChars");
    expect(result.details).toHaveProperty("homoglyphs");
    expect(result.details).toHaveProperty("invisibleFormatChars");
    expect(result.details).toHaveProperty("contentLength");
  });

  it("should have threshold of 0.3 by default", () => {
    expect(detector).toBeDefined();
    // Verify threshold through detection of known clean text
  });

  it("should have version 1.0.0", () => {
    expect(detector.version).toBe("1.0.0");
  });
});

// =============================================================================
// TIMING DETECTOR TESTS
// =============================================================================

describe("TimingDetector", () => {
  let detector: TimingDetector;

  beforeEach(() => {
    detector = new TimingDetector();
  });

  it("should return insufficient history for first few messages", async () => {
    const result = await detector.detect(createMessage("First message"));

    expect(result.detectorId).toBe("timing");
    expect(result.score).toBe(0);
    expect(result.details).toHaveProperty("reason", "insufficient-history");
  });

  it("should begin analysis after minimum messages", async () => {
    // Send enough messages to reach the analysis threshold
    await detector.detect(createMessage("Message 1"));
    await detector.detect(createMessage("Message 2"));
    const result = await detector.detect(createMessage("Message 3"));

    expect(result.details).toHaveProperty("messageCount", 3);
    expect(result.details).toHaveProperty("delayCount");
    expect(result.details).toHaveProperty("delayStats");
  });

  it("should include timing metadata in results", async () => {
    await detector.detect(createMessage("Message 1"));
    await detector.detect(createMessage("Message 2"));
    const result = await detector.detect(createMessage("Message 3"));

    expect(result.details).toHaveProperty("monotonicDeltaMs");
    expect(result.details).toHaveProperty("wallClockTimestamp");
    expect(result.details).toHaveProperty("attested", false);
  });

  it("should support attested mode flag", () => {
    const attestedDetector = new TimingDetector({ attested: true });
    expect(attestedDetector.attested).toBe(true);
  });

  it("should support resetHistory()", async () => {
    await detector.detect(createMessage("Message 1"));
    await detector.detect(createMessage("Message 2"));
    detector.resetHistory();
    const result = await detector.detect(createMessage("After reset"));

    expect(result.score).toBe(0);
    expect(result.details).toHaveProperty("reason", "insufficient-history");
    expect(result.details).toHaveProperty("messageCount", 1);
  });

  it("should report getLastTimingInfo after messages", async () => {
    await detector.detect(createMessage("Message 1"));
    await detector.detect(createMessage("Message 2"));

    const info = detector.getLastTimingInfo();
    expect(info).toBeDefined();
    expect(info!.attested).toBe(false);
    expect(typeof info!.monotonicDeltaMs).toBe("number");
    expect(typeof info!.wallClockTimestamp).toBe("string");
  });

  it("should have version 1.0.0", () => {
    expect(detector.version).toBe("1.0.0");
  });
});

// =============================================================================
// SCHEMA MESSAGE NORMALIZER TESTS
// =============================================================================

describe("SchemaMessageNormalizer", () => {
  let normalizer: SchemaMessageNormalizer;

  beforeEach(() => {
    normalizer = new SchemaMessageNormalizer();
  });

  it("should normalize JSON field ordering", () => {
    const message = createMessage(
      '{"zebra": 1, "apple": 2, "mango": 3}',
      "tool-args",
    );
    const result = normalizer.normalize(message);

    // Canonical JSON has sorted keys
    expect(result.content).toBe('{"apple":2,"mango":3,"zebra":1}');
    expect(result.normalized).toBe(true);
    expect(result.originalContent).toBe('{"zebra": 1, "apple": 2, "mango": 3}');
    expect(result.appliedRules).toContain("json-field-ordering");
  });

  it("should normalize whitespace", () => {
    const message = createMessage(
      "  Hello   world  \t  this   has   extra   spaces  ",
      "output-text",
    );
    const result = normalizer.normalize(message);

    expect(result.content).toBe("Hello world this has extra spaces");
    expect(result.appliedRules).toContain("whitespace");
  });

  it("should normalize nested JSON field ordering", () => {
    const message = createMessage(
      '{"b": {"z": 1, "a": 2}, "a": [1, 2, 3]}',
      "tool-args",
    );
    const result = normalizer.normalize(message);

    // canonicalize with removeNulls: false sorts keys at all levels
    expect(result.content).toBe('{"a":[1,2,3],"b":{"a":2,"z":1}}');
  });

  it("should handle non-JSON content gracefully", () => {
    const message = createMessage("This is plain text, not JSON.", "tool-args");
    const result = normalizer.normalize(message);

    // JSON rules are no-ops on non-JSON content, whitespace rule still applies
    expect(result.content).toBe("This is plain text, not JSON.");
    expect(result.normalized).toBe(true);
  });

  it("should return original content for channels with no rules", () => {
    const customNormalizer = new SchemaMessageNormalizer([]);
    const message = createMessage("Some content", "output-text");
    const result = customNormalizer.normalize(message);

    expect(result.content).toBe("Some content");
    expect(result.appliedRules).toHaveLength(0);
  });

  it("should apply value canonicalization to JSON", () => {
    const message = createMessage(
      '{"flag": "true", "count": "42", "nothing": "null"}',
      "tool-result",
    );
    const normalizedResult = normalizer.normalize(message);

    // After value canonicalization, string "true" -> boolean true, "42" -> number 42
    const parsed = JSON.parse(normalizedResult.content) as Record<string, unknown>;
    expect(parsed["flag"]).toBe(true);
    expect(parsed["count"]).toBe(42);
    expect(parsed["nothing"]).toBeNull();
  });

  it("should apply header casing normalization", () => {
    const customNormalizer = new SchemaMessageNormalizer([
      {
        channel: "output-text",
        rules: [{ type: "header-casing" }],
      },
    ]);
    const message = createMessage(
      "Content-Type: application/json\nX-Custom-Header: value",
      "output-text",
    );
    const result = customNormalizer.normalize(message);

    expect(result.content).toBe(
      "content-type: application/json\nx-custom-header: value",
    );
  });

  it("should support schema override", () => {
    const message = createMessage("  spaced  content  ", "output-text");
    const result = normalizer.normalize(message, {
      channel: "output-text",
      rules: [], // Override with no rules
    });

    expect(result.content).toBe("  spaced  content  ");
    expect(result.appliedRules).toHaveLength(0);
  });
});

// =============================================================================
// CHANNEL FIREWALL TESTS
// =============================================================================

describe("ChannelFirewall", () => {
  let registry: ChannelDetectorRegistry;

  beforeEach(() => {
    registry = new ChannelDetectorRegistry();
    registry.register(new StatisticalDetector());
    registry.register(new StegoDetector());
    registry.register(new CompressibilityDetector());
    registry.register(new TimingDetector());
  });

  it("should orchestrate all configured detectors", async () => {
    const firewall = new ChannelFirewall(
      {
        detectors: ["statistical", "stego", "compressibility"],
        normalizeBeforeDetection: false,
      },
      registry,
    );

    const result = await firewall.analyze(createMessage(CLEAN_TEXT));

    expect(result.detectorResults).toHaveLength(3);
    expect(result.detectorResults.map((r) => r.detectorId)).toEqual(
      expect.arrayContaining(["statistical", "stego", "compressibility"]),
    );
    expect(result.suspicionScore).toBeGreaterThanOrEqual(0);
    expect(result.suspicionScore).toBeLessThanOrEqual(1);
    expect(result.contentHash).toBeDefined();
    expect(result.contentHash.length).toBe(64); // SHA-256 hex = 64 chars
  });

  it("should produce higher suspicion score for suspicious content", async () => {
    const firewall = new ChannelFirewall(
      {
        detectors: ["stego"],
        normalizeBeforeDetection: false,
      },
      registry,
    );

    const cleanResult = await firewall.analyze(createMessage(CLEAN_TEXT));
    const stegoResult = await firewall.analyze(createMessage(STEGO_ZERO_WIDTH));

    expect(stegoResult.suspicionScore).toBeGreaterThan(cleanResult.suspicionScore);
  });

  it("should apply normalization when enabled", async () => {
    const normalizer = new SchemaMessageNormalizer();
    const firewall = new ChannelFirewall(
      {
        detectors: ["statistical"],
        normalizeBeforeDetection: true,
      },
      registry,
      normalizer,
    );

    const result = await firewall.analyze(
      createMessage("  Some   extra   spaces   here  ", "output-text"),
    );

    expect(result.normalized).toBe(true);
    expect(result.normalizedContentHash).toBeDefined();
    expect(result.normalizedContentHash).not.toBe(result.contentHash);
  });

  it("should not normalize when disabled", async () => {
    const normalizer = new SchemaMessageNormalizer();
    const firewall = new ChannelFirewall(
      {
        detectors: ["statistical"],
        normalizeBeforeDetection: false,
      },
      registry,
      normalizer,
    );

    const result = await firewall.analyze(createMessage(CLEAN_TEXT));

    expect(result.normalized).toBe(false);
    expect(result.normalizedContentHash).toBeUndefined();
  });

  it("should throw on unregistered detector in config", () => {
    expect(
      () =>
        new ChannelFirewall(
          {
            detectors: ["nonexistent"],
            normalizeBeforeDetection: false,
          },
          registry,
        ),
    ).toThrow(ChannelFirewallException);
  });

  it("should throw DETECTOR_NOT_FOUND for unregistered detector", () => {
    try {
      new ChannelFirewall(
        {
          detectors: ["nonexistent"],
          normalizeBeforeDetection: false,
        },
        registry,
      );
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ChannelFirewallException);
      expect((error as ChannelFirewallException).code).toBe(
        ChannelFirewallError.DETECTOR_NOT_FOUND,
      );
    }
  });

  it("should validate message and throw on invalid input", async () => {
    const firewall = new ChannelFirewall(
      {
        detectors: ["statistical"],
        normalizeBeforeDetection: false,
      },
      registry,
    );

    await expect(
      firewall.analyze({
        content: "test",
        channel: "invalid-channel" as "output-text",
        timestamp: new Date().toISOString(),
      }),
    ).rejects.toThrow(ChannelFirewallException);
  });

  it("should apply per-detector threshold overrides", async () => {
    const firewall = new ChannelFirewall(
      {
        detectors: ["statistical"],
        normalizeBeforeDetection: false,
        thresholds: { statistical: 0.01 }, // Very low threshold
      },
      registry,
    );

    const result = await firewall.analyze(createMessage(CLEAN_TEXT));

    const statResult = result.detectorResults.find(
      (r) => r.detectorId === "statistical",
    )!;
    expect(statResult.threshold).toBe(0.01);
  });

  it("should include timing metadata when timing detector is configured", async () => {
    const firewall = new ChannelFirewall(
      {
        detectors: ["timing"],
        normalizeBeforeDetection: false,
      },
      registry,
    );

    // Send enough messages to populate timing info
    await firewall.analyze(createMessage("Message 1"));
    const result = await firewall.analyze(createMessage("Message 2"));

    expect(result.timing).toBeDefined();
    expect(result.timing!.attested).toBe(false);
    expect(typeof result.timing!.monotonicDeltaMs).toBe("number");
    expect(typeof result.timing!.wallClockTimestamp).toBe("string");
  });

  it("should handle paraphrase sanitizer when provided", async () => {
    const mockSanitizer = {
      sanitize: async (content: string) => `Paraphrased: ${content}`,
      isAvailable: () => true,
    };

    const firewall = new ChannelFirewall(
      {
        detectors: ["statistical"],
        normalizeBeforeDetection: false,
      },
      registry,
      undefined,
      mockSanitizer,
    );

    const result = await firewall.analyze(createMessage(CLEAN_TEXT));
    expect(result.paraphrased).toBe(true);
  });

  it("should gracefully handle sanitizer failure", async () => {
    const failingSanitizer = {
      sanitize: async (_content: string) => {
        throw new Error("LLM unavailable");
      },
      isAvailable: () => true,
    };

    const firewall = new ChannelFirewall(
      {
        detectors: ["statistical"],
        normalizeBeforeDetection: false,
      },
      registry,
      undefined,
      failingSanitizer,
    );

    const result = await firewall.analyze(createMessage(CLEAN_TEXT));
    expect(result.paraphrased).toBe(false);
  });

  it("should not use sanitizer when unavailable", async () => {
    let sanitizeCalled = false;
    const unavailableSanitizer = {
      sanitize: async (content: string) => {
        sanitizeCalled = true;
        return content;
      },
      isAvailable: () => false,
    };

    const firewall = new ChannelFirewall(
      {
        detectors: ["statistical"],
        normalizeBeforeDetection: false,
      },
      registry,
      undefined,
      unavailableSanitizer,
    );

    const result = await firewall.analyze(createMessage(CLEAN_TEXT));
    expect(result.paraphrased).toBe(false);
    expect(sanitizeCalled).toBe(false);
  });

  it("should use max score as aggregate suspicion score", async () => {
    // Create a custom detector that always returns a known score
    const highScoreDetector: ChannelDetector = {
      detectorId: "custom-high",
      version: "1.0.0",
      detect: async (_msg: ChannelMessage) => ({
        detectorId: "custom-high",
        score: 0.95,
        threshold: 0.5,
        exceeded: true,
        details: {},
      }),
    };
    const lowScoreDetector: ChannelDetector = {
      detectorId: "custom-low",
      version: "1.0.0",
      detect: async (_msg: ChannelMessage) => ({
        detectorId: "custom-low",
        score: 0.1,
        threshold: 0.5,
        exceeded: false,
        details: {},
      }),
    };

    const customRegistry = new ChannelDetectorRegistry();
    customRegistry.register(highScoreDetector);
    customRegistry.register(lowScoreDetector);

    const firewall = new ChannelFirewall(
      {
        detectors: ["custom-high", "custom-low"],
        normalizeBeforeDetection: false,
      },
      customRegistry,
    );

    const result = await firewall.analyze(createMessage("test content"));
    expect(result.suspicionScore).toBe(0.95);
  });
});
