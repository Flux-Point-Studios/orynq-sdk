/**
 * @fileoverview Safety feature vector utility functions.
 *
 * Location: packages/feature-telemetry/src/digest/safety-vector.ts
 *
 * Provides utility functions for working with SafetyFeatureVector instances:
 * - Merging multiple vectors into one
 * - Normalizing vectors to unit length (L2 normalization)
 * - Computing cosine similarity between vectors
 *
 * These utilities support safety analysis workflows where feature vectors
 * from different extractors or time windows need to be combined or compared.
 *
 * Used by:
 * - Consumer analysis pipelines
 * - src/__tests__/feature-telemetry.test.ts (tests vector operations)
 */

import {
  FeatureTelemetryError,
  FeatureTelemetryException,
} from "../types.js";
import type {
  SafetyFeatureVector,
  ActivationVector,
} from "../types.js";

// =============================================================================
// MERGE
// =============================================================================

/**
 * Merge multiple safety feature vectors into a single vector.
 *
 * The merged vector concatenates all activation features from the input vectors
 * and sums the feature counts. The merged vector's extractorId is set to
 * "merged" to indicate it is a composite.
 *
 * @param vectors - Array of safety feature vectors to merge
 * @returns A new SafetyFeatureVector containing all features from all inputs
 * @throws FeatureTelemetryException with INVALID_ACTIVATION if the input array is empty
 *
 * @example
 * ```typescript
 * const merged = mergeSafetyVectors([vectorA, vectorB]);
 * console.log(merged.featureCount); // vectorA.featureCount + vectorB.featureCount
 * ```
 */
export function mergeSafetyVectors(
  vectors: SafetyFeatureVector[],
): SafetyFeatureVector {
  if (vectors.length === 0) {
    throw new FeatureTelemetryException(
      FeatureTelemetryError.INVALID_ACTIVATION,
      "Cannot merge an empty array of safety feature vectors",
    );
  }

  const allFeatures: ActivationVector[] = [];
  let totalFeatureCount = 0;

  for (const vector of vectors) {
    allFeatures.push(...vector.features);
    totalFeatureCount += vector.featureCount;
  }

  return {
    features: allFeatures,
    featureCount: totalFeatureCount,
    extractorId: "merged",
    metadata: {
      mergedFrom: vectors.map((v) => v.extractorId),
      mergedCount: vectors.length,
    },
  };
}

// =============================================================================
// NORMALIZE
// =============================================================================

/**
 * Normalize a safety feature vector by applying L2 normalization to each
 * activation vector independently.
 *
 * Each activation vector's values are divided by its L2 norm, producing
 * unit-length vectors. If a vector has zero norm (all zeros), it is left unchanged.
 *
 * @param vector - The safety feature vector to normalize
 * @returns A new SafetyFeatureVector with L2-normalized activation vectors
 *
 * @example
 * ```typescript
 * const normalized = normalizeSafetyVector(vector);
 * // Each activation vector now has L2 norm of 1.0 (or 0.0 if all zeros)
 * ```
 */
export function normalizeSafetyVector(
  vector: SafetyFeatureVector,
): SafetyFeatureVector {
  const normalizedFeatures: ActivationVector[] = vector.features.map(
    (activation) => {
      const norm = computeL2Norm(activation.values);

      // Avoid division by zero: if norm is zero, return a copy of the original
      if (norm === 0) {
        return {
          values: new Float64Array(activation.values),
          layerId: activation.layerId,
          position: activation.position,
        };
      }

      const normalized = new Float64Array(activation.values.length);
      for (let i = 0; i < activation.values.length; i++) {
        normalized[i] = activation.values[i]! / norm;
      }

      return {
        values: normalized,
        layerId: activation.layerId,
        position: activation.position,
      };
    },
  );

  return {
    features: normalizedFeatures,
    featureCount: vector.featureCount,
    extractorId: vector.extractorId,
    metadata: {
      ...vector.metadata,
      normalized: true,
    },
  };
}

// =============================================================================
// COSINE SIMILARITY
// =============================================================================

/**
 * Compute the cosine similarity between two safety feature vectors.
 *
 * The similarity is computed by flattening all activation values from both
 * vectors into single flat arrays and computing the standard cosine similarity:
 *   cos(a, b) = dot(a, b) / (||a|| * ||b||)
 *
 * Both vectors must have the same total number of activation values.
 * The result is in the range [-1, 1] where:
 *   1  = identical direction
 *   0  = orthogonal
 *  -1  = opposite direction
 *
 * @param a - First safety feature vector
 * @param b - Second safety feature vector
 * @returns Cosine similarity in [-1, 1]
 * @throws FeatureTelemetryException with INVALID_ACTIVATION if vectors have different dimensions
 *
 * @example
 * ```typescript
 * const similarity = computeVectorSimilarity(vectorA, vectorB);
 * if (similarity > 0.9) {
 *   console.log("Vectors are very similar");
 * }
 * ```
 */
export function computeVectorSimilarity(
  a: SafetyFeatureVector,
  b: SafetyFeatureVector,
): number {
  const flatA = flattenVector(a);
  const flatB = flattenVector(b);

  if (flatA.length !== flatB.length) {
    throw new FeatureTelemetryException(
      FeatureTelemetryError.INVALID_ACTIVATION,
      `Cannot compute similarity: vectors have different dimensions ` +
        `(${flatA.length} vs ${flatB.length})`,
    );
  }

  if (flatA.length === 0) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < flatA.length; i++) {
    const va = flatA[i]!;
    const vb = flatB[i]!;
    dotProduct += va * vb;
    normA += va * va;
    normB += vb * vb;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);

  // If either vector is all zeros, similarity is 0
  if (denominator === 0) {
    return 0;
  }

  return dotProduct / denominator;
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/**
 * Compute the L2 (Euclidean) norm of a Float64Array.
 */
function computeL2Norm(values: Float64Array): number {
  let sumSquares = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    sumSquares += v * v;
  }
  return Math.sqrt(sumSquares);
}

/**
 * Flatten all activation values from a safety feature vector into a single array.
 * Features are concatenated in their original order.
 */
function flattenVector(vector: SafetyFeatureVector): Float64Array {
  // Calculate total length
  let totalLength = 0;
  for (const activation of vector.features) {
    totalLength += activation.values.length;
  }

  const flat = new Float64Array(totalLength);
  let offset = 0;
  for (const activation of vector.features) {
    flat.set(activation.values, offset);
    offset += activation.values.length;
  }

  return flat;
}
