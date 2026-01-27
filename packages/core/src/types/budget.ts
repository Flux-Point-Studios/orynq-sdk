/**
 * @summary Budget configuration and storage interfaces for payment limits.
 *
 * This file defines the interfaces for managing payment budgets and caching
 * paid invoices. Budget enforcement prevents runaway costs in automated
 * payment scenarios.
 *
 * Used by:
 * - Payment middleware for automatic budget enforcement
 * - Client SDKs for budget-aware payment handling
 * - Storage implementations (in-memory, Redis, database)
 */

import type { ChainId, PaymentProof } from "./payment.js";

// ---------------------------------------------------------------------------
// Budget Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for payment budget limits.
 *
 * All amounts are in atomic units as strings to prevent precision issues.
 * Budgets can be set per-request, per-day, or both.
 */
export interface BudgetConfig {
  /**
   * Maximum amount allowed per single payment request.
   * Prevents individual payments from being too large.
   *
   * @example "1000000" (1 ADA in lovelace)
   * @example "5000000" (5 USDC with 6 decimals)
   */
  maxPerRequest?: string;

  /**
   * Maximum total amount allowed per day.
   * Resets at the configured dailyResetHour.
   *
   * @example "10000000" (10 ADA in lovelace)
   * @example "50000000" (50 USDC with 6 decimals)
   */
  maxPerDay?: string;

  /**
   * Hour of day (0-23) when daily budget resets.
   * Uses UTC time.
   *
   * @default 0 (midnight UTC)
   */
  dailyResetHour?: number;

  /**
   * Asset-specific budget overrides.
   * Key is asset identifier (e.g., "ADA", "USDC").
   */
  assetLimits?: Record<string, AssetBudgetConfig>;

  /**
   * Chain-specific budget overrides.
   * Key is CAIP-2 chain ID.
   */
  chainLimits?: Record<ChainId, ChainBudgetConfig>;

  /**
   * Whether to allow payments that would exceed budget to proceed
   * with a warning (instead of throwing BudgetExceededError).
   *
   * @default false
   */
  softLimit?: boolean;

  /**
   * Callback invoked when budget threshold is reached.
   * Can be used for alerts/notifications.
   */
  onThresholdReached?: (info: BudgetThresholdInfo) => void | Promise<void>;
}

/**
 * Asset-specific budget configuration.
 */
export interface AssetBudgetConfig {
  /** Maximum per request for this asset */
  maxPerRequest?: string;
  /** Maximum per day for this asset */
  maxPerDay?: string;
}

/**
 * Chain-specific budget configuration.
 */
export interface ChainBudgetConfig {
  /** Maximum per request on this chain */
  maxPerRequest?: string;
  /** Maximum per day on this chain */
  maxPerDay?: string;
  /** Whether this chain is enabled for payments */
  enabled?: boolean;
}

/**
 * Information passed to budget threshold callbacks.
 */
export interface BudgetThresholdInfo {
  /** Type of threshold reached */
  type: "per-request" | "daily";
  /** Chain ID */
  chain: ChainId;
  /** Asset identifier */
  asset: string;
  /** Current spent amount */
  spent: string;
  /** Configured limit */
  limit: string;
  /** Percentage of budget used (0-100) */
  percentUsed: number;
}

// ---------------------------------------------------------------------------
// Budget Store Interface
// ---------------------------------------------------------------------------

/**
 * Interface for budget tracking storage.
 *
 * Implementations can use in-memory storage, Redis, databases, etc.
 * All operations are async to support distributed storage backends.
 */
export interface BudgetStore {
  /**
   * Get the amount spent for an asset on a chain for a specific day.
   *
   * @param chain - CAIP-2 chain identifier
   * @param asset - Asset identifier
   * @param day - ISO 8601 date string (YYYY-MM-DD)
   * @returns Promise resolving to spent amount in atomic units
   */
  getSpent(chain: ChainId, asset: string, day: string): Promise<bigint>;

  /**
   * Record a payment spend for budget tracking.
   *
   * This should atomically increment the spent amount.
   *
   * @param chain - CAIP-2 chain identifier
   * @param asset - Asset identifier
   * @param amount - Amount spent in atomic units
   * @returns Promise that resolves when recorded
   */
  recordSpend(chain: ChainId, asset: string, amount: bigint): Promise<void>;

  /**
   * Reset the spent amount for an asset on a chain.
   * Typically called on daily budget reset.
   *
   * @param chain - CAIP-2 chain identifier
   * @param asset - Asset identifier
   * @returns Promise that resolves when reset
   */
  reset(chain: ChainId, asset: string): Promise<void>;

  /**
   * Reset all budgets (all chains, all assets).
   * Useful for testing or manual resets.
   *
   * @returns Promise that resolves when all budgets are reset
   */
  resetAll?(): Promise<void>;

