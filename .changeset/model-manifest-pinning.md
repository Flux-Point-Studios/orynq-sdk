---
"@fluxpointstudios/orynq-sdk-process-trace": minor
"@fluxpointstudios/orynq-mcp": minor
---

Add pre-execution model-manifest pinning (#59) so a trace can prove "neither the
data nor the model was altered over the run".

- `createTrace({ manifest, strict })` pins a `ModelManifest` hash *before*
  execution and deep-freezes the manifest (mutation throws).
- `finalizeTrace()` enforces the pin under strict mode and warns (warn-only) when
  unpinned; `bundle.modelManifestHash` / `bundle.modelManifest` carry the
  commitment (public-safe).
- Deterministic framework builders: `manifestFromHuggingFace`, `manifestFromOpenAI`,
  `manifestFromAnthropic`, `manifestFromCheckpoint`.
- `trace_summary` MCP tool surfaces the pinned manifest.

Default is warn-only for v0.x; strict-by-default is planned for v1.0 (see
`docs/model-manifest-pinning.md` for the migration guide + breaking-change note).
Additive — existing API is unchanged.
