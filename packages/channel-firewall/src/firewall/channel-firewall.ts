/**
 * @fileoverview Channel firewall orchestrator for covert channel defense.
 *
 * Location: packages/channel-firewall/src/firewall/channel-firewall.ts
 *
 * This file implements the main ChannelFirewall class that orchestrates the
 * full covert channel analysis pipeline:
 *
 * 1. Optional message normalization (via SchemaMessageNormalizer)
 * 2. Parallel execution of all configured detectors
 * 3. Optional paraphrase sanitization (via ParaphraseSanitizer)
 * 4. Content hash computation (using sha256StringHex from poi-sdk-core)
 * 5. Aggregation of detector results into a single suspicion score
 * 6. Timing metadata extraction (if a timing detector was used)
 *
 * The firewall is configured with a list of detector IDs that must be registered
 * in the provided ChannelDetectorRegistry. Per-detector threshold overrides can
 * be specified in the FirewallConfig.
 *
 * Used by:
 * - Safety layer consumers who want comprehensive covert channel analysis
 * - Integration with the process-trace package via CovertChannelCustomEvent
 */

import { sha256StringHex } from "@fluxpointstudios/poi-sdk-core";

import type {
  ChannelMessage,
  DetectorResult,
  FirewallConfig,
  FirewallResult,
} from "../types.js";
import {
  ChannelFirewallError,
  ChannelFirewallException,
} from "../types.js";
import type { ChannelDetectorRegistry } from "../detectors/detector-interface.js";
import type { SchemaMessageNormalizer } from "../normalizer/schema-normalizer.js";
import type { ParaphraseSanitizer } from "../normalizer/paraphrase-sanitizer.js";
import { TimingDetector } from "../detectors/timing-detector.js";

// =============================================================================
// CHANNEL FIREWALL
// =============================================================================

/**
 * Main orchestrator for covert channel analysis.
 *
 * The ChannelFirewall runs a configurable pipeline of detectors against
 * each message and produces a comprehensive FirewallResult with individual
 * and aggregate suspicion scores.
 *
 * @example
 * ```typescript
 * import {
 *   ChannelFirewall,
 *   ChannelDetectorRegistry,
 *   StatisticalDetector,
 *   StegoDetector,
 *   SchemaMessageNormalizer,
 * } from "@fluxpointstudios/poi-sdk-channel-firewall";
 *
 * const registry = new ChannelDetectorRegistry();
 * registry.register(new StatisticalDetector());
 * registry.register(new StegoDetector());
 *
 * const firewall = new ChannelFirewall(
 *   {
 *     detectors: ["statistical", "stego"],
 *     normalizeBeforeDetection: true,
 *   },
 *   registry,
 *   new SchemaMessageNormalizer(),
 * );
 *
 * const result = await firewall.analyze({
 *   content: "Hello world",
 *   channel: "output-text",
 *   timestamp: new Date().toISOString(),
 * });
 * ```
 */
export class ChannelFirewall {
  private readonly config: FirewallConfig;
  private readonly registry: ChannelDetectorRegistry;
  private readonly normalizer: SchemaMessageNormalizer | undefined;
  private readonly sanitizer: ParaphraseSanitizer | undefined;

  /**
   * Create a new ChannelFirewall.
   *
   * @param config - Firewall configuration specifying which detectors to run
   * @param registry - Registry containing the detector instances
   * @param normalizer - Optional message normalizer
   * @param sanitizer - Optional paraphrase sanitizer
   * @throws ChannelFirewallException with DETECTOR_NOT_FOUND if any configured
   *         detector ID is not found in the registry
   */
  constructor(
    config: FirewallConfig,
    registry: ChannelDetectorRegistry,
    normalizer?: SchemaMessageNormalizer,
    sanitizer?: ParaphraseSanitizer,
  ) {
    // Validate that all configured detectors exist in the registry
    for (const detectorId of config.detectors) {
      if (!registry.has(detectorId)) {
        throw new ChannelFirewallException(
          ChannelFirewallError.DETECTOR_NOT_FOUND,
          `Detector "${detectorId}" is configured but not registered in the registry. ` +
            `Available detectors: [${registry.list().join(", ")}]`,
        );
      }
    }

    this.config = config;
    this.registry = registry;
    this.normalizer = normalizer;
    this.sanitizer = sanitizer;
  }

