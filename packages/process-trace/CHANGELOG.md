# @fluxpointstudios/orynq-sdk-process-trace

## 0.4.0

### Minor Changes

- 14bb540: `addEvent()` appends to a run one call at a time, in call order: concurrent
  calls on one run left a rolling hash that chained only the last event. An event
  the run cannot take changes nothing and leaves no gap in `seq`: one that cannot
  be hashed, or whose span closes or run is finalized before it is appended, is
  refused.

  `verifyRollingHash()` requires the events' `seq` values to be exactly 0 to
  n - 1, so a list that leaves out events no longer verifies against a chain over
  fewer events than the run holds.

  `verifyDisclosure()` and `verifySpanDisclosure()` read only the options' own
  properties, so a `leafHashes` or `leafCount` inherited from a polluted
  `Object.prototype` authenticates nothing.

  Trace hashing computes SHA-256 synchronously instead of awaiting a Web Crypto
  digest for each event, span and Merkle node. Every hash is unchanged.

- ab2e261: Recompute disclosed event hashes and require full disclosure data. Generate real
  sibling hashes in synchronous Merkle proofs, computing each tree's levels once,
  and validate proof indices, preserving v1 roots and odd-leaf behavior.

  `verifyDisclosure()` takes optional authenticated `leafHashes` and `leafCount`.
  A membership entry carries no span data, so it verifies only when both are
  supplied; otherwise it fails with `unbound: span id not authenticated`. A full
  entry whose span ID `leafHashes` lists must hash to that leaf. A disclosed span
  may carry only the fields its hash commits to, and any `hash` it carries must
  equal the recomputed one. Empty disclosures, repeated span IDs, event IDs
  disclosed twice and unknown modes fail, and `selectiveDisclose()` refuses empty
  or repeated span IDs. The result's new `spans` field holds each verified span
  and its events as committed; `verifySpanDisclosure()` returns the same data.
  `verifyDisclosure()`, `verifySpanDisclosure()` and `verifySpanInclusion()` read
  their input once, as JSON data, before any check, so later changes, getters and
  proxies cannot reach the result. `verifyMerkleProof()` accepts an optional
  authenticated leaf count. Malformed disclosures and proofs return invalid
  results.

  `verifyBundle()` requires the public view to equal the private run's projection
  (`checks.publicViewValid`), with redacted span hashes compared in any order and,
  for a run without `endedAt`, a public end time that is absent or no earlier than
  the start, so bundles from earlier releases, any locale and the Python SDK keep
  verifying. It requires `privateRun.rootHash` to equal the bundle root and
  top-level `modelManifestHash` and `modelManifest` to equal the committed run's,
  and rejects span fields the span hash does not commit to, repeated span or
  event IDs and event IDs listed twice in `eventIds`. Malformed bundles return
  errors.

  Behavior changes: the public view sorts redacted span hashes by the UTF-16 code
  units of their span IDs instead of the host locale's collation, and
  `createBundle()` reports the start time as the public end time of a run without
  `endedAt`. `TraceBundlePublicView.redactionPolicyId` and `redactionRulesHash`
  are deprecated and typed `never`: no producer set them, and a public view that
  carries them fails verification, so code reading them still compiles and code
  setting them no longer does. EIP-712 governance type matching no longer
  consults the host collation. Export `committedSpan()` and `committedEvent()`,
  and document the run fields the root does not commit to.

### Patch Changes

- Updated dependencies [14bb540]
  - @fluxpointstudios/orynq-sdk-core@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [ffa932e]
  - @fluxpointstudios/orynq-sdk-core@0.3.2

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
