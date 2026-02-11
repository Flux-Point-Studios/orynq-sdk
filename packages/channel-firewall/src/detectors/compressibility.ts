/**
 * @fileoverview Compressibility-based covert channel detector.
 *
 * Location: packages/channel-firewall/src/detectors/compressibility.ts
 *
 * This detector estimates the compressibility of message content and compares
 * it against the expected compressibility of natural language text. The key
 * insight is:
 *
 * - Natural language has moderate redundancy (compressibility ~0.4-0.6)
 * - Encrypted/random data has very low redundancy (compressibility ~0.0-0.1)
 * - Base64 or structured encoded data may have unusually high or low redundancy
 *
 * Since native zlib/deflate is not available in all JavaScript runtimes without
 * dependencies, this detector uses byte-level entropy estimation as a proxy for
 * compressibility. Shannon entropy directly correlates with compression ratio.
 *
 * A message whose entropy deviates significantly from natural language norms
 * receives a higher suspicion score.
 *
 * Used by:
 * - ChannelFirewall as one of the standard detector plugins
 * - Registered in the channelDetectorRegistry with ID "compressibility"
 */

import type { ChannelDetector, ChannelMessage, DetectorResult } from "../types.js";

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Default suspicion threshold for the compressibility detector.
 */
const DEFAULT_THRESHOLD = 0.6;

/**
 * Expected Shannon entropy range for natural English text (in bits per character).
 * Natural English typically has entropy between 3.5 and 5.0 bits/char depending
 * on vocabulary, punctuation usage, and formatting.
 */
const EXPECTED_ENTROPY_MIN = 3.5;
const EXPECTED_ENTROPY_MAX = 5.0;

/**
 * Maximum possible entropy for character-level analysis of printable ASCII + common Unicode.
 * We use a practical upper bound.
 */
const MAX_CHAR_ENTROPY = 8.0;

// =============================================================================
// COMPRESSIBILITY DETECTOR
// =============================================================================

/**
 * Detects covert channels by analyzing message compressibility via entropy estimation.
 *
 * Messages with entropy significantly outside the natural language range are
 * flagged as suspicious. Very high entropy suggests encrypted/random data;
 * very low entropy suggests highly repetitive encoded patterns.
 *
 * @example
 * ```typescript
 * const detector = new CompressibilityDetector();
 * const result = await detector.detect({
 *   content: "Normal conversational text about everyday topics.",
 *   channel: "output-text",
 *   timestamp: new Date().toISOString(),
 * });
 * // result.score will be low for natural text
 * ```
 */
export class CompressibilityDetector implements ChannelDetector {
  readonly detectorId = "compressibility";
  readonly version = "1.0.0";

  private readonly threshold: number;

  constructor(threshold: number = DEFAULT_THRESHOLD) {
    this.threshold = threshold;
  }

  /**
   * Analyze a message for compressibility anomalies.
   *
   * @param message - The message to analyze
   * @returns Detection result with entropy and compressibility details
   */
  async detect(message: ChannelMessage): Promise<DetectorResult> {
    const { content } = message;

    // Too-short messages cannot yield meaningful entropy estimates
    if (content.length < 20) {
      return {
        detectorId: this.detectorId,
        score: 0,
        threshold: this.threshold,
        exceeded: false,
        details: {
          reason: "content-too-short",
          contentLength: content.length,
          minimumLength: 20,
        },
      };
    }

    // Compute character-level Shannon entropy
    const charEntropy = this.computeCharEntropy(content);

    // Compute byte-level Shannon entropy (captures multi-byte unicode patterns)
    const byteEntropy = this.computeByteEntropy(content);

    // Compute unique character ratio (another redundancy signal)
    const uniqueRatio = new Set(content).size / content.length;

    // Compute bigram entropy (captures local structure)
    const bigramEntropy = this.computeBigramEntropy(content);

    // Score based on deviation from expected entropy range
    const charEntropyScore = this.computeEntropyDeviationScore(charEntropy);
    const byteEntropyScore = this.computeEntropyDeviationScore(byteEntropy);

    // Bigram entropy deviation: natural language has moderate bigram entropy (~6-10 bits)
    // Random data approaches max bigram entropy; encoded data may be unusually low or high
    const bigramScore = bigramEntropy > 12 ? 0.3 : bigramEntropy < 3 ? 0.4 : 0;

    // Unique character ratio: extremely high suggests random data, extremely low
    // suggests repetitive encoding. Natural text is typically 0.15-0.50.
    const uniqueRatioScore =
      uniqueRatio > 0.7 ? (uniqueRatio - 0.7) / 0.3 :
      uniqueRatio < 0.05 ? (0.05 - uniqueRatio) / 0.05 :
      0;

    // Weighted combination of signals
    const score = Math.min(
      1,
      0.35 * charEntropyScore +
      0.25 * byteEntropyScore +
      0.20 * bigramScore +
      0.20 * uniqueRatioScore,
    );

    return {
      detectorId: this.detectorId,
      score,
      threshold: this.threshold,
      exceeded: score > this.threshold,
      details: {
        charEntropy,
        byteEntropy,
        bigramEntropy,
        uniqueCharRatio: uniqueRatio,
        expectedEntropyRange: [EXPECTED_ENTROPY_MIN, EXPECTED_ENTROPY_MAX],
        charEntropyScore,
        byteEntropyScore,
        bigramScore,
        uniqueRatioScore,
        contentLength: content.length,
      },
    };
  }

