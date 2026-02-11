/**
 * @fileoverview Activation digest computation for feature telemetry.
 *
 * Location: packages/feature-telemetry/src/digest/activation-digest.ts
 *
 * Computes a compact, deterministic cryptographic digest of a safety feature
 * vector. The digest captures the top-K most significant features (by absolute
 * activation value) and hashes their canonical JSON representation with SHA-256.
 *
 * This allows trace events to include a tamper-evident fingerprint of the
 * activation snapshot without storing the full (potentially large) vector.
 *
 * Uses:
 * - canonicalize from @fluxpointstudios/poi-sdk-core for deterministic JSON
 * - sha256StringHex from @fluxpointstudios/poi-sdk-core for hashing
 *
 * Used by:
 * - src/recorder/telemetry-recorder.ts (produces ActivationDigest for snapshots)
 * - src/__tests__/feature-telemetry.test.ts (tests digest determinism)
 */

import { canonicalize, sha256StringHex } from "@fluxpointstudios/poi-sdk-core";

import {
  FeatureTelemetryError,
  FeatureTelemetryException,
} from "../types.js";
import type {
  SafetyFeatureVector,
  ActivationDigest,
} from "../types.js";

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default number of top features to include in the digest. */
const DEFAULT_TOP_K = 32;

// =============================================================================
// INTERNAL TYPES
// =============================================================================

/**
 * A single feature entry with its identifying metadata, used for
 * sorting and canonical serialization.
 */
interface FeatureEntry {
  /** Layer the feature came from */
  layerId: string;
  /** Position in the sequence */
  position: number;
  /** Index within the activation vector */
  index: number;
  /** Activation value */
  value: number;
}

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Compute a deterministic activation digest from a safety feature vector.
 *
 * The algorithm:
 * 1. Flatten all activation vectors into (layerId, position, index, value) entries
 * 2. Sort by absolute value descending, taking the top-K
 * 3. Sort the top-K entries by (layerId, position, index) for canonical ordering
 * 4. Build a canonical JSON representation using RFC 8785 canonicalize
 * 5. Compute SHA-256 of the canonical JSON string
 *
 * @param vector - The safety feature vector to digest
 * @param topK - Number of top features to include (default: 32)
 * @returns Promise resolving to an ActivationDigest
 * @throws FeatureTelemetryException with DIGEST_COMPUTATION_FAILED on error
 * @throws FeatureTelemetryException with INVALID_ACTIVATION if vector contains NaN/Infinity
 *
 * @example
 * ```typescript
 * const digest = await computeActivationDigest(featureVector, 16);
 * console.log(digest.hash); // "a1b2c3..."
 * console.log(digest.topK); // 16
 * ```
 */
export async function computeActivationDigest(
  vector: SafetyFeatureVector,
  topK: number = DEFAULT_TOP_K,
): Promise<ActivationDigest> {
  try {
    // Step 1: Flatten all features into entries
    const entries: FeatureEntry[] = [];

    for (const activation of vector.features) {
      for (let i = 0; i < activation.values.length; i++) {
        const value = activation.values[i]!;

        // Validate activation values
        if (!Number.isFinite(value)) {
          throw new FeatureTelemetryException(
            FeatureTelemetryError.INVALID_ACTIVATION,
            `Non-finite activation value at layer="${activation.layerId}", ` +
              `position=${activation.position}, index=${i}: ${value}`,
          );
        }

        entries.push({
          layerId: activation.layerId,
          position: activation.position,
          index: i,
          value,
        });
      }
    }

    // Step 2: Sort by absolute value descending, take top-K
    entries.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    const effectiveTopK = Math.min(topK, entries.length);
    const topEntries = entries.slice(0, effectiveTopK);

    // Step 3: Sort top entries by (layerId, position, index) for canonical ordering
    topEntries.sort((a, b) => {
      if (a.layerId !== b.layerId) {
        return a.layerId < b.layerId ? -1 : 1;
      }
      if (a.position !== b.position) {
        return a.position - b.position;
      }
      return a.index - b.index;
    });

    // Step 4: Build canonical JSON representation
    const canonicalEntries = topEntries.map((entry) => ({
      i: entry.index,
      l: entry.layerId,
      p: entry.position,
      v: entry.value,
    }));

    const canonicalPayload = {
      extractorId: vector.extractorId,
      featureCount: vector.featureCount,
      topK: effectiveTopK,
      features: canonicalEntries,
    };

    const canonicalJson = canonicalize(canonicalPayload, { removeNulls: false });

    // Step 5: Compute SHA-256
    const hash = await sha256StringHex(canonicalJson);

    return {
      hash,
      algorithm: "sha256",
      topK: effectiveTopK,
      featureCount: vector.featureCount,
    };
  } catch (error) {
    if (error instanceof FeatureTelemetryException) {
      throw error;
    }
    throw new FeatureTelemetryException(
      FeatureTelemetryError.DIGEST_COMPUTATION_FAILED,
      `Activation digest computation failed: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined,
    );
  }
}
