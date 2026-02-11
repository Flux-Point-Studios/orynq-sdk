/**
 * @fileoverview Core types for the safety-monitor package.
 *
 * Location: packages/safety-monitor/src/types.ts
 *
 * Summary:
 * Defines all type definitions, interfaces, enums, and error classes for the
 * safety monitoring pipeline. This includes monitor interfaces, result shapes,
 * pipeline configuration, circuit breaker rules, and error codes.
 *
 * Usage:
 * Types are imported by the pipeline (safety-pipeline.ts), individual monitors
 * (eval-awareness, cot-monitor, action-monitor), the alarm generator, and tests.
 * Integrates with process-trace types (TraceRun, TraceEvent, TraceSpan) and
 * safety-events types (MonitorProvenance, SafetyReportTrace).
 */

import type {
  TraceRun,
  TraceEvent,
  TraceSpan,
  MonitorProvenance,
} from "@fluxpointstudios/poi-sdk-process-trace";

// =============================================================================
// ERROR CODES (7000-7099)
// =============================================================================

/**
 * Error codes for safety-monitor operations.
 * Uses the 7000-7099 range as specified in the architectural plan.
 */
export enum SafetyMonitorError {
  // General errors (7000-7019)
  MONITOR_NOT_FOUND = 7000,
  MONITOR_REGISTRATION_FAILED = 7001,
  PIPELINE_NOT_INITIALIZED = 7002,
  PIPELINE_ALREADY_RUNNING = 7003,

  // Monitor execution errors (7020-7039)
  MONITOR_EXECUTION_FAILED = 7020,
  MONITOR_TIMEOUT = 7021,
  INVALID_MONITOR_RESULT = 7022,

  // Configuration errors (7040-7059)
  INVALID_CONFIG = 7040,
  MISSING_BASE_TRACE = 7041,
  INVALID_PROVENANCE = 7042,

  // Circuit breaker errors (7060-7079)
  CIRCUIT_BREAKER_TRIGGERED = 7060,
  ACTION_BLOCKED = 7061,
  IRREVERSIBLE_ACTION_DETECTED = 7062,

  // Alarm errors (7080-7099)
  ALARM_GENERATION_FAILED = 7080,
}

// =============================================================================
// EXCEPTION CLASS
// =============================================================================

/**
 * Exception class for safety-monitor errors.
 * Follows the same pattern as MidnightProverException and AttestorException.
 *
 * @property code - Numeric error code from SafetyMonitorError enum
 * @property cause - Optional underlying error that caused this exception
 */
export class SafetyMonitorException extends Error {
  constructor(
    public readonly code: SafetyMonitorError,
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "SafetyMonitorException";
  }

  /**
   * Create a formatted error message including the error code name.
   */
  toString(): string {
    const codeStr = SafetyMonitorError[this.code] ?? this.code.toString();
    const causeStr = this.cause ? ` (caused by: ${this.cause.message})` : "";
    return `[${codeStr}] ${this.message}${causeStr}`;
  }
}

// =============================================================================
// MONITOR CONTEXT
// =============================================================================

/**
 * Context provided to monitors during analysis.
 * Contains the base trace data and metadata needed for evaluation.
 *
 * @property baseTrace - The TraceRun being analyzed
 * @property events - All events from the base trace
 * @property spans - All spans from the base trace
 * @property metadata - Additional context metadata (e.g. system prompt hash, tool list)
 */
export interface MonitorContext {
  baseTrace: TraceRun;
  events: TraceEvent[];
  spans: TraceSpan[];
  metadata: Record<string, unknown>;
}

// =============================================================================
// MONITOR RESULT
// =============================================================================

/**
 * Result produced by a monitor after analyzing a trace.
 *
 * @property monitorId - Identifier of the monitor that produced this result
 * @property version - Version of the monitor
 * @property score - Computed score in [0, 1]
 * @property threshold - Threshold that was applied
 * @property exceeded - Whether the score exceeded the threshold
 * @property trustLevel - "authoritative" for compliance monitors, "fragile" for heuristic monitors
 * @property category - Classification of what this monitor checks
 * @property details - Additional details about the analysis
 * @property timestamp - ISO 8601 timestamp of when the result was produced
 */
export interface MonitorResult {
  monitorId: string;
  version: string;
  score: number;
  threshold: number;
  exceeded: boolean;
  trustLevel: "authoritative" | "fragile";
  category:
    | "eval-awareness"
    | "cot-suspicion"
    | "action-violation"
    | "covert-channel"
    | "feature-anomaly";
  details: Record<string, unknown>;
  timestamp: string;
}

// =============================================================================
// MONITOR INTERFACE
// =============================================================================

/**
 * Interface for safety monitors. Each monitor analyzes a trace context and
 * produces a MonitorResult with a score and category classification.
 *
 * @property monitorId - Unique identifier for this monitor
 * @property version - Semantic version of this monitor implementation
 */
export interface Monitor {
  readonly monitorId: string;
  readonly version: string;
  analyze(context: MonitorContext): Promise<MonitorResult>;
}

// =============================================================================
// MONITOR REGISTRY
// =============================================================================

/**
 * Interface for managing monitor registration and retrieval.
 */
export interface MonitorRegistry {
  register(monitor: Monitor): void;
  get(monitorId: string): Monitor | undefined;
  list(): string[];
  has(monitorId: string): boolean;
}

// =============================================================================
// CIRCUIT BREAKER RULE
// =============================================================================

/**
 * Rule for the circuit breaker mode. Defines which actions should be blocked
 * when a specific monitor's score exceeds its threshold.
 *
 * @property actionPattern - Glob or regex pattern matching action/command names
 * @property monitorId - The monitor whose result triggers this rule
 * @property blockOnExceed - Whether to block the action when threshold is exceeded
 */
export interface CircuitBreakerRule {
  actionPattern: string;
  monitorId: string;
  blockOnExceed: boolean;
}

// =============================================================================
// PIPELINE CONFIGURATION
// =============================================================================

/**
 * Configuration for the safety monitoring pipeline.
 *
 * @property mode - "post-hoc" for after-the-fact analysis, "circuit-breaker" for real-time blocking
 * @property monitors - List of monitor IDs to run
 * @property circuitBreakerRules - Rules for circuit-breaker mode (optional)
 * @property baseRootHash - Root hash of the base trace being analyzed
 * @property baseManifestHash - Manifest hash of the base trace being analyzed
 * @property provenance - Full unforgeable provenance of the monitoring configuration
 */
export interface SafetyPipelineConfig {
  mode: "post-hoc" | "circuit-breaker";
  monitors: string[];
  circuitBreakerRules?: CircuitBreakerRule[];
  baseRootHash: string;
  baseManifestHash: string;
  provenance: MonitorProvenance;
}
