# @fluxpointstudios/orynq-mcp

## 0.7.1

### Patch Changes

- Updated dependencies [390169a]
- Updated dependencies [14bb540]
- Updated dependencies [14bb540]
- Updated dependencies [655c2df]
- Updated dependencies [14bb540]
- Updated dependencies [ab2e261]
  - @fluxpointstudios/orynq-sdk-anchors-cardano@0.5.1
  - @fluxpointstudios/orynq-sdk-core@0.4.0
  - @fluxpointstudios/orynq-sdk-anchors-materios@0.7.0
  - @fluxpointstudios/orynq-sdk-process-trace@0.4.0

## 0.7.0

### Minor Changes

- 8678293: Add read-only hosted Midnight receipt verification with caller-bound identities, explicit proof endpoints and bounded resumable discovery. Unresolved hints never establish absence or coverage.
- 95e1f75: Reject duplicate policy JSON members, bind signing to an explicit parsed review, and require authenticated predecessor evidence for appended checkpoints. Label discovery as indexer-reported with author-window status, bound verifier diagnostics, suppress malformed source fields/RPC error bodies, and reject credential-bearing source URLs. CLI bundle errors no longer quote file contents; MCP author trust comes exclusively from the server policy.
- d9dd9dd: Upgrade to patched Zod 4 and preserve arbitrary string-keyed trace, span and event metadata through the MCP tool schemas.

### Patch Changes

- ad36425: The optional peer `@fluxpointstudios/orynq-sdk-anchors-midnight` is published on npm, pinned to Midnight mainnet registry generation 1. When it is missing, `verify_midnight_anchor` and the Midnight commands say to install it beside the package instead of pointing to a source checkout.
- 8373932: Return and print the exact uploaded content hash, submitted chunk Merkle root and full certificate hash needed for receipt verification. Distinguish trace roots in CLI output, derive the CLI version from package metadata, and fix MCP dry-run and submission identities for single- and multi-chunk blobs.
- Updated dependencies [b7caae1]
- Updated dependencies [ffa932e]
- Updated dependencies [d4880f0]
  - @fluxpointstudios/orynq-sdk-anchors-cardano@0.5.0
  - @fluxpointstudios/orynq-sdk-core@0.3.2
  - @fluxpointstudios/orynq-sdk-process-trace@0.3.1

## 0.4.0

### Minor Changes

- d08a00e: Add the read-only `verify_midnight_anchor` MCP tool and the `orynq verify midnight`, `orynq keys init midnight`, and `orynq anchor midnight` CLI commands. These prerelease surfaces require the optional anchors-midnight peer, which remains private and unavailable on npm until the D-10 release gate opens. Use a built orynq-sdk source checkout as documented in each package README; npm-only installs report this requirement without breaking other tools or commands. No Midnight submitter is published.

  Keep private Midnight minor releases from forcing major releases of MCP and quickstart.

### Patch Changes

- 4933586: Add genuine Compact capability and rolling-digest proofs with a pinned native ledger verifier. Each proof carries a proved deadline at most one hour ahead, which a rewritten transaction TTL cannot extend. Verification binds public outputs to the expected statement and refuses untrusted keys, altered ledger parameters, malformed transactions and simulations. Existing mock APIs require explicit simulation mode and cannot provide production proof or publication claims.

  Require an MCP SDK version containing the OAuth credential handling fix.

## 0.3.1

### Patch Changes

- Updated dependencies [a918a40]
- Updated dependencies [41f315b]
  - @fluxpointstudios/orynq-sdk-anchors-cardano@0.4.0
  - @fluxpointstudios/orynq-sdk-anchors-materios@0.6.0

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

### Patch Changes

- Updated dependencies [48f2049]
- Updated dependencies [48f2049]
- Updated dependencies [48f2049]
- Updated dependencies [3cd6027]
- Updated dependencies [2efef73]
- Updated dependencies [48f2049]
  - @fluxpointstudios/orynq-sdk-anchors-cardano@0.3.0
  - @fluxpointstudios/orynq-sdk-process-trace@0.3.0
  - @fluxpointstudios/orynq-sdk-anchors-materios@0.5.0

## 0.2.0

### Minor Changes

- c4186c6: Add orynq-mcp package — MCP server exposing 10 tools for process tracing, Cardano anchoring, and verification
