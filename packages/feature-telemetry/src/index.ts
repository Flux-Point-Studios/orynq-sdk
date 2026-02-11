/**
 * @summary Main entry point for @fluxpointstudios/poi-sdk-feature-telemetry package.
 *
 * This package provides mechanistic interpretability telemetry for the
 * Proof-of-Intent SDK. It enables AI safety monitoring by:
 * - Extracting features from model activations via pluggable extractors
 * - Computing compact, tamper-evident activation digests (SHA-256)
 * - Recording feature snapshot artifacts for inclusion in process traces
 *
 * Key features:
 * - FeatureExtractor interface for pluggable SAE/interpretability models
 * - DefaultFeatureExtractorRegistry for extractor management
 * - MockFeatureExtractor for deterministic testing
 * - computeActivationDigest for top-K canonical hashing
 * - Safety vector utilities (merge, normalize, cosine similarity)
 * - FeatureTelemetryRecorder for end-to-end snapshot recording
 *
 * Depends on:
 * - @fluxpointstudios/poi-sdk-core (canonicalize, sha256StringHex)
 * - @fluxpointstudios/poi-sdk-process-trace (FeatureSnapshotCustomEvent alignment)
 *
 * Usage:
 * ```typescript
 * import {
 *   FeatureTelemetryRecorder,
 *   featureExtractorRegistry,
 *   MockFeatureExtractor,
 *   computeActivationDigest,
 * } from "@fluxpointstudios/poi-sdk-feature-telemetry";
 *
 * // Register an extractor
 * featureExtractorRegistry.register(new MockFeatureExtractor());
 *
 * // Record a snapshot
 * const recorder = new FeatureTelemetryRecorder(featureExtractorRegistry);
 * const artifact = await recorder.recordSnapshot("mock-extractor-v1", tokenBlock);
 * ```
 */

// ---------------------------------------------------------------------------
// Type Exports
// ---------------------------------------------------------------------------

export {
  FeatureTelemetryError,
  FeatureTelemetryException,
} from "./types.js";

export type {
  TokenBlock,
  ActivationVector,
  SafetyFeatureVector,
  ActivationDigest,
  FeatureSnapshotArtifact,
  FeatureExtractor,
  FeatureExtractorRegistry,
} from "./types.js";

// ---------------------------------------------------------------------------
// Extractor Exports
// ---------------------------------------------------------------------------

export {
  DefaultFeatureExtractorRegistry,
  featureExtractorRegistry,
} from "./extractors/extractor-registry.js";

export {
  MockFeatureExtractor,
} from "./extractors/mock-extractor.js";

export type {
  MockFeatureExtractorConfig,
} from "./extractors/mock-extractor.js";

// ---------------------------------------------------------------------------
// Digest Exports
// ---------------------------------------------------------------------------

export {
  computeActivationDigest,
} from "./digest/activation-digest.js";

export {
  mergeSafetyVectors,
  normalizeSafetyVector,
  computeVectorSimilarity,
} from "./digest/safety-vector.js";

// ---------------------------------------------------------------------------
// Recorder Exports
// ---------------------------------------------------------------------------

export {
  FeatureTelemetryRecorder,
} from "./recorder/telemetry-recorder.js";

export type {
  RecordSnapshotOptions,
} from "./recorder/telemetry-recorder.js";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Package version.
 * Updated automatically during build.
 */
export const VERSION = "0.1.0";
