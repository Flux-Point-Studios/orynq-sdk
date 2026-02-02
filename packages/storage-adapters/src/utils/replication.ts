/**
 * Replication utility for storing data across multiple storage backends.
 */

import type {
  StorageAdapter,
  StorageRef,
  StorableManifest,
  ReplicationConfig,
} from "../types.js";
import { StorageError, StorageException } from "../types.js";

export interface ReplicationResult {
  success: boolean;
  refs: StorageRef[];
  errors: Array<{ adapter: string; error: Error }>;
}

/**
 * Storage adapter that replicates data across multiple backends.
 */
export class ReplicatedStorageAdapter implements StorageAdapter {
  readonly type = "local" as const; // Primary type
  private readonly adapters: StorageAdapter[];
  private readonly strategy: "all" | "any" | "quorum";
  private readonly quorum: number;
  private readonly retry: {
    maxAttempts: number;
    delayMs: number;
    backoffMultiplier: number;
  };

  constructor(config: ReplicationConfig) {
    if (config.adapters.length === 0) {
      throw new StorageException(
        StorageError.INVALID_CONFIG,
        "At least one storage adapter is required for replication"
      );
    }

    this.adapters = config.adapters;
    this.strategy = config.strategy;
    this.quorum = config.quorum ?? Math.ceil(config.adapters.length / 2);
    this.retry = config.retry ?? {
      maxAttempts: 3,
      delayMs: 1000,
      backoffMultiplier: 2,
    };
  }

  /**
   * Store data across all configured adapters.
   */
  async store(data: Uint8Array): Promise<StorageRef> {
    const result = await this.storeWithReplication(
      (adapter) => adapter.store(data)
    );

    if (!result.success) {
      throw new StorageException(
        StorageError.REPLICATION_FAILED,
        `Failed to replicate data: ${result.errors.map((e) => e.error.message).join(", ")}`
      );
    }

    // Return the first successful ref
    const ref = result.refs[0];
    if (ref === undefined) {
      throw new StorageException(
        StorageError.STORE_FAILED,
        "No storage reference returned"
      );
    }
    return ref;
  }

  /**
   * Store a manifest across all configured adapters.
   */
  async storeManifest(manifest: StorableManifest): Promise<StorageRef> {
    const result = await this.storeWithReplication(
      (adapter) => adapter.storeManifest(manifest)
    );

    if (!result.success) {
      throw new StorageException(
        StorageError.REPLICATION_FAILED,
        `Failed to replicate manifest: ${result.errors.map((e) => e.error.message).join(", ")}`
      );
    }

    const ref = result.refs[0];
    if (ref === undefined) {
      throw new StorageException(
        StorageError.STORE_FAILED,
        "No storage reference returned"
      );
    }
    return ref;
  }

  /**
   * Fetch data from any adapter that has it.
   */
  async fetch(ref: StorageRef): Promise<Uint8Array> {
    for (const adapter of this.adapters) {
      try {
        return await adapter.fetch(ref);
      } catch {
        // Try next adapter
        continue;
      }
    }

    throw new StorageException(
      StorageError.FETCH_FAILED,
      `Failed to fetch data from any adapter: ${ref.uri}`
    );
  }

  /**
   * Fetch a manifest from any adapter that has it.
   */
  async fetchManifest(ref: StorageRef): Promise<StorableManifest> {
    for (const adapter of this.adapters) {
      try {
        return await adapter.fetchManifest(ref);
      } catch {
        // Try next adapter
        continue;
      }
    }

    throw new StorageException(
      StorageError.FETCH_FAILED,
      `Failed to fetch manifest from any adapter: ${ref.uri}`
    );
  }

  /**
   * Verify data exists and is valid in at least one adapter.
   */
  async verify(ref: StorageRef): Promise<boolean> {
    for (const adapter of this.adapters) {
      try {
        const valid = await adapter.verify(ref);
        if (valid) return true;
      } catch {
        // Try next adapter
        continue;
      }
    }
    return false;
  }

  /**
   * Delete data from all adapters.
   */
  async delete(ref: StorageRef): Promise<void> {
    const errors: Array<{ adapter: string; error: Error }> = [];

    for (const adapter of this.adapters) {
      if (adapter.delete) {
        try {
          await adapter.delete(ref);
        } catch (error) {
          errors.push({
            adapter: adapter.type,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    }

    if (errors.length === this.adapters.filter((a) => a.delete).length) {
      throw new StorageException(
        StorageError.DELETE_FAILED,
        `Failed to delete from all adapters: ${errors.map((e) => e.error.message).join(", ")}`
      );
    }
  }

  /**
   * Pin data in all adapters that support pinning.
   */
  async pin(ref: StorageRef): Promise<void> {
    const errors: Array<{ adapter: string; error: Error }> = [];

    for (const adapter of this.adapters) {
      if (adapter.pin) {
        try {
          await adapter.pin(ref);
        } catch (error) {
          errors.push({
            adapter: adapter.type,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    }

    // Only throw if all pinnable adapters failed
    const pinnableAdapters = this.adapters.filter((a) => a.pin);
    if (pinnableAdapters.length > 0 && errors.length === pinnableAdapters.length) {
      throw new StorageException(
        StorageError.PIN_FAILED,
        `Failed to pin in all adapters: ${errors.map((e) => e.error.message).join(", ")}`
      );
    }
  }

  /**
   * Get all storage references from a replication operation.
   */
  async storeAll(data: Uint8Array): Promise<ReplicationResult> {
    return this.storeWithReplication((adapter) => adapter.store(data));
  }

  /**
   * Store manifest to all adapters and return all references.
   */
  async storeManifestAll(manifest: StorableManifest): Promise<ReplicationResult> {
    return this.storeWithReplication((adapter) => adapter.storeManifest(manifest));
  }

  // === Private Methods ===

  private async storeWithReplication(
    operation: (adapter: StorageAdapter) => Promise<StorageRef>
  ): Promise<ReplicationResult> {
    const results = await Promise.allSettled(
      this.adapters.map((adapter) => this.retryOperation(() => operation(adapter)))
    );

    const refs: StorageRef[] = [];
    const errors: Array<{ adapter: string; error: Error }> = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const adapter = this.adapters[i];
      if (result === undefined || adapter === undefined) continue;

      if (result.status === "fulfilled") {
        refs.push(result.value);
      } else {
        errors.push({
          adapter: adapter.type,
          error: result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
        });
      }
    }

    const success = this.checkSuccess(refs.length, this.adapters.length);

    return { success, refs, errors };
  }

  private checkSuccess(successCount: number, totalCount: number): boolean {
    switch (this.strategy) {
      case "all":
        return successCount === totalCount;
      case "any":
        return successCount > 0;
      case "quorum":
        return successCount >= this.quorum;
      default:
        return successCount > 0;
    }
  }

  private async retryOperation<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    let lastError: Error | undefined;
    let delay = this.retry.delayMs;

    for (let attempt = 0; attempt < this.retry.maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.retry.maxAttempts - 1) {
          await this.sleep(delay);
          delay *= this.retry.backoffMultiplier;
        }
      }
    }

    throw lastError ?? new Error("Operation failed after retries");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
