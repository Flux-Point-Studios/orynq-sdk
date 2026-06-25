---
"@fluxpointstudios/orynq-sdk-process-trace": minor
"@fluxpointstudios/orynq-mcp": minor
---

Add a first-class `governance-attestation` event kind (#58) so traces can encode
*who governed a decision* in a standard, verifiable way.

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
