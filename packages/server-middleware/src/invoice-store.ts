/**
 * @summary Invoice storage interface and in-memory implementation.
 *
 * This file defines the InvoiceStore interface for persisting payment invoices
 * and provides an in-memory implementation suitable for development and testing.
 * Production deployments should use a persistent store (Redis, PostgreSQL, etc.).
 *
 * Invoices track the lifecycle of payment requests from creation through
 * confirmation and consumption. They support idempotency through unique keys
 * and request hashes.
 *
 * Used by:
 * - Express middleware for creating and managing invoices
 * - Fastify plugin for creating and managing invoices
 */

import type { PaymentStatusValue, ChainId } from "@fluxpointstudios/orynq-sdk-core";

// ---------------------------------------------------------------------------
// Invoice Types
// ---------------------------------------------------------------------------

/**
 * Invoice representing a payment request.
 *
 * Invoices are created when a payment is required and track the payment
 * through its lifecycle from pending to consumed or expired.
 */
export interface Invoice {
  /**
   * Unique invoice identifier (UUID).
   * Used to reference this specific payment request.
   */
  id: string;

  /**
   * CAIP-2 chain identifier for the payment.
   * @example "cardano:mainnet", "eip155:8453"
   */
  chain: ChainId;

  /**
   * Asset identifier for the payment.
   * @example "ADA", "USDC", "ETH"
   */
  asset: string;

  /**
   * Payment amount in atomic units as STRING.
   * Using string to prevent JavaScript precision issues.
   */
  amountUnits: string;

  /**
   * Recipient address in chain-native format.
   */
  payTo: string;

  /**
   * Current status of the payment.
   */
  status: PaymentStatusValue;

  /**
   * Transaction hash when payment is submitted/confirmed.
   */
  txHash?: string;

  /**
   * ISO 8601 timestamp when the invoice was created.
   */
  createdAt: string;

  /**
   * ISO 8601 timestamp when the invoice expires.
   * After expiration, the invoice cannot be paid.
   */
  expiresAt?: string;

  /**
   * ISO 8601 timestamp when the payment was consumed.
   * A consumed payment has been used to fulfill a request.
   */
  consumedAt?: string;

  /**
   * Client-provided idempotency key for duplicate detection.
   * Same key = same request (return existing invoice).
   */
  idempotencyKey?: string;

  /**
   * Hash of the request (method + URL + body) for deduplication.
   * Used when no idempotency key is provided.
   */
  requestHash?: string;

  /**
   * Optional metadata attached to the invoice.
   * Can store application-specific data like user IDs, product IDs, etc.
   */
  metadata?: Record<string, unknown>;

  /**
   * Number of block confirmations (updated during verification).
   */
  confirmations?: number;
}

/**
 * Parameters for creating a new invoice.
 */
export interface CreateInvoiceParams {
  /**
   * CAIP-2 chain identifier for the payment.
   */
  chain: ChainId;

  /**
   * Asset identifier for the payment.
   */
  asset: string;

  /**
   * Payment amount in atomic units as STRING.
   */
  amountUnits: string;

  /**
   * Recipient address in chain-native format.
   */
  payTo: string;

  /**
   * Time until invoice expires in seconds.
   * @default 300 (5 minutes)
   */
  expiresInSeconds?: number;

  /**
   * Client-provided idempotency key.
   */
  idempotencyKey?: string;

  /**
   * Hash of the request for deduplication.
   */
  requestHash?: string;

  /**
   * Optional metadata to attach to the invoice.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Query parameters for finding invoices.
 */
export interface InvoiceQuery {
  /**
   * Filter by status.
   */
  status?: PaymentStatusValue;

  /**
   * Filter by chain.
   */
  chain?: ChainId;

  /**
   * Filter by creation date (ISO 8601, invoices created after this date).
   */
  createdAfter?: string;

  /**
   * Filter by creation date (ISO 8601, invoices created before this date).
   */
  createdBefore?: string;

  /**
   * Maximum number of results to return.
   * @default 100
   */
  limit?: number;

