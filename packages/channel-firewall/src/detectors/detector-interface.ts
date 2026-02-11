/**
 * @fileoverview Channel detector registry for managing detector instances.
 *
 * Location: packages/channel-firewall/src/detectors/detector-interface.ts
 *
 * This file provides a Map-based registry for ChannelDetector instances,
 * following the same registry pattern used across the poi-sdk monorepo.
 * A singleton instance is exported for convenience.
 *
 * Used by:
 * - ChannelFirewall to look up configured detectors
 * - Consumers who want to register custom detectors
 * - Built-in detectors register themselves via this registry
 */

import type { ChannelDetector } from "../types.js";
import {
  ChannelFirewallError,
  ChannelFirewallException,
} from "../types.js";

// =============================================================================
// DETECTOR REGISTRY
// =============================================================================

/**
 * Registry for managing ChannelDetector instances.
 *
 * Detectors are stored by their detectorId. Attempting to register a detector
 * with a duplicate ID throws a DETECTOR_REGISTRATION_FAILED error.
 *
 * @example
 * ```typescript
 * import { channelDetectorRegistry } from "@fluxpointstudios/poi-sdk-channel-firewall";
 *
 * channelDetectorRegistry.register(new StatisticalDetector());
 * const detector = channelDetectorRegistry.get("statistical");
 * ```
 */
export class ChannelDetectorRegistry {
  private readonly detectors = new Map<string, ChannelDetector>();

  /**
   * Register a detector in the registry.
   *
   * @param detector - The detector to register
   * @throws ChannelFirewallException with DETECTOR_REGISTRATION_FAILED if a detector
   *         with the same detectorId is already registered
   */
  register(detector: ChannelDetector): void {
    if (this.detectors.has(detector.detectorId)) {
      throw new ChannelFirewallException(
        ChannelFirewallError.DETECTOR_REGISTRATION_FAILED,
        `Detector with ID "${detector.detectorId}" is already registered`,
      );
    }
    this.detectors.set(detector.detectorId, detector);
  }

  /**
   * Retrieve a detector by its ID.
   *
   * @param detectorId - The ID of the detector to retrieve
   * @returns The detector, or undefined if not found
   */
  get(detectorId: string): ChannelDetector | undefined {
    return this.detectors.get(detectorId);
  }

  /**
   * List all registered detector IDs.
   *
   * @returns Array of registered detector IDs
   */
  list(): string[] {
    return Array.from(this.detectors.keys());
  }

  /**
   * Check if a detector is registered.
   *
   * @param detectorId - The ID to check
   * @returns true if a detector with the given ID is registered
   */
  has(detectorId: string): boolean {
    return this.detectors.has(detectorId);
  }

  /**
   * Remove a detector from the registry.
   *
   * @param detectorId - The ID of the detector to remove
   * @returns true if the detector was removed, false if it was not found
   */
  remove(detectorId: string): boolean {
    return this.detectors.delete(detectorId);
  }

  /**
   * Remove all detectors from the registry.
   */
  clear(): void {
    this.detectors.clear();
  }
}

/**
 * Singleton detector registry instance.
 * Use this for application-wide detector management.
 */
export const channelDetectorRegistry = new ChannelDetectorRegistry();
