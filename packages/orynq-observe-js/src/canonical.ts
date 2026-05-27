/**
 * Canonical CBOR encoder for the ai_capability_observation_v1 schema.
 *
 * Thin re-export over the canonical codec in
 * `@fluxpointstudios/orynq-sdk-anchors-materios`. The SDK owns no encoder
 * bytes — every receipt the SDK signs is encoded by the same code path that
 * downstream verifiers (cert-daemon committee, anchor-worker) replay locally.
 *
 * The canonical schema spec, pre-image rules (RFC 8949 §4.2.1 sorted maps,
 * shortest-head ints, byte-strings for hashes/evidence, CBOR null for absent
 * sub-trees), and validator all live in the schema package.
 */

import {
  type AiCapabilityObservationV1,
  AI_CAPABILITY_OBSERVATION_V1_SCHEMA_HASH_HEX,
  AI_CAPABILITY_OBSERVATION_V1_SCHEMA_VERSION,
  SEVERITIES as SCHEMA_SEVERITIES,
  TEE_TIERS as SCHEMA_TEE_TIERS,
  canonicalCborPreImageAiCapabilityObservationV1,
  canonicalContentHashAiCapabilityObservationV1,
  type Severity as SchemaSeverity,
  type TeeTier as SchemaTeeTier,
} from "@fluxpointstudios/orynq-sdk-anchors-materios";

export const SCHEMA_VERSION = AI_CAPABILITY_OBSERVATION_V1_SCHEMA_VERSION;
export const SCHEMA_HASH_HEX = AI_CAPABILITY_OBSERVATION_V1_SCHEMA_HASH_HEX;
export const SEVERITIES = SCHEMA_SEVERITIES;
export const TEE_TIERS = SCHEMA_TEE_TIERS;

export type Severity = SchemaSeverity;
export type TeeTier = SchemaTeeTier;
export type AiCapabilityObservationRecord = AiCapabilityObservationV1;

export function canonicalCbor(
  record: AiCapabilityObservationRecord,
): Uint8Array {
  return canonicalCborPreImageAiCapabilityObservationV1(record);
}

export function canonicalContentHash(
  record: AiCapabilityObservationRecord,
): string {
  return canonicalContentHashAiCapabilityObservationV1(record);
}
