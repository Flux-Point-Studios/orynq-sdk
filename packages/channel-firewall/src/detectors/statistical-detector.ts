/**
 * @fileoverview Statistical covert channel detector.
 *
 * Location: packages/channel-firewall/src/detectors/statistical-detector.ts
 *
 * This detector analyzes character/token distribution in messages for statistical
 * anomalies that may indicate covert channel encoding. It uses two complementary
 * approaches:
 *
 * 1. Chi-squared test: Compares observed character frequency distribution against
 *    an expected distribution for natural English text. High chi-squared values
 *    indicate the text deviates significantly from natural language.
 *
 * 2. KL divergence: Measures information-theoretic divergence between observed
 *    and expected distributions. Higher divergence suggests encoded content.
 *
 * The final score is a weighted combination of both measures, normalized to [0,1].
 *
 * Used by:
 * - ChannelFirewall as one of the standard detector plugins
 * - Registered in the channelDetectorRegistry with ID "statistical"
 */

import type { ChannelDetector, ChannelMessage, DetectorResult } from "../types.js";

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Default suspicion threshold for the statistical detector.
 * Scores above this value are considered suspicious.
 */
const DEFAULT_THRESHOLD = 0.7;

/**
 * Expected character frequency distribution for natural English text.
 * Frequencies are approximate proportions based on large corpus analysis.
 * Includes space as the most common "character" in natural text.
 */
const ENGLISH_CHAR_FREQUENCIES: Record<string, number> = {
  " ": 0.1831,
  e: 0.1027,
  t: 0.0752,
  a: 0.0653,
  o: 0.0616,
  n: 0.0571,
  i: 0.0567,
  s: 0.0508,
  r: 0.0499,
  h: 0.0498,
  l: 0.0332,
  d: 0.0328,
  c: 0.0223,
  u: 0.0228,
  m: 0.0203,
  f: 0.0198,
  p: 0.0153,
  g: 0.0162,
  w: 0.0153,
  y: 0.0143,
  b: 0.0125,
  v: 0.0080,
  k: 0.0056,
  x: 0.0014,
  j: 0.0010,
  q: 0.0008,
  z: 0.0005,
};

/**
 * Sum of known character frequencies.
 * The remainder is allocated to "other" characters (punctuation, digits, etc.).
 */
const KNOWN_FREQ_SUM = Object.values(ENGLISH_CHAR_FREQUENCIES).reduce(
  (sum, freq) => sum + freq,
  0,
);

/**
 * Expected frequency for characters not in the English frequency table.
 * This covers punctuation, digits, and other characters.
 */
const OTHER_CHAR_FREQUENCY = 1.0 - KNOWN_FREQ_SUM;

// =============================================================================
// STATISTICAL DETECTOR
// =============================================================================

/**
 * Detects covert channels by analyzing character distribution anomalies.
 *
 * Natural language follows predictable character frequency distributions.
 * Encoded data (steganographic payloads, encrypted data, base64, etc.)
 * typically has a much flatter or more uniform distribution.
 *
 * @example
 * ```typescript
 * const detector = new StatisticalDetector();
 * const result = await detector.detect({
 *   content: "Hello world, this is normal text.",
 *   channel: "output-text",
 *   timestamp: new Date().toISOString(),
 * });
 * // result.score will be low for natural text
 * ```
 */
export class StatisticalDetector implements ChannelDetector {
  readonly detectorId = "statistical";
  readonly version = "1.0.0";

  private readonly threshold: number;

  constructor(threshold: number = DEFAULT_THRESHOLD) {
    this.threshold = threshold;
  }