  /**
   * Analyze a message for covert channel indicators.
   *
   * Pipeline:
   * 1. Validate message
   * 2. Compute content hash of original message
   * 3. Optionally normalize message
   * 4. Compute content hash of normalized message (if normalized)
   * 5. Run all configured detectors in parallel
   * 6. Optionally paraphrase content
   * 7. Aggregate results
   * 8. Extract timing metadata
   *
   * @param message - The message to analyze
   * @returns Comprehensive firewall analysis result
   * @throws ChannelFirewallException with INVALID_MESSAGE if the message is malformed
   * @throws ChannelFirewallException with DETECTION_FAILED if a detector throws
   */
  async analyze(message: ChannelMessage): Promise<FirewallResult> {
    // Step 1: Validate message
    this.validateMessage(message);

    // Step 2: Compute content hash of original message
    const contentHash = await sha256StringHex(message.content);

    // Step 3: Optionally normalize message
    let analyzeMessage = message;
    let normalized = false;
    let normalizedContentHash: string | undefined;

    if (this.config.normalizeBeforeDetection && this.normalizer) {
      const schema = this.config.schemas?.find(
        (s) => s.channel === message.channel,
      );
      const normalizedMessage = this.normalizer.normalize(message, schema);
      analyzeMessage = normalizedMessage;
      normalized = true;
      normalizedContentHash = await sha256StringHex(normalizedMessage.content);
    }

    // Step 4: Run all configured detectors in parallel
    const detectorResults = await this.runDetectors(analyzeMessage);

    // Step 5: Optionally paraphrase
    let paraphrased = false;
    if (this.sanitizer && this.sanitizer.isAvailable()) {
      try {
        await this.sanitizer.sanitize(analyzeMessage.content);
        paraphrased = true;
      } catch (error) {
        // Paraphrasing is best-effort; do not fail the analysis
        // The paraphrased flag remains false
        void error;
      }
    }

    // Step 6: Aggregate suspicion scores
    const suspicionScore = this.aggregateScores(detectorResults);

    // Step 7: Extract timing metadata
    const timing = this.extractTimingInfo();

    return {
      suspicionScore,
      detectorResults,
      normalized,
      paraphrased,
      contentHash,
      ...(normalizedContentHash !== undefined ? { normalizedContentHash } : {}),
      ...(timing !== undefined ? { timing } : {}),
    } as FirewallResult;
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Validate that a message has all required fields and is well-formed.
   *
   * @param message - The message to validate
   * @throws ChannelFirewallException with INVALID_MESSAGE if invalid
   */
  private validateMessage(message: ChannelMessage): void {
    if (!message) {
      throw new ChannelFirewallException(
        ChannelFirewallError.INVALID_MESSAGE,
        "Message is null or undefined",
      );
    }

    if (typeof message.content !== "string") {
      throw new ChannelFirewallException(
        ChannelFirewallError.INVALID_MESSAGE,
        "Message content must be a string",
      );
    }

    const validChannels = new Set(["output-text", "tool-args", "tool-result"]);
    if (!validChannels.has(message.channel)) {
      throw new ChannelFirewallException(
        ChannelFirewallError.INVALID_MESSAGE,
        `Invalid channel "${message.channel}". Must be one of: output-text, tool-args, tool-result`,
      );
    }

    if (typeof message.timestamp !== "string" || message.timestamp.length === 0) {
      throw new ChannelFirewallException(
        ChannelFirewallError.INVALID_MESSAGE,
        "Message timestamp must be a non-empty string",
      );
    }
  }

  /**
   * Run all configured detectors against a message in parallel.
   *
   * @param message - The message to analyze
   * @returns Array of detector results
   * @throws ChannelFirewallException with DETECTION_FAILED if a detector throws
   */
  private async runDetectors(message: ChannelMessage): Promise<DetectorResult[]> {
    const results = await Promise.allSettled(
      this.config.detectors.map(async (detectorId) => {
        const detector = this.registry.get(detectorId);
        if (!detector) {
          throw new ChannelFirewallException(
            ChannelFirewallError.DETECTOR_NOT_FOUND,
            `Detector "${detectorId}" was removed from registry after firewall construction`,
          );
        }

        const result = await detector.detect(message);

        // Apply threshold override if configured
        const thresholdOverride = this.config.thresholds?.[detectorId];
        if (thresholdOverride !== undefined) {
          return {
            ...result,
            threshold: thresholdOverride,
            exceeded: result.score > thresholdOverride,
          };
        }

        return result;
      }),
    );

    // Collect results, throwing on any failures
    const detectorResults: DetectorResult[] = [];
    for (const result of results) {
      if (result.status === "rejected") {
        if (result.reason instanceof ChannelFirewallException) {
          throw result.reason;
        }
        throw new ChannelFirewallException(
          ChannelFirewallError.DETECTION_FAILED,
          `Detector failed: ${
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
          }`,
          result.reason instanceof Error ? result.reason : undefined,
        );
      }
      detectorResults.push(result.value);
    }

    return detectorResults;
  }

  /**
   * Aggregate individual detector scores into an overall suspicion score.
   *
   * Uses the maximum score across all detectors as the aggregate score.
   * This is a conservative approach: if any single detector is highly
   * suspicious, the overall result is suspicious.
   *
   * The max-based aggregation prevents dilution of strong signals by
   * low-scoring detectors. For example, if a stego detector finds
   * zero-width characters (score=0.9) but the statistical detector
   * sees normal text (score=0.1), the aggregate should be 0.9.
   *
   * @param results - Array of detector results
   * @returns Aggregate suspicion score in [0,1]
   */
  private aggregateScores(results: DetectorResult[]): number {
    if (results.length === 0) return 0;

    // Use maximum score as aggregate (conservative approach)
    return Math.max(...results.map((r) => r.score));
  }

  /**
   * Extract timing metadata from the timing detector, if one is configured.
   *
   * @returns Timing info object, or undefined if no timing detector is active
   */
  private extractTimingInfo():
    | { monotonicDeltaMs: number; wallClockTimestamp: string; attested: boolean }
    | undefined {
    // Look for a timing detector in the configured detectors
    for (const detectorId of this.config.detectors) {
      const detector = this.registry.get(detectorId);
      if (detector instanceof TimingDetector) {
        return detector.getLastTimingInfo();
      }
    }
    return undefined;
  }
}
