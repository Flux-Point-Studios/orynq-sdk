/**
 * @summary Main entry point for @fluxpointstudios/poi-sdk-channel-firewall package.
 *
 * This package provides covert channel defense and detection for the
 * Proof-of-Intent SDK. It analyzes messages for hidden communication channels
 * that could be used to exfiltrate data or coordinate deceptive behavior.
 *
 * Key features:
 * - Statistical character distribution analysis (chi-squared, KL divergence)
 * - Compressibility / entropy-based anomaly detection
 * - Steganographic pattern detection (zero-width chars, homoglyphs)
 * - Timing covert channel detection (bimodal delays, periodicity)
 * - Schema-based message normalization (JSON ordering, whitespace, casing)
 * - Paraphrase sanitizer interface for LLM-based defense
 * - Pluggable detector registry for custom detectors
 *
 * Usage:
 * ```typescript
 * import {
 *   ChannelFirewall,
 *   ChannelDetectorRegistry,
 *   StatisticalDetector,
 *   StegoDetector,
 *   CompressibilityDetector,
 *   TimingDetector,
 *   SchemaMessageNormalizer,
 * } from "@fluxpointstudios/poi-sdk-channel-firewall";
 *
 * const registry = new ChannelDetectorRegistry();
 * registry.register(new StatisticalDetector());
 * registry.register(new StegoDetector());
 * registry.register(new CompressibilityDetector());
 * registry.register(new TimingDetector());
 *
 * const firewall = new ChannelFirewall(
 *   {
 *     detectors: ["statistical", "stego", "compressibility", "timing"],
 *     normalizeBeforeDetection: true,
 *   },
 *   registry,
 *   new SchemaMessageNormalizer(),
 * );
 *
 * const result = await firewall.analyze({
 *   content: "Agent response text here...",
 *   channel: "output-text",
 *   timestamp: new Date().toISOString(),
 * });
 * ```
 */

// ---------------------------------------------------------------------------
// Type Exports
// ---------------------------------------------------------------------------

export type {
  ChannelType,
  ChannelMessage,
  ChannelDetector,
  DetectorResult,
  NormalizationRuleType,
  NormalizationRule,
  MessageSchema,
  NormalizedMessage,
  FirewallConfig,
  FirewallResult,
} from "./types.js";

export {
  ChannelFirewallError,
  ChannelFirewallException,
} from "./types.js";

// ---------------------------------------------------------------------------
// Detector Exports
// ---------------------------------------------------------------------------

export {
  ChannelDetectorRegistry,
  channelDetectorRegistry,
} from "./detectors/detector-interface.js";

export { StatisticalDetector } from "./detectors/statistical-detector.js";
export { CompressibilityDetector } from "./detectors/compressibility.js";
export { StegoDetector } from "./detectors/stego-detector.js";
export { TimingDetector } from "./detectors/timing-detector.js";

// ---------------------------------------------------------------------------
// Normalizer Exports
// ---------------------------------------------------------------------------

export { SchemaMessageNormalizer } from "./normalizer/schema-normalizer.js";
export type { ParaphraseSanitizer } from "./normalizer/paraphrase-sanitizer.js";

// ---------------------------------------------------------------------------
// Firewall Exports
// ---------------------------------------------------------------------------

export { ChannelFirewall } from "./firewall/channel-firewall.js";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Package version.
 * Updated automatically during build.
 */
export const VERSION = "0.1.0";
