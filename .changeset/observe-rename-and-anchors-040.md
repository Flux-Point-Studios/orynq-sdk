---
"@fluxpointstudios/orynq-sdk-anchors-materios": minor
---

Expose canonical CBOR helpers + `AiCapabilityObservationV1` type for downstream observe SDK. New named exports from the package entry point:

- `canonicalCborPreImageAiCapabilityObservationV1`
- `canonicalContentHashAiCapabilityObservationV1`
- `validateAiCapabilityObservationV1`
- `AI_CAPABILITY_OBSERVATION_V1_SCHEMA_HASH_HEX`
- `AI_CAPABILITY_OBSERVATION_V1_SCHEMA_VERSION`
- `AI_CAPABILITY_OBSERVATION_V1_MAX_CONTEXT_LEN`
- `SEVERITIES`, `TEE_TIERS`
- types: `AiCapabilityObservationV1`, `ModelV1`, `CapabilityV1`, `ObservationV1`, `TeeAttestationV1`, `ObserverV1`, `TeeTier`, `Severity`

Additive — no existing API is removed or renamed.