  /**
   * Offset for pagination.
   * @default 0
   */
  offset?: number;
}

// ---------------------------------------------------------------------------
// Invoice Store Interface
// ---------------------------------------------------------------------------

/**
 * Interface for invoice storage implementations.
 *
 * Implementations should provide persistent storage for invoices with
 * support for atomic operations and efficient querying.
 *
 * @example
 * ```typescript
 * class RedisInvoiceStore implements InvoiceStore {
 *   async create(params: CreateInvoiceParams): Promise<Invoice> {
 *     // Store in Redis...
 *   }
 *   // ...
 * }
 * ```
 */
export interface InvoiceStore {
  /**
   * Create a new invoice.
   *
   * @param params - Invoice creation parameters
   * @returns Promise resolving to the created invoice
   */
  create(params: CreateInvoiceParams): Promise<Invoice>;

  /**
   * Get an invoice by its ID.
   *
   * @param invoiceId - Invoice ID to look up
   * @returns Promise resolving to the invoice or null if not found
   */
  get(invoiceId: string): Promise<Invoice | null>;

  /**
   * Update the status of an invoice.
   *
   * @param invoiceId - Invoice ID to update
   * @param status - New status value
   * @param txHash - Optional transaction hash to set
   */
  updateStatus(
    invoiceId: string,
    status: PaymentStatusValue,
    txHash?: string
  ): Promise<void>;

  /**
   * Mark an invoice as consumed (payment has been used).
   *
   * @param invoiceId - Invoice ID to mark as consumed
   */
  markConsumed(invoiceId: string): Promise<void>;

  /**
   * Find an invoice by its idempotency key.
   *
   * @param key - Idempotency key to search for
   * @returns Promise resolving to the invoice or null if not found
   */
  findByIdempotencyKey(key: string): Promise<Invoice | null>;

  /**
   * Find an invoice by its request hash.
   *
   * @param hash - Request hash to search for
   * @returns Promise resolving to the invoice or null if not found
   */
  findByRequestHash(hash: string): Promise<Invoice | null>;

  /**
   * Query invoices with optional filters.
   *
   * @param query - Query parameters
   * @returns Promise resolving to array of matching invoices
   */
  query?(query: InvoiceQuery): Promise<Invoice[]>;

  /**
   * Delete expired invoices.
   *
   * @returns Promise resolving to number of deleted invoices
   */
  cleanupExpired?(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Memory Implementation
// ---------------------------------------------------------------------------

/**
 * In-memory invoice store for development and testing.
 *
 * WARNING: This implementation is NOT suitable for production use:
 * - Data is lost on server restart
 * - Not thread-safe across multiple instances
 * - No persistence or replication
 *
 * Use Redis, PostgreSQL, or another persistent store for production.
 *
 * @example
 * ```typescript
 * const store = new MemoryInvoiceStore();
 *
 * const invoice = await store.create({
 *   chain: "cardano:mainnet",
 *   asset: "ADA",
 *   amountUnits: "1000000",
 *   payTo: "addr1...",
 * });
 *
 * await store.updateStatus(invoice.id, "confirmed", "txHash...");
 * ```
 */
export class MemoryInvoiceStore implements InvoiceStore {
  private invoices = new Map<string, Invoice>();
  private idempotencyIndex = new Map<string, string>(); // key -> invoiceId
  private requestHashIndex = new Map<string, string>(); // hash -> invoiceId

  /**
   * Create a new invoice.
   *
   * @param params - Invoice creation parameters
   * @returns Promise resolving to the created invoice
   */
  async create(params: CreateInvoiceParams): Promise<Invoice> {
    const id = this.generateId();
    const now = new Date();

    const invoice: Invoice = {
      id,
      chain: params.chain,
      asset: params.asset,
      amountUnits: params.amountUnits,
      payTo: params.payTo,
      status: "pending",
      createdAt: now.toISOString(),
    };

    // Only add optional fields if they have values
    if (params.expiresInSeconds !== undefined) {
      invoice.expiresAt = new Date(now.getTime() + params.expiresInSeconds * 1000).toISOString();
    }
    if (params.idempotencyKey !== undefined) {
      invoice.idempotencyKey = params.idempotencyKey;
    }
    if (params.requestHash !== undefined) {
      invoice.requestHash = params.requestHash;
    }
    if (params.metadata !== undefined) {
      invoice.metadata = params.metadata;
    }

    // Store invoice
    this.invoices.set(id, invoice);

    // Index by idempotency key
    if (params.idempotencyKey) {
      this.idempotencyIndex.set(params.idempotencyKey, id);
    }

    // Index by request hash
    if (params.requestHash) {
      this.requestHashIndex.set(params.requestHash, id);
    }

    return invoice;
  }

  /**
   * Get an invoice by its ID.
   *
   * @param invoiceId - Invoice ID to look up
   * @returns Promise resolving to the invoice or null if not found
   */
  async get(invoiceId: string): Promise<Invoice | null> {
    const invoice = this.invoices.get(invoiceId);

    if (!invoice) {
      return null;
    }

    // Check if expired
    if (invoice.expiresAt && invoice.status === "pending") {
      if (new Date(invoice.expiresAt) < new Date()) {
        invoice.status = "expired";
      }
    }

    return invoice;
  }

  /**
   * Update the status of an invoice.
   *
   * @param invoiceId - Invoice ID to update
   * @param status - New status value
   * @param txHash - Optional transaction hash to set
   */
  async updateStatus(
    invoiceId: string,
    status: PaymentStatusValue,
    txHash?: string
  ): Promise<void> {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) {
      return;
    }

    invoice.status = status;

    if (txHash) {
      invoice.txHash = txHash;
    }
  }

  /**
   * Mark an invoice as consumed (payment has been used).
   *
   * @param invoiceId - Invoice ID to mark as consumed
   */
  async markConsumed(invoiceId: string): Promise<void> {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) {
      return;
    }

    invoice.status = "consumed";
    invoice.consumedAt = new Date().toISOString();
  }

