/**
 * @fileoverview Safety event types for the process-trace package.
 *
 * These types define the custom event interfaces used by the safety layer packages
 * (safety-monitor, feature-telemetry, channel-firewall). They use the existing
 * CustomEvent extension mechanism (kind: "custom" + eventType discriminator) to
 * avoid breaking the TraceEvent union.
 *
 * Type guards are provided for runtime discrimination.
 */

import type {
  CustomEvent,
  TraceEvent,
  TraceRun,
  TraceManifest,
} from "./types.js";

// =============================================================================
// SAFETY CUSTOM EVENT TYPES
// =============================================================================

/**
 * Monitor alert custom event.
 * Emitted when a safety monitor detects a concern.
 */
export interface MonitorAlertCustomEvent extends CustomEvent {
  kind: "custom";
  eventType: "monitor-alert";
  data: {
    monitorId: string;
    monitorVersion: string;
    alertLevel: "info" | "warning" | "critical";
    category: "eval-awareness" | "cot-suspicion" | "action-violation" | "covert-channel" | "feature-anomaly";
    message: string;
    score: number;
    threshold: number;
    details: Record<string, unknown>;
    monitorConfigHash: string;
  };
}

/**
 * Feature snapshot custom event.
 * Emitted when the feature telemetry recorder captures an activation snapshot.
 */
export interface FeatureSnapshotCustomEvent extends CustomEvent {
  kind: "custom";
  eventType: "feature-snapshot";
  data: {
    /** SHA-256 digest of compressed activation vectors (always present) */
    activationDigest: string;
    /** Feature extractor identifier */
    featureExtractorId: string;
    /** Version hash of the feature extractor */
    featureExtractorVersionHash: string;
    /** Schema hash of the feature output format */
    featureSchemaHash: string;
    /** Model the features were extracted from */
    modelId: string;
    /** Token block range [start, end) */
    tokenRange: [number, number];
    /** Number of features in the snapshot */
    featureCount: number;
    /** Optional content-addressed storage reference for encrypted blob */
    blobRef?: string;
    /** Optional TEE-sealed / quorum-released key reference */
    keyRef?: string;
  };
}

/**
 * Eval awareness custom event.
 * Emitted by the EAI monitor when it completes an evaluation awareness assessment.
 */
export interface EvalAwarenessCustomEvent extends CustomEvent {
  kind: "custom";
  eventType: "eval-awareness";
  data: {
    /** Composite EAI score [0, 1] */
    eaiScore: number;
    /** Threshold that was applied */
    threshold: number;
    /** Whether the score exceeded the threshold */
    exceeded: boolean;
    /** Unforgeable method provenance */
    probeSetVersionHash: string;
    wrapperTemplatesHash: string;
    scoringWeightsHash: string;
    thresholdPolicyId: string;
    /** Code identity */
    codeIdentity: {
      gitCommitHash: string;
      buildArtifactDigest: string;
    };
    /** Runtime identity */
    runtimeIdentity: {
      containerDigest?: string;
      teeMeasurement?: string;
      hostAttestationRef?: string;
    };
    /** Individual probe results summary */
    probeResults: Array<{
      probeId: string;
      category: "behavioral" | "linguistic" | "meta-cognitive";
      score: number;
      weight: number;
    }>;
    /** Wrapper differential results (if run) */
    wrapperDifferential?: {
      baselineScore: number;
      wrappedScore: number;
      divergence: number;
    };
    /** Context fingerprint hash */
    contextFingerprintHash: string;
  };
}

/**
 * Covert channel detection custom event.
 * Emitted when the channel firewall analyzes a message for covert channels.
 */
export interface CovertChannelCustomEvent extends CustomEvent {
  kind: "custom";
  eventType: "covert-channel";
  data: {
    /** Analyzed channel */
    channel: "output-text" | "tool-args" | "tool-result";
    /** Overall suspicion score [0, 1] */
    suspicionScore: number;
    /** Individual detector results */
    detectors: Array<{
      detectorId: string;
      score: number;
      threshold: number;
      exceeded: boolean;
      details: Record<string, unknown>;
    }>;
    /** Whether normalization was applied */
    normalized: boolean;
    /** Whether paraphrase sanitization was applied */
    paraphrased: boolean;
    /** Content hash (of original, pre-normalization) */
    contentHash: string;
    /** Content hash (of normalized) */
    normalizedContentHash?: string;
    /** Timing metadata */
    timing?: {
      monotonicDeltaMs: number;
      wallClockTimestamp: string;
      attested: boolean;
    };
  };
}

