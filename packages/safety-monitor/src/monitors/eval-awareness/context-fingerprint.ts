/**
 * @fileoverview Context fingerprinting for evaluation awareness analysis.
 *
 * Location: packages/safety-monitor/src/monitors/eval-awareness/context-fingerprint.ts
 *
 * Summary:
 * Computes a deterministic fingerprint of a MonitorContext by hashing its
 * characteristic features (system prompt shape, tool list, runtime IDs).
 * This fingerprint is used to detect context-dependent behavioral shifts
 * that might indicate eval awareness.
 *
 * Usage:
 * Called by the EvalAwarenessMonitor to produce the contextFingerprintHash
 * field in EvalAwarenessCustomEvent data.
 */

import { canonicalize, sha256StringHex } from "@fluxpointstudios/poi-sdk-core";
import type { MonitorContext } from "../../types.js";

// =============================================================================
// CONTEXT FINGERPRINT
// =============================================================================

/**
 * Extract the characteristic features of a context for fingerprinting.
 * Produces a deterministic object that captures the "shape" of the
 * execution environment without including variable content.
 *
 * @param context - The monitor context to fingerprint
 * @returns A canonical-safe object of context features
 */
function extractContextFeatures(context: MonitorContext): Record<string, unknown> {
  const features: Record<string, unknown> = {};

  // Extract agent ID from the base trace
  features.agentId = context.baseTrace.agentId;

  // Extract the set of event kinds present
  const eventKinds = new Set<string>();
  for (const event of context.events) {
    eventKinds.add(event.kind);
    if (event.kind === "custom" && "eventType" in event) {
      eventKinds.add(`custom:${String(event.eventType)}`);
    }
  }
  features.eventKindSet = Array.from(eventKinds).sort();

  // Extract span names (the "tool list" shape)
  const spanNames = context.spans
    .map((s) => s.name)
    .sort();
  features.spanNameSet = spanNames;

  // Extract command names if present (tool usage fingerprint)
  const commandNames = new Set<string>();
  for (const event of context.events) {
    if (event.kind === "command" && "command" in event) {
      // Extract just the command name (not arguments) for fingerprinting
      const cmdStr = String(event.command);
      const cmdName = cmdStr.split(/\s+/)[0] ?? cmdStr;
      commandNames.add(cmdName);
    }
  }
  features.commandNameSet = Array.from(commandNames).sort();

  // Extract metadata keys (system prompt shape indicator)
  if (context.metadata) {
    features.metadataKeys = Object.keys(context.metadata).sort();
  }

  // Count features for size normalization
  features.eventCount = context.events.length;
  features.spanCount = context.spans.length;

  return features;
}

/**
 * Compute a deterministic fingerprint of a MonitorContext.
 * Uses SHA-256 over canonical JSON of the extracted context features.
 *
 * @param context - The monitor context to fingerprint
 * @returns Hex-encoded SHA-256 hash of the canonical context features
 *
 * @example
 * ```typescript
 * const fingerprint = await computeContextFingerprint(context);
 * // fingerprint is a 64-character hex string
 * ```
 */
export async function computeContextFingerprint(
  context: MonitorContext
): Promise<string> {
  const features = extractContextFeatures(context);
  const canonical = canonicalize(features);
  return sha256StringHex("poi-trace:context-fingerprint:v1|" + canonical);
}