  /**
   * Find an invoice by its idempotency key.
   *
   * @param key - Idempotency key to search for
   * @returns Promise resolving to the invoice or null if not found
   */
  async findByIdempotencyKey(key: string): Promise<Invoice | null> {
    const invoiceId = this.idempotencyIndex.get(key);
    if (!invoiceId) {
      return null;
    }
    return this.get(invoiceId);
  }

  /**
   * Find an invoice by its request hash.
   *
   * @param hash - Request hash to search for
   * @returns Promise resolving to the invoice or null if not found
   */
  async findByRequestHash(hash: string): Promise<Invoice | null> {
    const invoiceId = this.requestHashIndex.get(hash);
    if (!invoiceId) {
      return null;
    }
    return this.get(invoiceId);
  }

  /**
   * Query invoices with optional filters.
   *
   * @param query - Query parameters
   * @returns Promise resolving to array of matching invoices
   */
  async query(query: InvoiceQuery): Promise<Invoice[]> {
    const { status, chain, createdAfter, createdBefore, limit = 100, offset = 0 } = query;

    let results: Invoice[] = [];

    for (const invoice of this.invoices.values()) {
      // Apply filters
      if (status && invoice.status !== status) continue;
      if (chain && invoice.chain !== chain) continue;
      if (createdAfter && invoice.createdAt < createdAfter) continue;
      if (createdBefore && invoice.createdAt >= createdBefore) continue;

      results.push(invoice);
    }

    // Sort by creation date (newest first)
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    // Apply pagination
    return results.slice(offset, offset + limit);
  }

  /**
   * Delete expired invoices.
   *
   * @returns Promise resolving to number of deleted invoices
   */
  async cleanupExpired(): Promise<number> {
    const now = new Date().toISOString();
    let deleted = 0;

    for (const [id, invoice] of this.invoices) {
      if (invoice.expiresAt && invoice.expiresAt < now && invoice.status === "pending") {
        // Remove from indices
        if (invoice.idempotencyKey) {
          this.idempotencyIndex.delete(invoice.idempotencyKey);
        }
        if (invoice.requestHash) {
          this.requestHashIndex.delete(invoice.requestHash);
        }

        // Remove invoice
        this.invoices.delete(id);
        deleted++;
      }
    }

    return deleted;
  }

  /**
   * Clear all invoices (useful for testing).
   */
  clear(): void {
    this.invoices.clear();
    this.idempotencyIndex.clear();
    this.requestHashIndex.clear();
  }

  /**
   * Get the number of stored invoices.
   */
  get size(): number {
    return this.invoices.size;
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Generate a unique invoice ID.
   */
  private generateId(): string {
    // Use crypto.randomUUID() if available (Node 19+, modern browsers)
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }

    // Fallback to timestamp + random
    return `inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}
