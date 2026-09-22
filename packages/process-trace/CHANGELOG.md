# @fluxpointstudios/orynq-sdk-process-trace

## 0.3.0

### Minor Changes

- 48f2049: Add a first-class `governance-attestation` event kind (#58) so traces can encode
  _who governed a decision_ in a standard, verifiable way.

  - New `GovernanceAttestationEvent` in the process-trace event union.
  - `addGovernanceAttestation()` helper + built-in `createSr25519GovernanceSigner` /
    `createEd25519GovernanceSigner` (via the optional `@polkadot/util-crypto` peer
    dependency, loaded with a dynamic import so base installs stay lean).
  - `verifyGovernanceAttestations()` returns a verified `(role, attestor, scheme,
verified)` summary; `eip712` is supported via a pluggable
    `createEip712GovernanceVerifier` (inject viem's `verifyTypedData`).
  - `verifyBundle(bundle, { governance: true })` folds governance verification into
    the bundle result (`checks.governanceValid`).
  - The `trace_summary` MCP tool now surfaces governance attestations distinctly.

  Additive — existing API is unchanged.

- 48f2049: Add pre-execution model-manifest pinning (#59) so a trace can prove "neither the
  data nor the model was altered over the run".

  - `createTrace({ manifest, strict })` pins a `ModelManifest` hash _before_
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

- 2efef73: The OpenClaw recorder anchors each bundle once and reports the outcome truthfully.

  `@fluxpointstudios/orynq-sdk-recorder-openclaw`:

  - Dedup keys on the content that is anchored, so an unchanged bundle is never re-posted. 0.2.0 re-posted every bundle on every cycle.
  - A receipt reads `anchored: true` only after the anchor is confirmed. An accepted request is `submitted` and is polled by its requestId, never re-posted on a timer. Only the server's own `anchor_request_not_found` justifies a re-post.
  - Failures retry with jittered exponential backoff capped at 24 hours.
  - Network calls have deadlines that cover the response body, the anchor schedule survives restarts, and one bundle's failure no longer stops the others. A torn spool line costs only that line.

  `@fluxpointstudios/orynq-openclaw`: depends on the fixed recorder with a caret range.

  `@fluxpointstudios/orynq-sdk-process-trace`: the version floor moves to 0.2.0 because npm already holds a 0.2.0 built in February, so this release publishes as 0.3.0 instead of colliding with it.

- 48f2049: Add verifiable tool-call receipts (#60) so a trace can prove "the tool actually
  returned this response", not just "the agent says it did".

  - New `tool-receipt` event kind in process-trace.
  - New package `@fluxpointstudios/orynq-sdk-tool-receipts` with verifiers for RFC
    9421 HTTP Message Signatures, Stripe/GitHub webhook signatures, and generic JWS;
    `verifyToolReceipts()` + a `verifyTrace()` wrapper that folds receipt checks into
    `verifyBundle()` (`checks.toolReceiptsValid`).
  - `addToolReceipt()` / `hashToolPayload()` recording helpers.
  - `createSigningProxy()` — the "anti-lie" pattern for wrapping tools that don't
    sign their responses natively (see `docs/anti-lie-tool-receipts.md`).
  - The `trace_summary` MCP tool surfaces tool receipts distinctly.

  Additive — existing API is unchanged.
