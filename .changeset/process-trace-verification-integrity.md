---
"@fluxpointstudios/orynq-sdk-process-trace": patch
---

Recompute disclosed event hashes and require full disclosure data. Generate real
sibling hashes in synchronous Merkle proofs, computing each tree's levels once,
and validate proof indices, preserving v1 roots and odd-leaf behavior.

`verifyDisclosure()` takes optional authenticated `leafHashes` and `leafCount`.
A membership entry carries no span data, so it verifies only when both are
supplied; otherwise it fails with `unbound: span id not authenticated`. A
disclosed span may carry only the fields its hash commits to, and any `hash` it
carries must equal the recomputed one. Empty disclosures, repeated span IDs and
unknown modes fail, and `selectiveDisclose()` refuses empty or repeated span
IDs. The result's new `spans` field holds each verified span and its events as
committed; `verifySpanDisclosure()` returns the same data. `verifyMerkleProof()`
accepts an optional authenticated leaf count. Malformed disclosures and proofs
return invalid results.

`verifyBundle()` requires the public view to equal the private run's projection
(`checks.publicViewValid`) and `privateRun.rootHash` to equal the bundle root,
and rejects span fields the span hash does not commit to. Malformed bundles
return errors. `createBundle()` reports the start time as
the public end time of a run without `endedAt`. `TraceBundlePublicView` drops
the unused `redactionPolicyId` and `redactionRulesHash` fields. Export
`committedSpan()` and `committedEvent()`, and document the run fields the root
does not commit to.
