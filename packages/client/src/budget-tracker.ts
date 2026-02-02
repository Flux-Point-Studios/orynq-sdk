/**
 * @summary Budget enforcement for payment limits per request and per day.
 *
 * This module provides the BudgetTracker class for enforcing payment budgets.
 * It supports per-request and per-day limits to prevent runaway costs in
 * automated payment scenarios.
 *
 * Features:
 * - Per-request maximum amount checking
 * - Daily spending limit enforcement
 * - Configurable daily reset hour (UTC)
 * - Soft limit mode for warnings instead of errors
 * - Threshold callbacks for alerting
 *
 * Used by:
 * - PoiClient to check budgets before paying
 * - Any component needing budget enforcement
 */

import type {
  BudgetConfig,
  BudgetStore,
  ChainId,
  BudgetThresholdInfo,
} from "@fluxpointstudios/orynq-sdk-core";
import { BudgetExceededError } from "@fluxpointstudios/orynq-sdk-core";

// ---------------------------------------------------------------------------
// Budget Tracker
// ---------------------------------------------------------------------------

/**
 * Budget enforcement manager for payment limits.
 *
 * Tracks spending and enforces configured limits for per-request and daily
 * payment amounts. Uses a BudgetStore for persistent tracking across requests.
 *
 * @example
 * ```typescript
 * import { BudgetTracker } from "@fluxpointstudios/orynq-sdk-client";
 * import { InMemoryBudgetStore } from "@fluxpointstudios/orynq-sdk-core";
 *
 * const tracker = new BudgetTracker(
 *   {
 *     maxPerRequest: "5000000",  // 5 ADA max per request
 *     maxPerDay: "50000000",     // 50 ADA max per day
 *     dailyResetHour: 0,         // Reset at midnight UTC
 *   },
 *   new InMemoryBudgetStore()
 * );
 *
 * // Check if payment is within budget
 * await tracker.checkBudget("cardano:mainnet", "ADA", 2000000n);
 *
 * // Record the spend after payment
 * await tracker.recordSpend("cardano:mainnet", "ADA", 2000000n);
 * ```
 */
export class BudgetTracker {
  private readonly config: BudgetConfig;
  private readonly store: BudgetStore;

  /**
   * Create a new BudgetTracker.
   *
   * @param config - Budget configuration with limits
   * @param store - Storage backend for tracking spending
   */
  constructor(config: BudgetConfig, store: BudgetStore) {
    this.config = config;
    this.store = store;
  }

  /**
   * Check if a payment amount is within budget limits.
   *
   * Validates both per-request and daily limits. If either would be exceeded,
   * throws BudgetExceededError (or invokes callback if softLimit is enabled).
   *
   * @param chain - CAIP-2 chain identifier
   * @param asset - Asset identifier (e.g., "ADA", "USDC")
   * @param amount - Payment amount in atomic units
   * @throws BudgetExceededError if limits would be exceeded (unless softLimit)
   */
  async checkBudget(
    chain: ChainId,
    asset: string,
    amount: bigint
  ): Promise<void> {
    // Get effective limits (chain/asset-specific or global)
    const limits = this.getEffectiveLimits(chain, asset);

    // Check per-request limit
    if (limits.maxPerRequest !== undefined) {
      const maxPerRequest = BigInt(limits.maxPerRequest);
      if (amount > maxPerRequest) {
        await this.handleBudgetExceeded({
          type: "per-request",
          chain,
          asset,
          spent: "0",
          limit: limits.maxPerRequest,
          percentUsed: Number((amount * 100n) / maxPerRequest),
        });

        if (!this.config.softLimit) {
          throw new BudgetExceededError(
            amount.toString(),
            limits.maxPerRequest,
            "0",
            "per-request"
          );
        }
      }
    }

    // Check daily limit
    if (limits.maxPerDay !== undefined) {
      const maxPerDay = BigInt(limits.maxPerDay);
      const today = this.getTodayKey();
      const spent = await this.store.getSpent(chain, asset, today);
      const wouldSpend = spent + amount;

      if (wouldSpend > maxPerDay) {
        const percentUsed =
          maxPerDay > 0n ? Number((wouldSpend * 100n) / maxPerDay) : 100;

        await this.handleBudgetExceeded({
          type: "daily",
          chain,
          asset,
          spent: spent.toString(),
          limit: limits.maxPerDay,
          percentUsed,
        });

        if (!this.config.softLimit) {
          throw new BudgetExceededError(
            amount.toString(),
            limits.maxPerDay,
            spent.toString(),
            "daily"
          );
        }
      }
    }
  }

  /**
   * Record a payment spend for budget tracking.
   *
   * Should be called after a successful payment to update daily totals.
   *
   * @param chain - CAIP-2 chain identifier
   * @param asset - Asset identifier
   * @param amount - Amount spent in atomic units
   */
  async recordSpend(
    chain: ChainId,
    asset: string,
    amount: bigint
  ): Promise<void> {
    await this.store.recordSpend(chain, asset, amount);
  }

  /**
   * Get the remaining daily budget for a chain/asset.
   *
   * @param chain - CAIP-2 chain identifier
   * @param asset - Asset identifier
   * @returns Remaining budget in atomic units, or null if no daily limit
   */
  async getRemainingDailyBudget(
    chain: ChainId,
    asset: string
  ): Promise<bigint | null> {
    const limits = this.getEffectiveLimits(chain, asset);

    if (limits.maxPerDay === undefined) {
      return null;
    }

    const maxPerDay = BigInt(limits.maxPerDay);
    const today = this.getTodayKey();
    const spent = await this.store.getSpent(chain, asset, today);

    return maxPerDay > spent ? maxPerDay - spent : 0n;
  }

