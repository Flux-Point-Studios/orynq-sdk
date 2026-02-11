/**
 * @fileoverview Alarm event generator for safety monitor results.
 *
 * Location: packages/safety-monitor/src/pipeline/alarm.ts
 *
 * Summary:
 * Converts a MonitorResult into a properly typed MonitorAlertCustomEvent
 * from the process-trace safety-events module. The alarm event is then
 * added to the safety report trace as a custom event.
 *
 * Usage:
 * Called by SafetyMonitorPipeline after each monitor runs, to create
 * alarm events that get recorded in the safety report trace.
 */

import type { MonitorAlertCustomEvent } from "@fluxpointstudios/poi-sdk-process-trace";
import type { MonitorResult } from "../types.js";
import { SafetyMonitorError, SafetyMonitorException } from "../types.js";

// =============================================================================
// ALARM LEVEL COMPUTATION
// =============================================================================

/**
 * Determine the alert level based on the monitor result.
 * - "critical": score > threshold * 1.5 (severe concern)
 * - "warning": score > threshold (threshold exceeded)
 * - "info": score <= threshold (within normal range)
 *
 * @param result - The monitor result to classify
 * @returns The alert level string
 */
function computeAlertLevel(result: MonitorResult): "info" | "warning" | "critical" {
  if (!result.exceeded) {
    return "info";
  }
  // Critical if score exceeds 1.5x the threshold
  if (result.score > result.threshold * 1.5) {
    return "critical";
  }
  return "warning";
}

/**
 * Generate a human-readable alarm message from a monitor result.
 *
 * @param result - The monitor result to describe
 * @returns Descriptive message string
 */
function generateAlarmMessage(result: MonitorResult): string {
  if (!result.exceeded) {
    return `Monitor ${result.monitorId} v${result.version}: score ${result.score.toFixed(3)} within threshold ${result.threshold.toFixed(3)} [${result.category}]`;
  }
  return `Monitor ${result.monitorId} v${result.version}: score ${result.score.toFixed(3)} exceeded threshold ${result.threshold.toFixed(3)} [${result.category}]`;
}

// =============================================================================
// ALARM EVENT GENERATOR
// =============================================================================

/**
 * Generate a MonitorAlertCustomEvent from a monitor result.
 * The returned event shape matches the MonitorAlertCustomEvent interface
 * defined in process-trace/safety-events and can be added to a trace
 * via addEvent().
 *
 * Note: The event returned here omits id, seq, timestamp, and hash fields
 * because those are assigned by the trace builder when the event is added.
 *
 * @param result - The monitor result to convert into an alarm event
 * @param monitorConfigHash - The hash of the monitor configuration provenance
 * @returns A MonitorAlertCustomEvent data object (without runtime fields)
 * @throws SafetyMonitorException if result is invalid
 */
export function generateAlarmEvent(
  result: MonitorResult,
  monitorConfigHash: string
): Omit<MonitorAlertCustomEvent, "id" | "seq" | "timestamp" | "hash"> {
  if (!result.monitorId) {
    throw new SafetyMonitorException(
      SafetyMonitorError.ALARM_GENERATION_FAILED,
      "Cannot generate alarm event: monitorId is missing from result"
    );
  }

  if (typeof result.score !== "number" || result.score < 0 || result.score > 1) {
    throw new SafetyMonitorException(
      SafetyMonitorError.ALARM_GENERATION_FAILED,
      `Cannot generate alarm event: score must be a number in [0, 1], got ${result.score}`
    );
  }

  const alertLevel = computeAlertLevel(result);
  const message = generateAlarmMessage(result);

  return {
    kind: "custom",
    eventType: "monitor-alert",
    visibility: "public",
    data: {
      monitorId: result.monitorId,
      monitorVersion: result.version,
      alertLevel,
      category: result.category,
      message,
      score: result.score,
      threshold: result.threshold,
      details: result.details,
      monitorConfigHash,
    },
  };
}
