/**
 * @summary Main entry point for @fluxpointstudios/poi-sdk-safety-monitor package.
 *
 * This package provides safety monitoring for Proof-of-Intent SDK traces.
 * It enables detection of evaluation awareness, chain-of-thought suspicion,
 * and action compliance violations through a configurable pipeline of monitors.
 *
 * Key features:
 * - Monitor registry for pluggable safety monitors
 * - Post-hoc analysis pipeline that produces SafetyReportTrace
 * - Eval Awareness Index (EAI) monitor with behavioral/linguistic/meta-cognitive probes
 * - Chain-of-Thought (CoT) suspicion monitor (always fragile trust level)
 * - Action compliance monitor (authoritative trust level)
 * - Alarm event generation for threshold violations
 * - Monitor config hashing for unforgeable provenance
 * - Context fingerprinting and wrapper differential analysis
 *
 * Usage:
 * ```typescript
 * import {
 *   DefaultMonitorRegistry,
 *   SafetyMonitorPipeline,
 *   EvalAwarenessMonitor,
 *   CotMonitor,
 *   ActionMonitor,
 * } from "@fluxpointstudios/poi-sdk-safety-monitor";
 *
 * const registry = new DefaultMonitorRegistry();
 * registry.register(new EvalAwarenessMonitor());
 * registry.register(new CotMonitor());
 * registry.register(new ActionMonitor());
 *
 * const pipeline = new SafetyMonitorPipeline(config, registry);
 * const report = await pipeline.analyze(baseTrace);
 * ```
 */

// ---------------------------------------------------------------------------
// Type Exports
// ---------------------------------------------------------------------------

export type {
  Monitor,
  MonitorResult,
  MonitorContext,
  MonitorRegistry,
  CircuitBreakerRule,
  SafetyPipelineConfig,
} from "./types.js";

export {
  SafetyMonitorError,
  SafetyMonitorException,
} from "./types.js";

// ---------------------------------------------------------------------------
// Monitor Registry
// ---------------------------------------------------------------------------

export {
  DefaultMonitorRegistry,
  monitorRegistry,
} from "./monitors/monitor-registry.js";

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export { SafetyMonitorPipeline } from "./pipeline/safety-pipeline.js";
export { MonitorConfigBuilder } from "./pipeline/monitor-config-builder.js";
export { generateAlarmEvent } from "./pipeline/alarm.js";

// ---------------------------------------------------------------------------
// Monitors
// ---------------------------------------------------------------------------

// Eval Awareness
export { EvalAwarenessMonitor } from "./monitors/eval-awareness/eai-monitor.js";
export type { EaiMonitorConfig } from "./monitors/eval-awareness/eai-monitor.js";
export type { Probe } from "./monitors/eval-awareness/probes.js";
export {
  BehavioralConsistencyProbe,
  CommandPatternProbe,
  LinguisticMarkerProbe,
  MetaCognitiveProbe,
  createDefaultProbes,
} from "./monitors/eval-awareness/probes.js";
export { computeContextFingerprint } from "./monitors/eval-awareness/context-fingerprint.js";
export {
  WrapperDifferentialAnalyzer,
} from "./monitors/eval-awareness/wrapper-differential.js";
export type { WrapperDifferentialResult } from "./monitors/eval-awareness/wrapper-differential.js";

// CoT Monitor
export { CotMonitor } from "./monitors/cot-monitor.js";
export type { CotMonitorConfig } from "./monitors/cot-monitor.js";

// Action Monitor
export { ActionMonitor } from "./monitors/action-monitor.js";
export type { ActionMonitorConfig } from "./monitors/action-monitor.js";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Package version.
 * Updated automatically during build.
 */
export const VERSION = "0.1.0";
