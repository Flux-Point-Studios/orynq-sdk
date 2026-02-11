/**
 * @fileoverview Default feature extractor registry implementation.
 *
 * Location: packages/feature-telemetry/src/extractors/extractor-registry.ts
 *
 * Provides a Map-based registry for FeatureExtractor instances. The registry
 * allows extractors to be registered by their unique extractorId and retrieved
 * at extraction time by the telemetry recorder.
 *
 * A global singleton (featureExtractorRegistry) is exported for convenience,
 * but the class can also be instantiated directly for isolated testing or
 * multi-registry scenarios.
 *
 * Used by:
 * - src/recorder/telemetry-recorder.ts (looks up extractors by ID)
 * - Consumer code (registers extractors at startup)
 * - src/__tests__/feature-telemetry.test.ts (tests registry operations)
 */

import {
  FeatureTelemetryError,
  FeatureTelemetryException,
} from "../types.js";
import type {
  FeatureExtractor,
  FeatureExtractorRegistry,
} from "../types.js";

// =============================================================================
// DEFAULT REGISTRY IMPLEMENTATION
// =============================================================================

/**
 * Default Map-based implementation of FeatureExtractorRegistry.
 *
 * Thread-safe for single-threaded JavaScript environments.
 * Each extractor is keyed by its extractorId; duplicate registrations
 * are rejected with EXTRACTOR_REGISTRATION_FAILED.
 */
export class DefaultFeatureExtractorRegistry implements FeatureExtractorRegistry {
  private readonly extractors = new Map<string, FeatureExtractor>();

  /**
   * Register a feature extractor in the registry.
   *
   * @param extractor - The extractor to register
   * @throws FeatureTelemetryException with EXTRACTOR_REGISTRATION_FAILED if an extractor
   *         with the same extractorId is already registered
   */
  register(extractor: FeatureExtractor): void {
    if (this.extractors.has(extractor.extractorId)) {
      throw new FeatureTelemetryException(
        FeatureTelemetryError.EXTRACTOR_REGISTRATION_FAILED,
        `Feature extractor with ID "${extractor.extractorId}" is already registered`,
      );
    }
    this.extractors.set(extractor.extractorId, extractor);
  }

  /**
   * Get a feature extractor by its ID.
   *
   * @param extractorId - The extractor ID to look up
   * @returns The matching FeatureExtractor, or undefined if not found
   */
  get(extractorId: string): FeatureExtractor | undefined {
    return this.extractors.get(extractorId);
  }

  /**
   * List all registered extractor IDs.
   *
   * @returns Array of registered extractor ID strings, in insertion order
   */
  list(): string[] {
    return Array.from(this.extractors.keys());
  }

  /**
   * Check if an extractor with the given ID is registered.
   *
   * @param extractorId - The extractor ID to check
   * @returns true if the extractor is registered
   */
  has(extractorId: string): boolean {
    return this.extractors.has(extractorId);
  }
}

// =============================================================================
// GLOBAL SINGLETON
// =============================================================================

/**
 * Global singleton feature extractor registry.
 *
 * Consumers can register extractors at application startup and the telemetry
 * recorder will look them up by ID at extraction time.
 *
 * @example
 * ```typescript
 * import { featureExtractorRegistry } from "@fluxpointstudios/poi-sdk-feature-telemetry";
 * import { MySAEExtractor } from "./my-sae-extractor";
 *
 * featureExtractorRegistry.register(new MySAEExtractor());
 * ```
 */
export const featureExtractorRegistry: FeatureExtractorRegistry =
  new DefaultFeatureExtractorRegistry();
