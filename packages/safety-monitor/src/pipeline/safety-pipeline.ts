/**
 * @fileoverview Safety monitoring pipeline that orchestrates monitor execution.
 *
 * Location: packages/safety-monitor/src/pipeline/safety-pipeline.ts
 *
 * Summary:
 * The SafetyMonitorPipeline is the main entry point for running safety analysis.
 * In "post-hoc" mode, it takes a finalized base trace, runs all configured monitors
 * against it, collects results, generates alarm events, and builds a SafetyReportTrace
 * with baseRootHash + baseManifestHash parent pointers.
 *
 * The pipeline uses createTrace/addSpan/addEvent/closeSpan from process-trace to
 * construct the safety report trace, ensuring it has proper cryptographic integrity.
 *
 * Usage:
 * ```typescript
 * const pipeline = new SafetyMonitorPipeline(config, registry);
 * const report = await pipeline.analyze(baseTrace);
 * ```
 */

import {
  createTrace,
  addSpan,
  addEvent,
  closeSpan,
} from "@fluxpointstudios/poi-sdk-process-trace";
import type {
  TraceRun,
  SafetyReportTrace,
} from "@fluxpointstudios/poi-sdk-process-trace";

import type {
  SafetyPipelineConfig,
  MonitorRegistry,
  MonitorContext,
  MonitorResult,
} from "../types.js";
import {
  SafetyMonitorError,
  SafetyMonitorException,
} from "../types.js";
import { MonitorConfigBuilder } from "./monitor-config-builder.js";
import { generateAlarmEvent } from "./alarm.js";

// =============================================================================
// SAFETY MONITOR PIPELINE
// =============================================================================

/**
 * Orchestrates safety monitor execution against a base trace.
 * Runs configured monitors, collects results, and produces a SafetyReportTrace.
 */
export class SafetyMonitorPipeline {
  private readonly config: SafetyPipelineConfig;
  private readonly registry: MonitorRegistry;
  private readonly configBuilder: MonitorConfigBuilder;

  /**
   * Create a new SafetyMonitorPipeline.
   *
   * @param config - Pipeline configuration including mode, monitor list, and provenance
   * @param registry - Registry containing the monitor implementations
   * @throws SafetyMonitorException if config is invalid or required monitors are not registered
   */
  constructor(config: SafetyPipelineConfig, registry: MonitorRegistry) {
    if (!config) {
      throw new SafetyMonitorException(
        SafetyMonitorError.INVALID_CONFIG,
        "Pipeline configuration is required"
      );
    }

    if (!config.monitors || config.monitors.length === 0) {
      throw new SafetyMonitorException(
        SafetyMonitorError.INVALID_CONFIG,
        "At least one monitor must be configured"
      );
    }

    if (!config.baseRootHash || !config.baseManifestHash) {
      throw new SafetyMonitorException(
        SafetyMonitorError.INVALID_CONFIG,
        "baseRootHash and baseManifestHash are required"
      );
    }

    if (!config.provenance) {
      throw new SafetyMonitorException(
        SafetyMonitorError.INVALID_PROVENANCE,
        "Monitor provenance is required"
      );
    }

    // Validate all configured monitors are registered
    for (const monitorId of config.monitors) {
      if (!registry.has(monitorId)) {
        throw new SafetyMonitorException(
          SafetyMonitorError.MONITOR_NOT_FOUND,
          `Monitor "${monitorId}" is configured but not registered in the registry`
        );
      }
    }

    this.config = config;
    this.registry = registry;
    this.configBuilder = new MonitorConfigBuilder();
  }

