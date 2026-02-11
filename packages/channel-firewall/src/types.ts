/**
 * @fileoverview Type definitions for the channel-firewall package.
 *
 * Location: packages/channel-firewall/src/types.ts
 *
 * This file defines all interfaces, enums, and error types used by the
 * channel-firewall package. It provides the foundational type system for
 * covert channel detection including detector interfaces, message schemas,
 * normalization rules, firewall configuration, and result types.
 *
 * Error codes are in the 7200-7299 range, allocated to this package.
 *
 * Used by:
 * - All detector implementations (statistical, compressibility, stego, timing)
 * - Schema normalizer and paraphrase sanitizer
 * - ChannelFirewall orchestrator
 * - Consumers of the @fluxpointstudios/poi-sdk-channel-firewall package
 */

// =============================================================================
// ERROR CODES (7200-7299)
// =============================================================================

/**
 * Error codes specific to the channel-firewall package.
 * Range: 7200-7299
 */
export enum ChannelFirewallError {
  /** A requested detector was not found in the registry */
  DETECTOR_NOT_FOUND = 7200,

  /** Failed to register a detector (e.g., duplicate ID) */
  DETECTOR_REGISTRATION_FAILED = 7201,

  /** A detector threw an error during detection */
  DETECTION_FAILED = 7202,

  /** Message normalization failed */
  NORMALIZATION_FAILED = 7203,

  /** Paraphrase sanitization failed */
  SANITIZATION_FAILED = 7204,

  /** The provided message is invalid or malformed */
  INVALID_MESSAGE = 7205,

  /** The provided schema is invalid */
  INVALID_SCHEMA = 7206,

  /** The firewall was used before initialization */
  FIREWALL_NOT_INITIALIZED = 7207,
}

// =============================================================================
// EXCEPTIONS
// =============================================================================

/**
 * Exception class for channel-firewall errors.
 * Includes a numeric error code from ChannelFirewallError for programmatic handling.
 */
export class ChannelFirewallException extends Error {
  constructor(
    public readonly code: ChannelFirewallError,
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "ChannelFirewallException";
  }
}

// =============================================================================
// CHANNEL TYPES
// =============================================================================

/**
 * The communication channel a message was observed on.
 * - "output-text": Model text output
 * - "tool-args": Arguments passed to a tool call
 * - "tool-result": Result returned from a tool call
 */
export type ChannelType = "output-text" | "tool-args" | "tool-result";

// =============================================================================
// MESSAGE TYPES
// =============================================================================

/**
 * A message observed on a communication channel, subject to covert channel analysis.
 */
export interface ChannelMessage {
  /** The text content of the message */
  readonly content: string;

  /** The channel this message was observed on */
  readonly channel: ChannelType;

  /** ISO-8601 timestamp of when the message was captured */
  readonly timestamp: string;

  /** Optional metadata associated with the message */
  readonly metadata?: Record<string, unknown>;
}

// =============================================================================
// DETECTOR TYPES
// =============================================================================

/**
 * Interface for covert channel detectors.
 *
 * Each detector analyzes a ChannelMessage for a specific class of covert channel
 * (e.g., steganography, statistical anomalies, timing patterns) and returns
 * a DetectorResult with a suspicion score.
 */
export interface ChannelDetector {
  /** Unique identifier for this detector */
  readonly detectorId: string;

  /** Semantic version of the detector implementation */
  readonly version: string;

  /**
   * Analyze a message for covert channel indicators.
   *
   * @param message - The message to analyze
   * @returns Detection result with score and details
   */
  detect(message: ChannelMessage): Promise<DetectorResult>;
}

/**
 * Result from a single detector's analysis of a message.
 */
export interface DetectorResult {
  /** The detector that produced this result */
  readonly detectorId: string;

  /** Suspicion score in [0, 1] where 0 = clean, 1 = definitely covert */
  readonly score: number;

  /** The threshold above which this detector considers a message suspicious */
  readonly threshold: number;

  /** Whether the score exceeded the threshold */
  readonly exceeded: boolean;

  /** Detector-specific details about the analysis */
  readonly details: Record<string, unknown>;
}

// =============================================================================
// NORMALIZATION TYPES
// =============================================================================

/**
 * Type of normalization rule to apply to a message.
 */
export type NormalizationRuleType =
  | "json-field-ordering"
  | "header-casing"
  | "whitespace"
  | "value-canonicalization";

/**
 * A single normalization rule to apply to a message.
 */
export interface NormalizationRule {
  /** The type of normalization to apply */
  readonly type: NormalizationRuleType;

  /** Optional configuration for the normalization rule */
  readonly config?: Record<string, unknown>;
}

/**
 * Schema defining normalization rules for a specific channel.
 */
export interface MessageSchema {
  /** The channel this schema applies to */
  readonly channel: ChannelType;

  /** The normalization rules to apply, in order */
  readonly rules: NormalizationRule[];
}

/**
 * A message after normalization has been applied.
 * Extends ChannelMessage with normalization metadata.
 */
export interface NormalizedMessage extends ChannelMessage {
  /** Whether this message has been normalized */
  readonly normalized: true;

  /** The original content before normalization */
  readonly originalContent: string;

  /** Which normalization rules were applied */
  readonly appliedRules: NormalizationRuleType[];
}

// =============================================================================
// FIREWALL CONFIGURATION
// =============================================================================

/**
 * Configuration for the ChannelFirewall.
 */
export interface FirewallConfig {
  /** List of detector IDs to run (must be registered in the detector registry) */
  readonly detectors: string[];

  /** Whether to normalize messages before running detectors */
  readonly normalizeBeforeDetection: boolean;

  /** Optional per-channel normalization schemas */
  readonly schemas?: MessageSchema[];

  /** Optional per-detector threshold overrides (detectorId -> threshold) */
  readonly thresholds?: Record<string, number>;
}

// =============================================================================
// FIREWALL RESULT
// =============================================================================

/**
 * Comprehensive result from the ChannelFirewall's analysis of a message.
 */
export interface FirewallResult {
  /** Aggregate suspicion score across all detectors [0, 1] */
  readonly suspicionScore: number;

  /** Individual results from each detector */
  readonly detectorResults: DetectorResult[];

  /** Whether normalization was applied */
  readonly normalized: boolean;

  /** Whether paraphrase sanitization was applied */
  readonly paraphrased: boolean;

  /** SHA-256 hex hash of the original message content */
  readonly contentHash: string;

  /** SHA-256 hex hash of the normalized content (if normalization was applied) */
  readonly normalizedContentHash?: string;

  /** Timing metadata (if a timing detector was used) */
  readonly timing?: {
    /** Monotonic clock delta in milliseconds (relative timing) */
    readonly monotonicDeltaMs: number;

    /** ISO-8601 wall clock timestamp */
    readonly wallClockTimestamp: string;

    /** Whether this timing was captured inside a TEE attested boundary */
    readonly attested: boolean;
  };
}
