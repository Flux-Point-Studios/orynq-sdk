/**
 * @fileoverview Timing-based covert channel detector.
 *
 * Location: packages/channel-firewall/src/detectors/timing-detector.ts
 *
 * This detector analyzes message-level timing patterns to identify potential
 * timing covert channels. Timing channels encode information in the inter-message
 * delays rather than in message content, making them harder to detect with
 * content-based approaches alone.
 *
 * Detection strategies:
 * 1. Bimodal delay distribution: If delays cluster into two groups (e.g., short
 *    and long), it may indicate binary encoding via timing.
 * 2. Periodic timing patterns: Regular periodic delays suggest structured encoding.
 * 3. Unusual delay statistics: Abnormally low variance or non-natural delay
 *    distributions (natural human/AI timing has specific statistical properties).
 *
 * The detector maintains a history of message timestamps and computes timing
 * statistics over the accumulated history.
 *
 * The `attested` field indicates whether timing was captured inside a Trusted
 * Execution Environment (TEE). When running outside a TEE, monotonic deltas
 * are still valuable for analysis but are explicitly marked as unattested.
 *
 * Used by:
 * - ChannelFirewall as one of the standard detector plugins
 * - Registered in the channelDetectorRegistry with ID "timing"
 */

import type { ChannelDetector, ChannelMessage, DetectorResult } from "../types.js";

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Default suspicion threshold for the timing detector.
 */
const DEFAULT_THRESHOLD = 0.5;

/**
 * Minimum number of messages needed for meaningful timing analysis.
 */
const MIN_MESSAGES_FOR_ANALYSIS = 3;

/**
 * Maximum number of historical timestamps to retain.
 * Prevents unbounded memory growth for long-running sessions.
 */
const MAX_HISTORY_SIZE = 1000;

// =============================================================================
// TIMING DETECTOR
// =============================================================================

/**
 * Detects covert channels encoded in message timing patterns.
 *
 * This detector accumulates message timestamps and analyzes the inter-message
 * delay distribution for patterns that suggest intentional timing modulation.
 *
 * @example
 * ```typescript
 * const detector = new TimingDetector();
 *
 * // Analyze multiple messages over time
 * for (const message of messages) {
 *   const result = await detector.detect(message);
 *   if (result.exceeded) {
 *     console.warn("Suspicious timing pattern detected");
 *   }
 * }
 * ```
 */
export class TimingDetector implements ChannelDetector {
  readonly detectorId = "timing";
  readonly version = "1.0.0";

  private readonly threshold: number;

  /**
   * Whether timing measurements are captured inside a TEE attested boundary.
   * Defaults to false; set to true when running in a verified TEE.
   */
  readonly attested: boolean;

  /**
   * History of monotonic timestamps (performance.now() values) for delay computation.
   */
  private readonly monotonicHistory: number[] = [];

  /**
   * History of wall-clock timestamps from messages.
   */
  private readonly wallClockHistory: string[] = [];

  constructor(options: { threshold?: number; attested?: boolean } = {}) {
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.attested = options.attested ?? false;
  }

