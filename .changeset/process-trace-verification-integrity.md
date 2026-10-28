---
"@fluxpointstudios/orynq-sdk-process-trace": minor
---

Recompute disclosed event hashes and require full disclosure data. Generate real
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