  /**
   * Get current spending for today.
   *
   * @param chain - CAIP-2 chain identifier
   * @param asset - Asset identifier
   * @returns Amount spent today in atomic units
   */
  async getTodaySpending(chain: ChainId, asset: string): Promise<bigint> {
    const today = this.getTodayKey();
    return this.store.getSpent(chain, asset, today);
  }

  /**
   * Check if a specific amount would exceed the per-request limit.
   *
   * @param chain - CAIP-2 chain identifier
   * @param asset - Asset identifier
   * @param amount - Amount to check
   * @returns true if amount exceeds per-request limit
   */
  wouldExceedPerRequestLimit(
    chain: ChainId,
    asset: string,
    amount: bigint
  ): boolean {
    const limits = this.getEffectiveLimits(chain, asset);

    if (limits.maxPerRequest === undefined) {
      return false;
    }

    return amount > BigInt(limits.maxPerRequest);
  }

  /**
   * Get the date key for today based on the reset hour.
   *
   * The reset hour determines when the "day" rolls over. For example, if
   * resetHour is 6, the day starts at 6:00 AM UTC instead of midnight.
   *
   * @returns ISO 8601 date string (YYYY-MM-DD)
   */
  private getTodayKey(): string {
    const now = new Date();
    const resetHour = this.config.dailyResetHour ?? 0;

    // Adjust the date if we haven't reached the reset hour yet
    if (now.getUTCHours() < resetHour) {
      now.setUTCDate(now.getUTCDate() - 1);
    }

    const dateString = now.toISOString().slice(0, 10);
    if (dateString === undefined) {
      // This should never happen with valid Date objects
      return new Date().toISOString().slice(0, 10) ?? "1970-01-01";
    }
    return dateString;
  }

  /**
   * Get effective limits for a chain/asset, falling back to global limits.
   *
   * Priority:
   * 1. Asset-specific limits (if assetLimits configured)
   * 2. Chain-specific limits (if chainLimits configured)
   * 3. Global limits
   *
   * @param chain - CAIP-2 chain identifier
   * @param asset - Asset identifier
   * @returns Effective limit configuration
   */
  private getEffectiveLimits(
    chain: ChainId,
    asset: string
  ): { maxPerRequest: string | undefined; maxPerDay: string | undefined } {
    // Check for asset-specific limits first
    const assetLimits = this.config.assetLimits?.[asset];
    if (assetLimits) {
      return {
        maxPerRequest:
          assetLimits.maxPerRequest ?? this.config.maxPerRequest,
        maxPerDay: assetLimits.maxPerDay ?? this.config.maxPerDay,
      };
    }

    // Check for chain-specific limits
    const chainLimits = this.config.chainLimits?.[chain];
    if (chainLimits) {
      return {
        maxPerRequest:
          chainLimits.maxPerRequest ?? this.config.maxPerRequest,
        maxPerDay: chainLimits.maxPerDay ?? this.config.maxPerDay,
      };
    }

    // Fall back to global limits
    return {
      maxPerRequest: this.config.maxPerRequest,
      maxPerDay: this.config.maxPerDay,
    };
  }

  /**
   * Handle budget exceeded event - invoke callback if configured.
   *
   * @param info - Budget threshold information
   */
  private async handleBudgetExceeded(
    info: BudgetThresholdInfo
  ): Promise<void> {
    if (this.config.onThresholdReached) {
      await this.config.onThresholdReached(info);
    }
  }
}

// ---------------------------------------------------------------------------
// Budget Utilities
// ---------------------------------------------------------------------------

/**
 * Create a simple budget config with common defaults.
 *
 * @param maxPerRequest - Maximum amount per request (optional)
 * @param maxPerDay - Maximum amount per day (optional)
 * @returns BudgetConfig object
 */
export function createBudgetConfig(
  maxPerRequest?: string,
  maxPerDay?: string
): BudgetConfig {
  const config: BudgetConfig = {
    dailyResetHour: 0,
  };
  if (maxPerRequest !== undefined) {
    config.maxPerRequest = maxPerRequest;
  }
  if (maxPerDay !== undefined) {
    config.maxPerDay = maxPerDay;
  }
  return config;
}

/**
 * Format an amount for display with the given number of decimals.
 *
 * @param amount - Amount in atomic units as bigint or string
 * @param decimals - Number of decimal places
 * @returns Formatted string with decimal point
 */
export function formatAmount(
  amount: bigint | string,
  decimals: number
): string {
  const amountBigInt = typeof amount === "string" ? BigInt(amount) : amount;
  const divisor = BigInt(10 ** decimals);
  const whole = amountBigInt / divisor;
  const fraction = amountBigInt % divisor;

  if (decimals === 0) {
    return whole.toString();
  }

  const fractionStr = fraction.toString().padStart(decimals, "0");
  // Remove trailing zeros for cleaner display
  const trimmedFraction = fractionStr.replace(/0+$/, "");

  if (trimmedFraction === "") {
    return whole.toString();
  }

  return `${whole.toString()}.${trimmedFraction}`;
}