  /**
   * Analyze a message's timing in the context of previous messages.
   *
   * @param message - The message to analyze (timestamp is used for timing)
   * @returns Detection result with timing analysis details
   */
  async detect(message: ChannelMessage): Promise<DetectorResult> {
    const now = performance.now();

    // Record this message in history
    this.monotonicHistory.push(now);
    this.wallClockHistory.push(message.timestamp);

    // Trim history if it exceeds maximum size
    if (this.monotonicHistory.length > MAX_HISTORY_SIZE) {
      this.monotonicHistory.splice(0, this.monotonicHistory.length - MAX_HISTORY_SIZE);
      this.wallClockHistory.splice(0, this.wallClockHistory.length - MAX_HISTORY_SIZE);
    }

    // Compute monotonic delta to previous message (or 0 if first message)
    const monotonicDeltaMs =
      this.monotonicHistory.length >= 2
        ? now - this.monotonicHistory[this.monotonicHistory.length - 2]!
        : 0;

    // Not enough history for meaningful analysis
    if (this.monotonicHistory.length < MIN_MESSAGES_FOR_ANALYSIS) {
      return {
        detectorId: this.detectorId,
        score: 0,
        threshold: this.threshold,
        exceeded: false,
        details: {
          reason: "insufficient-history",
          messageCount: this.monotonicHistory.length,
          minimumRequired: MIN_MESSAGES_FOR_ANALYSIS,
          monotonicDeltaMs,
          wallClockTimestamp: message.timestamp,
          attested: this.attested,
        },
      };
    }

    // Compute inter-message delays
    const delays = this.computeDelays();

    // Analyze for bimodal distribution (binary encoding)
    const bimodalScore = this.analyzeBimodality(delays);

    // Analyze for periodic patterns
    const periodicScore = this.analyzePeriodicPatterns(delays);

    // Analyze delay variance (very low variance = suspicious)
    const varianceScore = this.analyzeVariance(delays);

    // Weighted combination
    const score = Math.min(
      1,
      0.40 * bimodalScore + 0.35 * periodicScore + 0.25 * varianceScore,
    );

    return {
      detectorId: this.detectorId,
      score,
      threshold: this.threshold,
      exceeded: score > this.threshold,
      details: {
        monotonicDeltaMs,
        wallClockTimestamp: message.timestamp,
        attested: this.attested,
        messageCount: this.monotonicHistory.length,
        delayCount: delays.length,
        delayStats: this.computeDelayStats(delays),
        bimodalScore,
        periodicScore,
        varianceScore,
      },
    };
  }

  /**
   * Reset the timing history. Useful when starting a new session.
   */
  resetHistory(): void {
    this.monotonicHistory.length = 0;
    this.wallClockHistory.length = 0;
  }

  /**
   * Get the current monotonic delta and wall clock timestamp for the last message.
   * Useful for embedding timing metadata in FirewallResult.
   */
  getLastTimingInfo(): { monotonicDeltaMs: number; wallClockTimestamp: string; attested: boolean } | undefined {
    if (this.monotonicHistory.length < 1) return undefined;

    const monotonicDeltaMs =
      this.monotonicHistory.length >= 2
        ? this.monotonicHistory[this.monotonicHistory.length - 1]! -
          this.monotonicHistory[this.monotonicHistory.length - 2]!
        : 0;

    return {
      monotonicDeltaMs,
      wallClockTimestamp: this.wallClockHistory[this.wallClockHistory.length - 1]!,
      attested: this.attested,
    };
  }

  // ---------------------------------------------------------------------------
  // Private Analysis Methods
  // ---------------------------------------------------------------------------

  /**
   * Compute inter-message delays from the monotonic history.
   *
   * @returns Array of delay values in milliseconds
   */
  private computeDelays(): number[] {
    const delays: number[] = [];
    for (let i = 1; i < this.monotonicHistory.length; i++) {
      delays.push(this.monotonicHistory[i]! - this.monotonicHistory[i - 1]!);
    }
    return delays;
  }

  /**
   * Analyze whether the delay distribution is bimodal (two clusters).
   * Bimodal delays suggest binary encoding: short delay = 0, long delay = 1.
   *
   * Uses a simplified approach: compute the Hartigan dip statistic proxy
   * by comparing the histogram of delays against a unimodal distribution.
   *
   * @param delays - Array of inter-message delays
   * @returns Score [0,1] where higher = more bimodal
   */
  private analyzeBimodality(delays: number[]): number {
    if (delays.length < 4) return 0;

    // Sort delays and compute median
    const sorted = [...delays].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;

    // Split into two groups around the median
    const below = sorted.filter((d) => d < median);
    const above = sorted.filter((d) => d >= median);

    if (below.length === 0 || above.length === 0) return 0;

    // Compute means of each group
    const meanBelow = below.reduce((s, d) => s + d, 0) / below.length;
    const meanAbove = above.reduce((s, d) => s + d, 0) / above.length;

    // Compute overall standard deviation
    const overallMean = delays.reduce((s, d) => s + d, 0) / delays.length;
    const overallVariance =
      delays.reduce((s, d) => s + (d - overallMean) ** 2, 0) / delays.length;
    const overallStd = Math.sqrt(overallVariance);

    if (overallStd === 0) return 0;

    // Bimodality coefficient: how separated are the two group means
    // relative to the overall spread?
    const separation = Math.abs(meanAbove - meanBelow) / overallStd;

    // Compute variance within each group
    const varBelow =
      below.length > 1
        ? below.reduce((s, d) => s + (d - meanBelow) ** 2, 0) / below.length
        : 0;
    const varAbove =
      above.length > 1
        ? above.reduce((s, d) => s + (d - meanAbove) ** 2, 0) / above.length
        : 0;

    // If within-group variance is much smaller than between-group variance,
    // the distribution is more clearly bimodal
    const withinGroupVar = (varBelow + varAbove) / 2;
    const betweenGroupVar = ((meanAbove - meanBelow) ** 2) / 4;

    const fRatio = withinGroupVar > 0 ? betweenGroupVar / withinGroupVar : 0;

    // Normalize: separation > 2 std devs and high F-ratio -> very bimodal
    const separationScore = Math.min(1, separation / 3);
    const fRatioScore = Math.min(1, fRatio / 10);

    return 0.5 * separationScore + 0.5 * fRatioScore;
  }

