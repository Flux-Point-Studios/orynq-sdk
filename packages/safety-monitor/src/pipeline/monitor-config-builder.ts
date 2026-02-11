/**
 * @fileoverview Monitor config hash builder.
 *
 * Location: packages/safety-monitor/src/pipeline/monitor-config-builder.ts
 *
 * Summary:
 * Computes the monitorConfigHash from a MonitorProvenance object.
 * The hash uses domain-separated canonical JSON to produce an unforgeable
 * digest that binds the safety report to the exact monitoring configuration.
 *
 * Formula: monitorConfigHash = sha256StringHex("poi-trace:safety:v1|" + canonicalize(provenance))
 *
 * Usage:
 * Called by SafetyMonitorPipeline during analysis to compute the config hash
 * that gets embedded in alarm events and the safety report manifest.
 */

import { canonicalize, sha256StringHex } from "@fluxpointstudios/poi-sdk-core";
import { HASH_DOMAIN_PREFIXES } from "@fluxpointstudios/poi-sdk-process-trace";
import type { MonitorProvenance } from "@fluxpointstudios/poi-sdk-process-trace";

// =============================================================================
// MONITOR CONFIG BUILDER
// =============================================================================

/**
 * Builds deterministic configuration hashes from MonitorProvenance objects.
 * The hash is domain-separated and uses RFC 8785 canonical JSON to ensure
 * that identical provenance always produces the same hash.
 */
export class MonitorConfigBuilder {
  /**
   * Compute the monitorConfigHash for a given provenance object.
   *
   * @param provenance - The full monitor provenance to hash
   * @returns Hex-encoded SHA-256 hash of the domain-separated canonical provenance
   *
   * @example
   * ```typescript
   * const builder = new MonitorConfigBuilder();
   * const hash = await builder.build(provenance);
   * // hash is a 64-character hex string
   * ```
   */
  async build(provenance: MonitorProvenance): Promise<string> {
    const canonical = canonicalize(provenance as unknown as Record<string, unknown>);
    const domainPrefix = HASH_DOMAIN_PREFIXES.safety;
    const preimage = domainPrefix + canonical;
    return sha256StringHex(preimage);
  }
}
