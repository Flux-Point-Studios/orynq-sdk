/**
 * @fileoverview Type definitions for the feature-telemetry package.
 *
 * Location: packages/feature-telemetry/src/types.ts
 *
 * This file defines all type interfaces, error codes, and data structures used
 * by the feature telemetry system. The feature telemetry system provides
 * mechanistic interpretability telemetry for AI safety monitoring, including
 * feature extraction from model activations, activation digest computation,
 * and snapshot recording for provenance tracking.
 *
 * Error codes are in the 7100-7199 range to avoid collisions with other packages.
 *
 * Used by:
 * - src/extractors/extractor-registry.ts (FeatureExtractor, FeatureExtractorRegistry)
 * - src/extractors/mock-extractor.ts (FeatureExtractor, TokenBlock, SafetyFeatureVector)
 * - src/digest/activation-digest.ts (SafetyFeatureVector, ActivationDigest)
 * - src/digest/safety-vector.ts (SafetyFeatureVector, ActivationVector)
 * - src/recorder/telemetry-recorder.ts (FeatureSnapshotArtifact, TokenBlock)
 * - @fluxpointstudios/poi-sdk-process-trace (FeatureSnapshotCustomEvent alignment)
 */

// =============================================================================
// ERROR CODES (7100-7199)
// =============================================================================

/**
 * Error codes for feature telemetry operations.
 * Range: 7100-7199.
 */
export enum FeatureTelemetryError {
  /** The requested feature extractor was not found in the registry. */
  EXTRACTOR_NOT_FOUND = 7100,
  /** Failed to register a feature extractor (e.g., duplicate ID). */
  EXTRACTOR_REGISTRATION_FAILED = 7101,
  /** Feature extraction failed during processing. */
  EXTRACTION_FAILED = 7102,
  /** An activation vector contains invalid values (NaN, Infinity, etc.). */
  INVALID_ACTIVATION = 7103,
  /** The activation digest computation failed. */
  DIGEST_COMPUTATION_FAILED = 7104,
  /** The telemetry recorder failed to produce a snapshot. */
  RECORDING_FAILED = 7105,
  /** The token block is malformed (e.g., empty tokens, invalid range). */
  INVALID_TOKEN_BLOCK = 7106,
  /** The schema hash of the extractor does not match the expected value. */
  SCHEMA_MISMATCH = 7107,
}

// =============================================================================
// EXCEPTION CLASS
// =============================================================================

/**
 * Exception class for feature telemetry errors.
 * Carries a numeric error code for programmatic handling.
 */
export class FeatureTelemetryException extends Error {
  constructor(
    public readonly code: FeatureTelemetryError,
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "FeatureTelemetryException";
  }
}

// =============================================================================
// DATA TYPES
// =============================================================================

/**
 * A block of tokenized input to extract features from.
 * @property tokens - Array of token IDs from the model's vocabulary
 * @property startIndex - Inclusive start index in the original sequence
 * @property endIndex - Exclusive end index in the original sequence
 * @property modelId - Identifier of the model that produced these tokens
 * @property metadata - Optional additional context about the token block
 */
export interface TokenBlock {
  tokens: number[];
  startIndex: number;
  endIndex: number;
  modelId: string;
  metadata?: Record<string, unknown>;
}

/**
 * A single activation vector from a specific layer and position.
 * Uses Float64Array for high-precision numerical representation.
 *
 * @property values - The raw activation values (neuron/feature activations)
 * @property layerId - Identifier of the model layer (e.g., "layer_12", "mlp_0")
 * @property position - Token position within the sequence
 */
export interface ActivationVector {
  values: Float64Array;
  layerId: string;
  position: number;
}

/**
 * A collection of activation vectors extracted by a feature extractor.
 * Represents the safety-relevant features from a token block.
 *
 * @property features - Array of per-layer/position activation vectors
 * @property featureCount - Total number of individual features across all vectors
 * @property extractorId - ID of the extractor that produced this vector
 * @property metadata - Optional additional extraction context
 */
export interface SafetyFeatureVector {
  features: ActivationVector[];
  featureCount: number;
  extractorId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Compact cryptographic digest of an activation snapshot.
 * Suitable for inclusion in trace events without revealing raw activations.
 *
 * @property hash - SHA-256 hex digest of the canonical top-K representation
 * @property algorithm - Hash algorithm used (always "sha256")
 * @property topK - Number of top features used in the digest
 * @property featureCount - Total features in the original vector
 */
export interface ActivationDigest {
  hash: string;
  algorithm: "sha256";
  topK: number;
  featureCount: number;
}

/**
 * Snapshot artifact produced by the telemetry recorder.
 * This structure aligns with FeatureSnapshotCustomEvent.data from process-trace.
 *
 * @property activationDigest - SHA-256 digest of top-K activation features (always required)
 * @property featureExtractorId - Identifier of the extractor that produced the snapshot
 * @property featureExtractorVersionHash - Version hash of the extractor binary/config
 * @property featureSchemaHash - Schema hash of the feature output format
 * @property modelId - Model from which features were extracted
 * @property tokenRange - [start, end) token range in the original sequence
 * @property featureCount - Number of features in the snapshot
 * @property blobRef - Optional content-addressed reference for encrypted activation blob
 * @property keyRef - Optional TEE-sealed / quorum-released key reference
 */
export interface FeatureSnapshotArtifact {
  activationDigest: string;
  featureExtractorId: string;
  featureExtractorVersionHash: string;
  featureSchemaHash: string;
  modelId: string;
  tokenRange: [number, number];
  featureCount: number;
  blobRef?: string;
  keyRef?: string;
}

// =============================================================================
// EXTRACTOR INTERFACES
// =============================================================================

/**
 * Interface for feature extractors that produce safety feature vectors
 * from token blocks. Extractors wrap SAE (Sparse Autoencoder) or similar
 * interpretability models.
 *
 * @property extractorId - Unique identifier for this extractor instance
 * @property modelId - Model this extractor is designed for
 * @property versionHash - Hash of the extractor version/weights
 * @property schemaHash - Hash of the output feature schema
 */
export interface FeatureExtractor {
  readonly extractorId: string;
  readonly modelId: string;
  readonly versionHash: string;
  readonly schemaHash: string;

  /**
   * Extract safety-relevant features from a token block.
   *
   * @param tokenBlock - The tokenized input to analyze
   * @returns Promise resolving to the extracted safety feature vector
   * @throws FeatureTelemetryException with EXTRACTION_FAILED on error
   */
  extract(tokenBlock: TokenBlock): Promise<SafetyFeatureVector>;
}

/**
 * Registry for managing feature extractor instances.
 * Provides lookup by extractor ID for the telemetry recorder.
 */
export interface FeatureExtractorRegistry {
  /**
   * Register a feature extractor.
   * @param extractor - The extractor to register
   * @throws FeatureTelemetryException with EXTRACTOR_REGISTRATION_FAILED if ID already exists
   */
  register(extractor: FeatureExtractor): void;

  /**
   * Get a feature extractor by ID.
   * @param extractorId - The extractor ID to look up
   * @returns The extractor, or undefined if not found
   */
  get(extractorId: string): FeatureExtractor | undefined;

  /**
   * List all registered extractor IDs.
   * @returns Array of extractor ID strings
   */
  list(): string[];

  /**
   * Check if an extractor is registered.
   * @param extractorId - The extractor ID to check
   * @returns true if the extractor is registered
   */
  has(extractorId: string): boolean;
}