  /**
   * Analyze for periodic patterns in the delay sequence.
   * Periodic timing suggests structured encoding or clock-based channels.
   *
   * Uses autocorrelation to detect repeating patterns.
   *
   * @param delays - Array of inter-message delays
   * @returns Score [0,1] where higher = more periodic
   */
  private analyzePeriodicPatterns(delays: number[]): number {
    if (delays.length < 6) return 0;

    const mean = delays.reduce((s, d) => s + d, 0) / delays.length;
    const variance =
      delays.reduce((s, d) => s + (d - mean) ** 2, 0) / delays.length;

    if (variance === 0) return 0;

    // Compute autocorrelation for lags 1 through floor(n/2)
    const maxLag = Math.min(Math.floor(delays.length / 2), 20);
    let maxAutoCorr = 0;

    for (let lag = 1; lag <= maxLag; lag++) {
      let autoCorr = 0;
      let count = 0;
      for (let i = 0; i < delays.length - lag; i++) {
        autoCorr += (delays[i]! - mean) * (delays[i + lag]! - mean);
        count++;
      }

      if (count > 0) {
        autoCorr = autoCorr / (count * variance);
        maxAutoCorr = Math.max(maxAutoCorr, Math.abs(autoCorr));
      }
    }

    // High autocorrelation at any lag suggests periodicity
    // Autocorrelation > 0.5 is very suspicious for timing data
    return Math.min(1, maxAutoCorr / 0.7);
  }

  /**
   * Analyze the variance of delays.
   * Unusually low variance (very regular timing) is suspicious because
   * natural message timing has inherent variability.
   *
   * @param delays - Array of inter-message delays
   * @returns Score [0,1] where higher = more suspicious variance
   */
  private analyzeVariance(delays: number[]): number {
    if (delays.length < 3) return 0;

    const mean = delays.reduce((s, d) => s + d, 0) / delays.length;
    if (mean === 0) return 0;

    const variance =
      delays.reduce((s, d) => s + (d - mean) ** 2, 0) / delays.length;
    const std = Math.sqrt(variance);

    // Coefficient of variation: std / mean
    // Natural timing typically has CV > 0.3
    // Very low CV (< 0.1) suggests artificially regular timing
    const cv = std / mean;

    if (cv < 0.05) return 1.0; // Extremely regular: near-certain timing channel
    if (cv < 0.1) return 0.7;
    if (cv < 0.2) return 0.3;
    return 0;
  }

  /**
   * Compute basic statistics over delay values.
   *
   * @param delays - Array of inter-message delays
   * @returns Object with mean, std, min, max, median
   */
  private computeDelayStats(delays: number[]): Record<string, number> {
    if (delays.length === 0) {
      return { mean: 0, std: 0, min: 0, max: 0, median: 0, cv: 0 };
    }

    const sorted = [...delays].sort((a, b) => a - b);
    const mean = delays.reduce((s, d) => s + d, 0) / delays.length;
    const variance =
      delays.reduce((s, d) => s + (d - mean) ** 2, 0) / delays.length;
    const std = Math.sqrt(variance);

    return {
      mean,
      std,
      min: sorted[0]!,
      max: sorted[sorted.length - 1]!,
      median: sorted[Math.floor(sorted.length / 2)]!,
      cv: mean > 0 ? std / mean : 0,
    };
  }
}
