/**
 * @fileoverview Feature telemetry recorder that produces snapshot artifacts.
 *
 * Location: packages/feature-telemetry/src/recorder/telemetry-recorder.ts
 *
 * The FeatureTelemetryRecorder orchestrates the full snapshot pipeline:
 * 1. Look up the requested feature extractor from the registry
 * 2. Extract features from a token block
 * 3. Compute the activation digest
 * 4. Assemble the FeatureSnapshotArtifact with full provenance
 *
 * The resulting artifact aligns with the FeatureSnapshotCustomEvent.data
 * schema defined in @fluxpointstudios/poi-sdk-process-trace, making it
 * ready for inclusion in a process trace.
 *
 * Used by:
 * - Consumer code that integrates feature telemetry into trace recording
 * - src/__tests__/feature-telemetry.test.ts (tests full recording pipeline)
 */

import {
  FeatureTelemetryError,
  FeatureTelemetryException,
} from "../types.js";
import type {
  FeatureExtractorRegistry,
  TokenBlock,
  FeatureSnapshotArtifact,
} from "../types.js";
import { computeActivationDigest } from "../digest/activation-digest.js";

// =============================================================================
// RECORDER OPTIONS
// =============================================================================

/**
 * Options for the recordSnapshot method.
 */
export interface RecordSnapshotOptions {
  /** Optional content-addressed storage reference for the encrypted activation blob. */
  blobRef?: string;
  /** Optional TEE-sealed / quorum-released key reference. */
  keyRef?: string;
  /** Number of top features to include in the activation digest. Defaults to 32. */
  topK?: number;
}

// =============================================================================
// TELEMETRY RECORDER
// =============================================================================

/**
 * Orchestrates feature extraction and snapshot artifact creation.
 *
 * The recorder is stateless aside from holding a reference to the extractor
 * registry. Each recordSnapshot call is independent and produces a complete
 * FeatureSnapshotArtifact with all provenance fields populated.
 *
 * @example
 * ```typescript
 * import {
 *   FeatureTelemetryRecorder,
 *   featureExtractorRegistry,
 *   MockFeatureExtractor,
 * } from "@fluxpointstudios/poi-sdk-feature-telemetry";
 *
 * featureExtractorRegistry.register(new MockFeatureExtractor());
 * const recorder = new FeatureTelemetryRecorder(featureExtractorRegistry);
 *
 * const artifact = await recorder.recordSnapshot("mock-extractor-v1", tokenBlock);
 * // artifact.activationDigest is always populated
 * // artifact.featureExtractorId === "mock-extractor-v1"
 * ```
 */
export class FeatureTelemetryRecorder {
  private readonly registry: FeatureExtractorRegistry;

  /**
   * Create a new FeatureTelemetryRecorder.
   *
   * @param registry - The feature extractor registry to look up extractors from
   */
  constructor(registry: FeatureExtractorRegistry) {
    this.registry = registry;
  }

  /**
   * Record a feature snapshot from a token block using the specified extractor.
   *
   * This method performs the full pipeline:
   * 1. Resolves the extractor from the registry
   * 2. Validates the token block
   * 3. Extracts features using the extractor
   * 4. Computes the activation digest
   * 5. Assembles the complete FeatureSnapshotArtifact
   *
   * @param extractorId - ID of the feature extractor to use
   * @param tokenBlock - The token block to extract features from
   * @param options - Optional recording options (blobRef, keyRef, topK)
   * @returns Promise resolving to a complete FeatureSnapshotArtifact
   * @throws FeatureTelemetryException with EXTRACTOR_NOT_FOUND if extractor is not registered
   * @throws FeatureTelemetryException with INVALID_TOKEN_BLOCK if token block is invalid
   * @throws FeatureTelemetryException with RECORDING_FAILED on unexpected errors
   */
  async recordSnapshot(
    extractorId: string,
    tokenBlock: TokenBlock,
    options: RecordSnapshotOptions = {},
  ): Promise<FeatureSnapshotArtifact> {
    // Step 1: Look up the extractor
    const extractor = this.registry.get(extractorId);
    if (!extractor) {
      throw new FeatureTelemetryException(
        FeatureTelemetryError.EXTRACTOR_NOT_FOUND,
        `Feature extractor "${extractorId}" not found in registry. ` +
          `Available extractors: [${this.registry.list().join(", ")}]`,
      );
    }

    // Step 2: Validate the token block
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
      // Step 3: Extract features
      const featureVector = await extractor.extract(tokenBlock);

      // Step 4: Compute activation digest
      const digest = await computeActivationDigest(featureVector, options.topK);

      // Step 5: Assemble the snapshot artifact
      const artifact: FeatureSnapshotArtifact = {
        activationDigest: digest.hash,
        featureExtractorId: extractor.extractorId,
        featureExtractorVersionHash: extractor.versionHash,
        featureSchemaHash: extractor.schemaHash,
        modelId: extractor.modelId,
        tokenRange: [tokenBlock.startIndex, tokenBlock.endIndex],
        featureCount: featureVector.featureCount,
      };

      // Add optional fields if provided
      if (options.blobRef !== undefined) {
        artifact.blobRef = options.blobRef;
      }
      if (options.keyRef !== undefined) {
        artifact.keyRef = options.keyRef;
      }

      return artifact;
    } catch (error) {
      // Re-throw FeatureTelemetryException as-is
      if (error instanceof FeatureTelemetryException) {
        throw error;
      }
      throw new FeatureTelemetryException(
        FeatureTelemetryError.RECORDING_FAILED,
        `Snapshot recording failed for extractor "${extractorId}": ` +
          `${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined,
      );
    }
  }
}
