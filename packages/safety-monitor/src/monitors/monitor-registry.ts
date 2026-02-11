/**
 * @fileoverview Default monitor registry implementation.
 *
 * Location: packages/safety-monitor/src/monitors/monitor-registry.ts
 *
 * Summary:
 * Provides a Map-based registry for safety monitors. Monitors register themselves
 * by ID and can be retrieved by ID for pipeline execution. Follows the same
 * pattern as the attestor's DefaultAttestorRegistry.
 *
 * Usage:
 * Used by the SafetyMonitorPipeline to look up monitors by ID during analysis.
 * Consumers register their monitors (EAI, CoT, Action, custom) into the registry,
 * then pass it to the pipeline constructor.
 *
 * @example
 * ```typescript
 * import { monitorRegistry, DefaultMonitorRegistry } from "./monitor-registry.js";
 * import { EvalAwarenessMonitor } from "./eval-awareness/eai-monitor.js";
 *
 * monitorRegistry.register(new EvalAwarenessMonitor());
 * const monitor = monitorRegistry.get("eval-awareness");
 * ```
 */

import type { Monitor, MonitorRegistry } from "../types.js";
import { SafetyMonitorError, SafetyMonitorException } from "../types.js";

// =============================================================================
// DEFAULT MONITOR REGISTRY
// =============================================================================

/**
 * Default Map-based monitor registry.
 * Stores monitors keyed by their monitorId for O(1) lookup.
 */
export class DefaultMonitorRegistry implements MonitorRegistry {
  private monitors = new Map<string, Monitor>();

  /**
   * Register a monitor in the registry.
   * If a monitor with the same ID already exists, it will be overwritten.
   *
   * @param monitor - The monitor to register
   * @throws SafetyMonitorException if monitor is null/undefined or has no monitorId
   */
  register(monitor: Monitor): void {
    if (!monitor || !monitor.monitorId) {
      throw new SafetyMonitorException(
        SafetyMonitorError.MONITOR_REGISTRATION_FAILED,
        "Cannot register a monitor without a valid monitorId"
      );
    }
    this.monitors.set(monitor.monitorId, monitor);
  }

  /**
   * Get a monitor by its ID.
   *
   * @param monitorId - The unique identifier of the monitor
   * @returns The monitor if found, undefined otherwise
   */
  get(monitorId: string): Monitor | undefined {
    return this.monitors.get(monitorId);
  }

  /**
   * List all registered monitor IDs.
   *
   * @returns Array of registered monitor IDs
   */
  list(): string[] {
    return Array.from(this.monitors.keys());
  }

  /**
   * Check if a monitor with the given ID is registered.
   *
   * @param monitorId - The unique identifier to check
   * @returns true if a monitor with that ID exists
   */
  has(monitorId: string): boolean {
    return this.monitors.has(monitorId);
  }
}

/**
 * Singleton default monitor registry instance.
 * Consumers can use this global registry or create their own.
 */
export const monitorRegistry = new DefaultMonitorRegistry();