  /**
   * Compute Shannon entropy at the character level.
   *
   * H = -sum(p(x) * log2(p(x))) for each unique character x.
   *
   * @param text - Text to analyze
   * @returns Entropy in bits per character
   */
  private computeCharEntropy(text: string): number {
    const counts = new Map<string, number>();
    for (const char of text) {
      counts.set(char, (counts.get(char) ?? 0) + 1);
    }

    let entropy = 0;
    for (const count of counts.values()) {
      const p = count / text.length;
      if (p > 0) {
        entropy -= p * Math.log2(p);
      }
    }

    return entropy;
  }

  /**
   * Compute Shannon entropy at the byte level.
   * Captures multi-byte Unicode encoding patterns.
   *
   * @param text - Text to analyze
   * @returns Entropy in bits per byte
   */
  private computeByteEntropy(text: string): number {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(text);

    const counts = new Uint32Array(256);
    for (const byte of bytes) {
      counts[byte] = (counts[byte] ?? 0) + 1;
    }

    let entropy = 0;
    for (const count of counts) {
      if (count > 0) {
        const p = count / bytes.length;
        entropy -= p * Math.log2(p);
      }
    }

    return entropy;
  }

  /**
   * Compute Shannon entropy over character bigrams (two-character sequences).
   * Captures local structural patterns in the text.
   *
   * @param text - Text to analyze
   * @returns Bigram entropy in bits per bigram
   */
  private computeBigramEntropy(text: string): number {
    if (text.length < 2) return 0;

    const counts = new Map<string, number>();
    const totalBigrams = text.length - 1;

    for (let i = 0; i < totalBigrams; i++) {
      const bigram = text.slice(i, i + 2);
      counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
    }

    let entropy = 0;
    for (const count of counts.values()) {
      const p = count / totalBigrams;
      if (p > 0) {
        entropy -= p * Math.log2(p);
      }
    }

    return entropy;
  }

  /**
   * Compute a deviation score [0,1] based on how far entropy is from the expected range.
   *
   * @param entropy - Observed entropy in bits
   * @returns Score in [0,1] where 0 = within expected range, 1 = maximal deviation
   */
  private computeEntropyDeviationScore(entropy: number): number {
    if (entropy >= EXPECTED_ENTROPY_MIN && entropy <= EXPECTED_ENTROPY_MAX) {
      return 0;
    }

    if (entropy < EXPECTED_ENTROPY_MIN) {
      // Below range: lower entropy = more suspicious (highly repetitive)
      return Math.min(1, (EXPECTED_ENTROPY_MIN - entropy) / EXPECTED_ENTROPY_MIN);
    }

    // Above range: higher entropy = more suspicious (random/encrypted data)
    return Math.min(
      1,
      (entropy - EXPECTED_ENTROPY_MAX) / (MAX_CHAR_ENTROPY - EXPECTED_ENTROPY_MAX),
    );
  }
}