  /**
   * Analyze a message for statistical character distribution anomalies.
   *
   * @param message - The message to analyze
   * @returns Detection result with chi-squared and KL divergence details
   */
  async detect(message: ChannelMessage): Promise<DetectorResult> {
    const { content } = message;

    // Empty or very short messages are not analyzable
    if (content.length < 10) {
      return {
        detectorId: this.detectorId,
        score: 0,
        threshold: this.threshold,
        exceeded: false,
        details: {
          reason: "content-too-short",
          contentLength: content.length,
          minimumLength: 10,
        },
      };
    }

    const lowerContent = content.toLowerCase();
    const observedFreqs = this.computeCharFrequencies(lowerContent);
    const chiSquared = this.computeChiSquared(observedFreqs, lowerContent.length);
    const klDivergence = this.computeKLDivergence(observedFreqs);

    // Normalize chi-squared to [0,1] using a sigmoid-like function.
    // A chi-squared value of ~50 for 27 degrees of freedom corresponds to
    // p < 0.005, indicating strong deviation from expected distribution.
    const chiSquaredNormalized = 1 - 1 / (1 + chiSquared / 50);

    // Normalize KL divergence to [0,1] using a similar approach.
    // KL divergence of ~2 bits is quite high for character distributions.
    const klNormalized = 1 - 1 / (1 + klDivergence / 2);

    // Weighted combination: chi-squared is more robust, KL captures information content
    const score = Math.min(1, 0.6 * chiSquaredNormalized + 0.4 * klNormalized);

    return {
      detectorId: this.detectorId,
      score,
      threshold: this.threshold,
      exceeded: score > this.threshold,
      details: {
        chiSquared,
        chiSquaredNormalized,
        klDivergence,
        klNormalized,
        contentLength: content.length,
        uniqueChars: new Set(lowerContent).size,
      },
    };
  }

  /**
   * Compute character frequency map from text.
   *
   * @param text - Lowercased text to analyze
   * @returns Map of character to observed proportion
   */
  private computeCharFrequencies(text: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const char of text) {
      counts.set(char, (counts.get(char) ?? 0) + 1);
    }

    const freqs = new Map<string, number>();
    for (const [char, count] of counts) {
      freqs.set(char, count / text.length);
    }
    return freqs;
  }

  /**
   * Compute chi-squared statistic comparing observed vs expected frequencies.
   *
   * chi^2 = sum((observed - expected)^2 / expected) for each character category.
   *
   * @param observedFreqs - Observed character frequency map
   * @param totalChars - Total number of characters in the text
   * @returns Chi-squared statistic
   */
  private computeChiSquared(
    observedFreqs: Map<string, number>,
    totalChars: number,
  ): number {
    let chiSquared = 0;

    // Test each expected character
    for (const [char, expectedFreq] of Object.entries(ENGLISH_CHAR_FREQUENCIES)) {
      const observedFreq = observedFreqs.get(char) ?? 0;
      const expected = expectedFreq * totalChars;
      const observed = observedFreq * totalChars;

      if (expected > 0) {
        chiSquared += ((observed - expected) ** 2) / expected;
      }
    }

    // Test "other" characters (everything not in the expected table)
    let otherObserved = 0;
    for (const [char, freq] of observedFreqs) {
      if (!(char in ENGLISH_CHAR_FREQUENCIES)) {
        otherObserved += freq;
      }
    }
    const otherExpected = OTHER_CHAR_FREQUENCY * totalChars;
    const otherObs = otherObserved * totalChars;
    if (otherExpected > 0) {
      chiSquared += ((otherObs - otherExpected) ** 2) / otherExpected;
    }

    return chiSquared;
  }

  /**
   * Compute KL divergence D(observed || expected).
   *
   * KL(P || Q) = sum(P(x) * log2(P(x) / Q(x))) for each character category.
   *
   * Uses a small epsilon to avoid log(0) and division by zero.
   *
   * @param observedFreqs - Observed character frequency map
   * @returns KL divergence in bits
   */
  private computeKLDivergence(observedFreqs: Map<string, number>): number {
    const epsilon = 1e-10;
    let kl = 0;

    // For each observed character, compute divergence from expected
    for (const [char, observedFreq] of observedFreqs) {
      if (observedFreq <= 0) continue;

      const expectedFreq =
        ENGLISH_CHAR_FREQUENCIES[char] ??
        // Distribute "other" frequency across the number of unique non-English chars
        Math.max(epsilon, OTHER_CHAR_FREQUENCY / Math.max(1, this.countOtherChars(observedFreqs)));

      kl += observedFreq * Math.log2(observedFreq / Math.max(epsilon, expectedFreq));
    }

    return Math.max(0, kl);
  }

  /**
   * Count the number of unique characters not present in the expected frequency table.
   *
   * @param observedFreqs - Observed character frequency map
   * @returns Count of "other" characters
   */
  private countOtherChars(observedFreqs: Map<string, number>): number {
    let count = 0;
    for (const char of observedFreqs.keys()) {
      if (!(char in ENGLISH_CHAR_FREQUENCIES)) {
        count++;
      }
    }
    return count;
  }
}
