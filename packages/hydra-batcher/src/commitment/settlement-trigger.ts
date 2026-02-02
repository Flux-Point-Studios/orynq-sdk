/**
 * Settlement Trigger - Determines when to settle L2 commits to L1.
 * Implements policy-based settlement decisions.
 */

import type {
  SettlementPolicy,
  SettlementEvent,
  BatcherStatus,
} from "../types.js";

export interface SettlementCheck {
  shouldSettle: boolean;
  reason?: SettlementReason;
  priority: "low" | "medium" | "high" | "critical";
}

export type SettlementReason =
  | "max_commits_reached"
  | "max_time_reached"
  | "value_threshold_reached"
  | "event_triggered"
  | "manual_request";

export class SettlementTrigger {
  private lastSettlementTime: number;
  private pendingEvents: SettlementEvent[] = [];

  constructor(private readonly policy: SettlementPolicy) {
    this.lastSettlementTime = Date.now();
  }

  /**
   * Check if settlement should be triggered.
   */
  check(status: BatcherStatus, currentValue?: bigint): SettlementCheck {
    // Check for pending events first (highest priority)
    if (this.pendingEvents.length > 0) {
      const event = this.pendingEvents[0];
      return {
        shouldSettle: true,
        reason: "event_triggered",
        priority: this.getEventPriority(event),
      };
    }

    // Check commit count threshold
    if (status.totalCommits >= this.policy.maxCommitsBeforeSettlement) {
      return {
        shouldSettle: true,
        reason: "max_commits_reached",
        priority: "high",
      };
    }

    // Check time threshold
    const timeSinceLastSettlement = Date.now() - this.lastSettlementTime;
    if (timeSinceLastSettlement >= this.policy.maxTimeBeforeSettlementMs) {
      return {
        shouldSettle: true,
        reason: "max_time_reached",
        priority: "medium",
      };
    }

    // Check value threshold if configured
    if (
      this.policy.valueThresholdLovelace !== undefined &&
      currentValue !== undefined &&
      currentValue >= this.policy.valueThresholdLovelace
    ) {
      return {
        shouldSettle: true,
        reason: "value_threshold_reached",
        priority: "medium",
      };
    }

    return {
      shouldSettle: false,
      priority: "low",
    };
  }

  /**
   * Trigger an event that may cause settlement.
   */
  triggerEvent(event: SettlementEvent): void {
    if (this.policy.settleOnEvents?.includes(event)) {
      this.pendingEvents.push(event);
    }
  }

  /**
   * Clear pending events after settlement.
   */
  clearEvents(): void {
    this.pendingEvents = [];
  }

  /**
   * Mark that a settlement has occurred.
   */
  recordSettlement(): void {
    this.lastSettlementTime = Date.now();
    this.pendingEvents = [];
  }

  /**
   * Get time until next time-based settlement.
   */
  getTimeUntilSettlement(): number {
    const elapsed = Date.now() - this.lastSettlementTime;
    return Math.max(0, this.policy.maxTimeBeforeSettlementMs - elapsed);
  }

  /**
   * Get remaining commits until threshold.
   */
  getCommitsUntilSettlement(currentCommits: number): number {
    return Math.max(0, this.policy.maxCommitsBeforeSettlement - currentCommits);
  }

  /**
   * Check if an event type is configured to trigger settlement.
   */
  isSettlementEvent(event: SettlementEvent): boolean {
    return this.policy.settleOnEvents?.includes(event) ?? false;
  }

  /**
   * Update the settlement policy.
   */
  updatePolicy(policy: Partial<SettlementPolicy>): void {
    Object.assign(this.policy, policy);
  }

  /**
   * Get current policy.
   */
  getPolicy(): SettlementPolicy {
    return { ...this.policy };
  }

  // === Private Methods ===

  private getEventPriority(event?: SettlementEvent): "low" | "medium" | "high" | "critical" {
    switch (event) {
      case "shutdown":
        return "critical";
      case "error":
        return "high";
      case "head-closing":
        return "high";
      case "key-rotation":
        return "medium";
      default:
        return "low";
    }
  }
}

/**
 * Create a default settlement policy.
 */
export function createDefaultPolicy(): SettlementPolicy {
  return {
    maxCommitsBeforeSettlement: 1000,
    maxTimeBeforeSettlementMs: 3600000, // 1 hour
    settleOnEvents: ["error", "shutdown"],
  };
}

/**
 * Create a high-frequency settlement policy.
 */
export function createHighFrequencyPolicy(): SettlementPolicy {
  return {
    maxCommitsBeforeSettlement: 100,
    maxTimeBeforeSettlementMs: 300000, // 5 minutes
    settleOnEvents: ["error", "shutdown", "head-closing"],
  };
}

/**
 * Create a low-frequency settlement policy for cost optimization.
 */
export function createLowFrequencyPolicy(): SettlementPolicy {
  return {
    maxCommitsBeforeSettlement: 10000,
    maxTimeBeforeSettlementMs: 86400000, // 24 hours
    settleOnEvents: ["shutdown"],
  };
}
