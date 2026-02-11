/**
 * @fileoverview Mock feature extractor for testing purposes.
 *
 * Location: packages/feature-telemetry/src/extractors/mock-extractor.ts
 *
 * Provides a deterministic mock implementation of the FeatureExtractor interface.
 * The mock generates feature vectors based on token values using a simple
 * deterministic hash-like transformation, making outputs reproducible for testing.
 *
 * Used by:
 * - src/__tests__/feature-telemetry.test.ts (all test scenarios)
 * - Consumer test suites that need a predictable feature extractor
 */

import {
  FeatureTelemetryError,
  FeatureTelemetryException,
} from "../types.js";
import type {
  FeatureExtractor,
  TokenBlock,
  SafetyFeatureVector,
  ActivationVector,
} from "../types.js";

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Configuration options for the MockFeatureExtractor.
 */
export interface MockFeatureExtractorConfig {
  /** Unique identifier for this extractor instance. Defaults to "mock-extractor-v1". */
  extractorId?: string;
  /** Model ID this extractor targets. Defaults to "mock-model-v1". */
  modelId?: string;
  /** Version hash. Defaults to a fixed deterministic value. */
  versionHash?: string;
  /** Schema hash. Defaults to a fixed deterministic value. */
  schemaHash?: string;
  /** Number of features per activation vector. Defaults to 16. */
  featureDimension?: number;
  /** Layer IDs to generate activations for. Defaults to ["layer_0"]. */
  layerIds?: string[];
}

// =============================================================================
// DEFAULT VALUES
// =============================================================================

const DEFAULT_EXTRACTOR_ID = "mock-extractor-v1";
const DEFAULT_MODEL_ID = "mock-model-v1";
const DEFAULT_VERSION_HASH = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const DEFAULT_SCHEMA_HASH = "f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5";
const DEFAULT_FEATURE_DIMENSION = 16;
const DEFAULT_LAYER_IDS = ["layer_0"];

// =============================================================================
// MOCK EXTRACTOR
// =============================================================================

/**
 * Mock feature extractor that produces deterministic outputs from token values.
 *
 * The extraction algorithm generates activation values by applying a simple
 * deterministic transformation to each token value:
 *   value[i] = sin(token * (i + 1) * 0.1) for each feature dimension i
 *
 * This ensures:
 * - Same tokens always produce same activations (deterministic)
 * - Different tokens produce different activations (discriminative)
 * - Values are bounded in [-1, 1] (well-behaved numerically)
 *
 * @example
 * ```typescript
 * const extractor = new MockFeatureExtractor({ featureDimension: 32 });
 * const vector = await extractor.extract(tokenBlock);
 * ```
 */
export class MockFeatureExtractor implements FeatureExtractor {
  readonly extractorId: string;
  readonly modelId: string;
  readonly versionHash: string;
  readonly schemaHash: string;

  private readonly featureDimension: number;
  private readonly layerIds: string[];

  constructor(config: MockFeatureExtractorConfig = {}) {
    this.extractorId = config.extractorId ?? DEFAULT_EXTRACTOR_ID;
    this.modelId = config.modelId ?? DEFAULT_MODEL_ID;
    this.versionHash = config.versionHash ?? DEFAULT_VERSION_HASH;
    this.schemaHash = config.schemaHash ?? DEFAULT_SCHEMA_HASH;
    this.featureDimension = config.featureDimension ?? DEFAULT_FEATURE_DIMENSION;
    this.layerIds = config.layerIds ?? DEFAULT_LAYER_IDS;
  }

  /**
   * Extract deterministic mock features from a token block.
   *
   * @param tokenBlock - The token block to extract features from
   * @returns Promise resolving to a SafetyFeatureVector with deterministic activations
   * @throws FeatureTelemetryException with INVALID_TOKEN_BLOCK if tokens are empty
   * @throws FeatureTelemetryException with EXTRACTION_FAILED on unexpected errors
   */
  async extract(tokenBlock: TokenBlock): Promise<SafetyFeatureVector> {
    // Validate the token block
    if (!tokenBlock.tokens || tokenBlock.tokens.length === 0) {
      throw new FeatureTelemetryException(
        FeatureTelemetryError.INVALID_TOKEN_BLOCK,
        "Token block must contain at least one token",
      );
    }

    if (tokenBlock.startIndex < 0 || tokenBlock.endIndex <= tokenBlock.startIndex) {
      throw new FeatureTelemetryException(
        FeatureTelemetryError.INVALID_TOKEN_BLOCK,
        `Invalid token range: [${tokenBlock.startIndex}, ${tokenBlock.endIndex})`,
      );
    }

    try {
      const features: ActivationVector[] = [];

      for (const layerId of this.layerIds) {
        for (let pos = 0; pos < tokenBlock.tokens.length; pos++) {
          const token = tokenBlock.tokens[pos]!;
          const values = new Float64Array(this.featureDimension);

          // Deterministic feature generation based on token value,
          // layer index, and position
          const layerIndex = this.layerIds.indexOf(layerId);
          for (let i = 0; i < this.featureDimension; i++) {
            values[i] = Math.sin(
              token * (i + 1) * 0.1 + layerIndex * 0.01 + pos * 0.001,
            );
          }

          features.push({
            values,
            layerId,
            position: tokenBlock.startIndex + pos,
          });
        }
      }

      const featureCount =
        features.length * this.featureDimension;

      return {
        features,
        featureCount,
        extractorId: this.extractorId,
        metadata: {
          mock: true,
          featureDimension: this.featureDimension,
          layerIds: this.layerIds,
        },
      };
    } catch (error) {
      if (error instanceof FeatureTelemetryException) {
        throw error;
      }
      throw new FeatureTelemetryException(
        FeatureTelemetryError.EXTRACTION_FAILED,
        `Mock extraction failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined,
      );
    }
  }
}