  /**
   * Run post-hoc analysis on a base trace.
   *
   * Execution flow:
   * 1. Compute monitorConfigHash from provenance
   * 2. Create a new safety report trace
   * 3. For each configured monitor:
   *    a. Create a span for the monitor execution
   *    b. Run the monitor's analyze() method
   *    c. Generate an alarm event from the result
   *    d. Close the span
   * 4. Return the SafetyReportTrace with parent pointers
   *
   * @param baseTrace - The finalized TraceRun to analyze
   * @returns Promise resolving to the SafetyReportTrace
   * @throws SafetyMonitorException if baseTrace is missing or analysis fails
   */
  async analyze(baseTrace: TraceRun): Promise<SafetyReportTrace> {
    if (!baseTrace) {
      throw new SafetyMonitorException(
        SafetyMonitorError.MISSING_BASE_TRACE,
        "Base trace is required for analysis"
      );
    }

    // Step 1: Compute the monitor config hash
    const monitorConfigHash = await this.configBuilder.build(this.config.provenance);

    // Step 2: Create the safety report trace
    const reportRun = await createTrace({
      agentId: `safety-monitor:${this.config.mode}`,
      metadata: {
        baseRootHash: this.config.baseRootHash,
        baseManifestHash: this.config.baseManifestHash,
        monitorConfigHash,
        mode: this.config.mode,
        baseTraceId: baseTrace.id,
      },
    });

    // Step 3: Build the monitor context from the base trace
    const context: MonitorContext = {
      baseTrace,
      events: baseTrace.events,
      spans: baseTrace.spans,
      metadata: baseTrace.metadata ?? {},
    };

    // Step 4: Run each configured monitor
    const results: MonitorResult[] = [];

    for (const monitorId of this.config.monitors) {
      const monitor = this.registry.get(monitorId);
      if (!monitor) {
        // This should not happen since we validated in the constructor,
        // but handle defensively.
        throw new SafetyMonitorException(
          SafetyMonitorError.MONITOR_NOT_FOUND,
          `Monitor "${monitorId}" not found during execution`
        );
      }

      // Create a span for this monitor's execution
      const monitorSpan = addSpan(reportRun, {
        name: `monitor:${monitorId}`,
        visibility: "public",
        metadata: {
          monitorId: monitor.monitorId,
          monitorVersion: monitor.version,
        },
      });

      try {
        // Run the monitor
        const result = await monitor.analyze(context);

        // Validate the result
        if (
          typeof result.score !== "number" ||
          result.score < 0 ||
          result.score > 1
        ) {
          throw new SafetyMonitorException(
            SafetyMonitorError.INVALID_MONITOR_RESULT,
            `Monitor "${monitorId}" returned invalid score: ${result.score}`
          );
        }

        results.push(result);

        // Generate an alarm event and add it to the safety report trace
        const alarmEventData = generateAlarmEvent(result, monitorConfigHash);
        await addEvent(reportRun, monitorSpan.id, alarmEventData);

        // Close the span as completed
        await closeSpan(reportRun, monitorSpan.id, "completed");
      } catch (error) {
        // If the error is already a SafetyMonitorException, re-throw it
        if (error instanceof SafetyMonitorException) {
          // Record the error event before re-throwing
          await addEvent<"error">(reportRun, monitorSpan.id, {
            kind: "error",
            error: error.message,
            code: error.code.toString(),
            recoverable: false,
            visibility: "public",
          });
          await closeSpan(reportRun, monitorSpan.id, "failed");
          throw error;
        }

        // Wrap unexpected errors
        const monitorError = error instanceof Error ? error : new Error(String(error));
        await addEvent<"error">(reportRun, monitorSpan.id, {
          kind: "error",
          error: monitorError.message,
          code: SafetyMonitorError.MONITOR_EXECUTION_FAILED.toString(),
          recoverable: false,
          visibility: "public",
        });
        await closeSpan(reportRun, monitorSpan.id, "failed");

        throw new SafetyMonitorException(
          SafetyMonitorError.MONITOR_EXECUTION_FAILED,
          `Monitor "${monitorId}" failed: ${monitorError.message}`,
          monitorError
        );
      }
    }

    // Step 5: Build the SafetyReportTrace with parent pointers
    const safetyReport: SafetyReportTrace = {
      ...reportRun,
      baseRootHash: this.config.baseRootHash,
      baseManifestHash: this.config.baseManifestHash,
    };

    return safetyReport;
  }
}
