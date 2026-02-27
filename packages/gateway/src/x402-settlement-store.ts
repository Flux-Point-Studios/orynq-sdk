/**
 * @summary Invoice store for tracking x402 payment state and preventing replay attacks.
 *
 * This module provides storage for tracking payment invoices through their lifecycle,
 * including binding payments to specific requests and preventing signature replay.
 *
 * Key security features:
 * - Binds signatures to specific invoices (prevents cross-endpoint replay)
 * - Tracks consumed invoices to prevent reuse
 * - Stores exact payment requirements for verification
 */

import type { ChainId } from "@fluxpointstudios/orynq-sdk-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Payment split output for revenue sharing.
 */
export interface SplitOutput {
  /**
   * Recipient address.
   */
  address: string;

  /**
   * Amount in atomic units.
   */
  amount: string;

  /**
   * Optional description.
   */
  description?: string;
}

/**
 * Payment requirements issued with an invoice.
 */
export interface PaymentRequirements {
  /**
   * Amount in atomic units.
   */
  amount: string;

  /**
   * Recipient address.
   */
  payTo: string;

  /**
   * Asset identifier (e.g., "USDC", "ETH").
   */
  asset: string;

  /**
   * CAIP-2 chain identifier.
   */
  chain: ChainId;

  /**
   * Payment timeout in seconds.
   */
  timeout: number;

  /**
   * Optional payment splits for revenue sharing.
   */
  splits?: SplitOutput[];
}

/**
 * Invoice status values.
 */
export type InvoiceStatus = "pending" | "settled" | "consumed" | "expired";

/**
 * Stored invoice with payment state.
 */
export interface StoredInvoice {
  /**
   * Unique invoice identifier.
   */
  invoiceId: string;

  /**
   * Hash binding the invoice to a specific request.
   * Computed from: method + url + body + partner + chain + asset
   */
  requestHash: string;

  /**
   * Exact payment requirements issued with this invoice.
   */
  requirements: PaymentRequirements;

  /**
   * Current status of the invoice.
   */
  status: InvoiceStatus;

  /**
   * Transaction hash after successful settlement.
   */
  settledTxHash?: string;

  /**
   * ISO 8601 timestamp when the invoice was created.
   */
  createdAt: number;

  /**
   * ISO 8601 timestamp when the invoice was consumed.
   */
  consumedAt?: number;

  /**
   * Client-provided idempotency key.
   */
  idempotencyKey?: string;

  /**
   * Resource URL this invoice is valid for.
   */
  resource: string;
}

/**
 * Interface for invoice settlement storage.
 */
export interface X402SettlementStore {
  /**
   * Create a new invoice.
   */
  create(params: Omit<StoredInvoice, "status" | "createdAt">): Promise<StoredInvoice>;

  /**
   * Get an invoice by its ID.
   */
  get(invoiceId: string): Promise<StoredInvoice | null>;

  /**
   * Find invoice by idempotency key.
   */
  findByIdempotencyKey(key: string): Promise<StoredInvoice | null>;

  /**
   * Find invoice by request hash.
   */
  findByRequestHash(hash: string): Promise<StoredInvoice | null>;

  /**
   * Mark invoice as settled with transaction hash.
   */
  markSettled(invoiceId: string, txHash: string): Promise<void>;

  /**
   * Mark invoice as consumed (payment used).
   */
  markConsumed(invoiceId: string): Promise<void>;

  /**
   * Clean up expired invoices.
   */
  cleanupExpired(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Memory Implementation
// ---------------------------------------------------------------------------

/**
 * In-memory x402 settlement store for development and testing.
 *
 * WARNING: This implementation is NOT suitable for production:
 * - Data is lost on server restart
 * - Not thread-safe across multiple instances
 * - No persistence or replication
 *
 * Use Redis or another persistent store for production.
 */
export class MemoryX402SettlementStore implements X402SettlementStore {
  private invoices = new Map<string, StoredInvoice>();
  private idempotencyIndex = new Map<string, string>();
  private requestHashIndex = new Map<string, string>();

  /**
   * Create a new invoice.
   */
  async create(params: Omit<StoredInvoice, "status" | "createdAt">): Promise<StoredInvoice> {
    const invoice: StoredInvoice = {
      ...params,
      status: "pending",
      createdAt: Date.now(),
    };

    this.invoices.set(invoice.invoiceId, invoice);

    if (params.idempotencyKey) {
      this.idempotencyIndex.set(params.idempotencyKey, invoice.invoiceId);
    }

    this.requestHashIndex.set(params.requestHash, invoice.invoiceId);

    return invoice;
  }

  /**
   * Get an invoice by its ID.
   */
  async get(invoiceId: string): Promise<StoredInvoice | null> {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) {
      return null;
    }

    // Check if expired
    if (invoice.status === "pending") {
      const expiresAt = invoice.createdAt + invoice.requirements.timeout * 1000;
      if (Date.now() > expiresAt) {
        invoice.status = "expired";
      }
    }

    return invoice;
  }

  /**
   * Find invoice by idempotency key.
   */
  async findByIdempotencyKey(key: string): Promise<StoredInvoice | null> {
    const invoiceId = this.idempotencyIndex.get(key);
    if (!invoiceId) {
      return null;
    }
    return this.get(invoiceId);
  }

  /**
   * Find invoice by request hash.
   */
  async findByRequestHash(hash: string): Promise<StoredInvoice | null> {
    const invoiceId = this.requestHashIndex.get(hash);
    if (!invoiceId) {
      return null;
    }
    return this.get(invoiceId);
  }

  /**
   * Mark invoice as settled with transaction hash.
   */
  async markSettled(invoiceId: string, txHash: string): Promise<void> {
    const invoice = this.invoices.get(invoiceId);
    if (invoice) {
      invoice.status = "settled";
      invoice.settledTxHash = txHash;
    }
  }

  /**
   * Mark invoice as consumed (payment used).
   */
  async markConsumed(invoiceId: string): Promise<void> {
    const invoice = this.invoices.get(invoiceId);
    if (invoice) {
      invoice.status = "consumed";
      invoice.consumedAt = Date.now();
    }
  }

  /**
   * Clean up expired invoices.
   */
  async cleanupExpired(): Promise<number> {
    const now = Date.now();
    let deleted = 0;

    for (const [id, invoice] of this.invoices) {
      if (invoice.status === "pending") {
        const expiresAt = invoice.createdAt + invoice.requirements.timeout * 1000;
        if (now > expiresAt) {
          // Remove from indices
          if (invoice.idempotencyKey) {
            this.idempotencyIndex.delete(invoice.idempotencyKey);
          }
          this.requestHashIndex.delete(invoice.requestHash);
          this.invoices.delete(id);
          deleted++;
        }
      }
    }

    return deleted;
  }

  /**
   * Clear all invoices (for testing).
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
}
