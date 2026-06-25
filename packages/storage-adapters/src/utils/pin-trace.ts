/**
 * @fileoverview Multi-adapter durable pinning for trace bundles (issue #61).
 *
 * `pinTraceFor()` writes a trace's manifest (and optional raw chunk artifacts)
 * to several storage backends in parallel with a redundancy policy, returning
 * every backend's {@link StorageRef}. Those refs are exactly what gets embedded
 * as `storageRefs[]` in the on-chain anchor metadata so a verifier can re-fetch
 * the bundle from any surviving backend years later.
 *
 * @example
 * ```typescript
 * const { refs } = await pinTraceFor(manifest, {
 *   adapters: [createArweaveAdapter({ wallet }), createS3WormAdapter({ bucket, region, retentionYears: 7 })],
 *   redundancy: "all",
 * });
 * // embed `refs` as storageRefs[] in the anchor metadata
 * ```
 */

import type { StorageAdapter, StorageRef, StorableManifest } from "../types.js";
import { StorageError, StorageException } from "../types.js";
import { ReplicatedStorageAdapter, type ReplicationResult } from "./replication.js";

export interface PinTraceOptions {
  /** Storage backends to pin to. */
  adapters: StorageAdapter[];
  /** Redundancy policy across adapters (default "all" — every backend must succeed). */
  redundancy?: "all" | "any" | "quorum";
  /** Minimum successes for the "quorum" policy. */
  quorum?: number;
  /** Optional raw chunk artifacts to store alongside the manifest. */
  artifacts?: Uint8Array[];
  /** Per-adapter retry policy (forwarded to ReplicatedStorageAdapter). */
  retry?: { maxAttempts: number; delayMs: number; backoffMultiplier: number };
}

export interface PinTraceResult {
  /** First successful manifest reference (convenience). */
  manifest: StorageRef;
  /** The manifest reference on every successful backend. */
  manifestRefs: StorageRef[];
  /** Per-artifact references across backends (same order as `options.artifacts`). */
  artifactRefs: StorageRef[][];
  /** All references (manifest + artifacts) — ready to embed as anchor `storageRefs[]`. */
  refs: StorageRef[];
}

function ensureSuccess(result: ReplicationResult, redundancy: string, what: string): void {
  if (!result.success) {
    throw new StorageException(
      StorageError.REPLICATION_FAILED,
      `pinTraceFor: ${what} did not satisfy redundancy "${redundancy}": ` +
        result.errors.map((e) => `${e.adapter}: ${e.error.message}`).join("; ")
    );
  }
}

/**
 * Pin a trace manifest (and optional artifacts) across multiple storage
 * backends with redundancy, returning every resulting reference.
 */
export async function pinTraceFor(
  manifest: StorableManifest,
  options: PinTraceOptions
): Promise<PinTraceResult> {
  if (!options.adapters || options.adapters.length === 0) {
    throw new StorageException(
      StorageError.INVALID_CONFIG,
      "pinTraceFor: at least one adapter is required"
    );
  }

  const redundancy = options.redundancy ?? "all";
  const replicated = new ReplicatedStorageAdapter({
    adapters: options.adapters,
    strategy: redundancy,
    ...(options.quorum !== undefined ? { quorum: options.quorum } : {}),
    ...(options.retry !== undefined ? { retry: options.retry } : {}),
  });

  const manifestResult = await replicated.storeManifestAll(manifest);
  ensureSuccess(manifestResult, redundancy, "manifest");

  const artifactRefs: StorageRef[][] = [];
  for (const artifact of options.artifacts ?? []) {
    const r = await replicated.storeAll(artifact);
    ensureSuccess(r, redundancy, "artifact");
    artifactRefs.push(r.refs);
  }

  const manifestRefs = manifestResult.refs;
  const first = manifestRefs[0];
  if (!first) {
    throw new StorageException(StorageError.STORE_FAILED, "pinTraceFor: no manifest reference produced");
  }

  return {
    manifest: first,
    manifestRefs,
    artifactRefs,
    refs: [...manifestRefs, ...artifactRefs.flat()],
  };
}