/**
 * Union of all safety custom event types.
 */
export type SafetyCustomEvent =
  | MonitorAlertCustomEvent
  | FeatureSnapshotCustomEvent
  | EvalAwarenessCustomEvent
  | CovertChannelCustomEvent;

// =============================================================================
// TYPE GUARDS
// =============================================================================

/**
 * Check if a trace event is a custom event with a specific eventType.
 */
function isCustomEventType(event: TraceEvent, eventType: string): boolean {
  return event.kind === "custom" && (event as CustomEvent).eventType === eventType;
}

/**
 * Type guard for MonitorAlertCustomEvent.
 */
export function isMonitorAlertEvent(event: TraceEvent): event is MonitorAlertCustomEvent {
  return isCustomEventType(event, "monitor-alert");
}

/**
 * Type guard for FeatureSnapshotCustomEvent.
 */
export function isFeatureSnapshotEvent(event: TraceEvent): event is FeatureSnapshotCustomEvent {
  return isCustomEventType(event, "feature-snapshot");
}

/**
 * Type guard for EvalAwarenessCustomEvent.
 */
export function isEvalAwarenessEvent(event: TraceEvent): event is EvalAwarenessCustomEvent {
  return isCustomEventType(event, "eval-awareness");
}

/**
 * Type guard for CovertChannelCustomEvent.
 */
export function isCovertChannelEvent(event: TraceEvent): event is CovertChannelCustomEvent {
  return isCustomEventType(event, "covert-channel");
}

/**
 * Type guard for any safety custom event.
 */
export function isSafetyEvent(event: TraceEvent): event is SafetyCustomEvent {
  return (
    isMonitorAlertEvent(event) ||
    isFeatureSnapshotEvent(event) ||
    isEvalAwarenessEvent(event) ||
    isCovertChannelEvent(event)
  );
}

// =============================================================================
// SAFETY REPORT TRACE
// =============================================================================

/**
 * A Safety Report Trace extends TraceRun with parent pointers binding it
 * to the base trace it analyzed. This is the "second root" in the two-root model.
 */
export interface SafetyReportTrace extends TraceRun {
  /** Root hash of the base trace that was analyzed */
  baseRootHash: string;
  /** Manifest hash of the base trace that was analyzed */
  baseManifestHash: string;
}

/**
 * Safety Report Manifest extends TraceManifest with parent pointers
 * and monitor provenance hash.
 */
export interface SafetyReportManifest extends TraceManifest {
  /** Root hash of the base trace that was analyzed */
  baseRootHash: string;
  /** Manifest hash of the base trace that was analyzed */
  baseManifestHash: string;
  /** Unforgeable hash of the full monitor provenance chain */
  monitorConfigHash: string;
}

// =============================================================================
// MONITOR PROVENANCE
// =============================================================================

/**
 * Full unforgeable provenance for the monitoring configuration.
 * monitorConfigHash = H("poi-trace:safety:v1|" + canonicalize(provenance))
 */
export interface MonitorProvenance {
  /** What monitors ran */
  monitorIds: string[];
  monitorVersions: string[];

  /** Code identity (proves which binary) */
  codeIdentity: {
    gitCommitHash: string;
    buildArtifactDigest: string;
  };

  /** Configuration identity (proves which settings) */
  promptTemplatesHash: string;
  thresholdsHash: string;
  scoringWeightsHash: string;
  thresholdPolicyId: string;

  /** Runtime identity (proves where it ran) */
  runtimeIdentity: {
    containerDigest?: string;
    teeMeasurement?: string;
    hostAttestationRef?: string;
  };
}

// =============================================================================
// COMMIT SINK ABSTRACTION
// =============================================================================

/**
 * Finality level for commit sinks.
 */
export type FinalityLevel = "soft" | "hard" | "anchored";

/**
 * Abstract sink for committing trace roots.
 */
export interface CommitSink {
  readonly sinkId: string;
  readonly sinkType: "cardano-l1" | "hydra-l2" | "s3" | "ipfs";

  commit(
    rootHash: string,
    manifestHash: string,
    metadata: Record<string, unknown>
  ): Promise<CommitReceipt>;

  getFinalityLevel(receiptId: string): Promise<FinalityLevel>;
}

/**
 * Receipt from a commit operation.
 */
export interface CommitReceipt {
  receiptId: string;
  sinkType: string;
  finalityLevel: FinalityLevel;
  txHash?: string;
  timestamp: string;
}