  /**
   * Get spending summary for all tracked assets.
   * Useful for dashboards and reporting.
   *
   * @returns Promise resolving to spending summary
   */
  getSummary?(): Promise<BudgetSummary>;
}

/**
 * Summary of budget spending across all chains and assets.
 */
export interface BudgetSummary {
  /** Spending by chain and asset */
  byChain: Record<
    ChainId,
    Record<
      string,
      {
        spent: string;
        day: string;
      }
    >
  >;
  /** Last reset timestamp */
  lastReset?: string;
}

// ---------------------------------------------------------------------------
// Invoice Cache Interface
// ---------------------------------------------------------------------------

/**
 * Interface for caching paid invoices.
 *
 * Prevents duplicate payments and enables idempotent payment handling.
 * Implementations should handle expiration to prevent unbounded growth.
 */
export interface InvoiceCache {
  /**
   * Get the payment proof for a previously paid invoice.
   *
   * @param invoiceId - Invoice identifier
   * @returns Promise resolving to proof if found, null otherwise
   */
  getPaid(invoiceId: string): Promise<PaymentProof | null>;

  /**
   * Store a payment proof for an invoice.
   *
   * @param invoiceId - Invoice identifier
   * @param proof - Payment proof to store
   * @returns Promise that resolves when stored
   */
  setPaid(invoiceId: string, proof: PaymentProof): Promise<void>;

  /**
   * Get payment proof by idempotency key.
   * Enables request-level deduplication.
   *
   * @param key - Idempotency key (typically hash of request)
   * @returns Promise resolving to proof if found, null otherwise
   */
  getByIdempotencyKey(key: string): Promise<PaymentProof | null>;

  /**
   * Store a payment proof with its idempotency key.
   *
   * @param key - Idempotency key
   * @param proof - Payment proof to store
   * @returns Promise that resolves when stored
   */
  setByIdempotencyKey?(key: string, proof: PaymentProof): Promise<void>;

  /**
   * Delete a cached invoice (for testing or manual cleanup).
   *
   * @param invoiceId - Invoice identifier
   * @returns Promise that resolves when deleted
   */
  delete?(invoiceId: string): Promise<void>;

  /**
   * Clear all cached invoices (for testing).
   *
   * @returns Promise that resolves when cleared
   */
  clear?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-Memory Implementations (Reference)
// ---------------------------------------------------------------------------

/**
 * Simple in-memory budget store implementation.
 *
 * Suitable for single-process applications and testing.
 * Not suitable for distributed deployments.
 */
export class InMemoryBudgetStore implements BudgetStore {
  private readonly spent = new Map<string, bigint>();

  private key(chain: ChainId, asset: string, day: string): string {
    return `${chain}:${asset}:${day}`;
  }

  async getSpent(chain: ChainId, asset: string, day: string): Promise<bigint> {
    return this.spent.get(this.key(chain, asset, day)) ?? 0n;
  }

  async recordSpend(
    chain: ChainId,
    asset: string,
    amount: bigint
  ): Promise<void> {
    const day = new Date().toISOString().split("T")[0];
    if (day === undefined) {
      throw new Error("Failed to get current day");
    }
    const k = this.key(chain, asset, day);
    const current = this.spent.get(k) ?? 0n;
    this.spent.set(k, current + amount);
  }

  async reset(chain: ChainId, asset: string): Promise<void> {
    const day = new Date().toISOString().split("T")[0];
    if (day === undefined) {
      throw new Error("Failed to get current day");
    }
    this.spent.delete(this.key(chain, asset, day));
  }

  async resetAll(): Promise<void> {
    this.spent.clear();
  }
}

/**
 * Simple in-memory invoice cache implementation.
 *
 * Suitable for single-process applications and testing.
 * Not suitable for distributed deployments.
 */
export class InMemoryInvoiceCache implements InvoiceCache {
  private readonly invoices = new Map<string, PaymentProof>();
  private readonly idempotencyKeys = new Map<string, PaymentProof>();

  async getPaid(invoiceId: string): Promise<PaymentProof | null> {
    return this.invoices.get(invoiceId) ?? null;
  }

  async setPaid(invoiceId: string, proof: PaymentProof): Promise<void> {
    this.invoices.set(invoiceId, proof);
  }

  async getByIdempotencyKey(key: string): Promise<PaymentProof | null> {
    return this.idempotencyKeys.get(key) ?? null;
  }

  async setByIdempotencyKey(key: string, proof: PaymentProof): Promise<void> {
    this.idempotencyKeys.set(key, proof);
  }

  async delete(invoiceId: string): Promise<void> {
    this.invoices.delete(invoiceId);
  }

  async clear(): Promise<void> {
    this.invoices.clear();
    this.idempotencyKeys.clear();
  }
}
