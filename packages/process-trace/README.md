# Process trace verification

Use independently trusted root commitments: `verifyMerkleProof()` and
`verifyBundle()` check consistency with roots carried in their input;
`verifyDisclosure()` also compares against the roots supplied by its caller.

## What the root commits to

`rootHash` commits to the events (through the rolling hash), the span hashes
and the pinned model-manifest hash. It does not commit to the run's `id`,
`agentId`, `status`, `startedAt`, `endedAt`, `durationMs`, `metadata`,
`schemaVersion`, `nextSeq`, `nextSpanSeq` or `strict`. Authenticate those
separately when a decision depends on them.

A span hash commits to `id`, `spanSeq`, `parentSpanId`, `name`, `status`,
`visibility`, `startedAt`, `endedAt`, `durationMs`, `eventIds`, `childSpanIds`
and `metadata`. An event hash commits to every event field except `hash`.
Canonicalization drops null-valued keys, so neither hash commits to them.
`committedSpan()` and `committedEvent()` return a span or event exactly as its
hash commits to it.

## Bundles

`verifyBundle()` recomputes every event hash, span hash, the rolling hash, the
root and the Merkle root. It also requires:

- each private span to carry only the fields its hash commits to, plus `hash`;
- `privateRun.rootHash` to equal the bundle's `rootHash`;
- the public view to equal the projection of the private run that
  `createBundle()` and `finalizeTrace()` produce: the run fields, totals and
  roots, the public spans with their public events in order, and the redacted
  span hashes. Any added, dropped, reordered or altered element, extra field or
  null-valued key fails `checks.publicViewValid`. The model-manifest fields
  are bound by `checks.modelManifestValid` instead.

Because the root does not commit to the run fields, a valid bundle shows only
that the public view repeats the private run's values.

Malformed input returns `valid: false` with errors instead of throwing.

## Disclosures

`selectiveDisclose()` requires at least one span ID and no repeated IDs.

`verifyDisclosure()` rejects an empty disclosure, a repeated span ID and an
unknown mode. A full entry needs span data and an event array. The verifier
recomputes every event hash, then the span hash and leaf; the span may carry
only the fields its hash commits to, and a `hash` it carries must equal the
recomputed one. Read disclosed data from the result's `spans`, which holds
each verified span and its events (in `seq` order) exactly as committed.
`verifySpanDisclosure()` applies the same checks to one entry and returns the
committed span and events; `verifySpanInclusion()` returns only the verdict.

A membership entry carries no span data, so nothing in it binds its span ID.
It verifies only when the caller passes, from an authenticated source, that
span's Merkle leaf hash and the tree's leaf count:

```typescript
const result = await verifyDisclosure(disclosure, anchor.rootHash, anchor.merkleRoot, {
  leafHashes: { [spanId]: trustedLeafHash },
  leafCount: trustedLeafCount,
});
```

Without them, the entry fails with an `unbound: span id not authenticated`
error. With them, the proof must carry that leaf hash, use an index below the
leaf count and have a path exactly as deep as that tree, which also rules out a
root or internal node presented as a leaf.

## Merkle proofs

`generateMerkleProof()` is synchronous and computes actual SHA-256 sibling
hashes. The v1 domain prefixes and duplication of the final odd node at each
level remain unchanged. The first proof from a tree computes its levels; later
proofs from the same tree reuse them.

`verifyMerkleProof(proof)` checks that the nonnegative integer `leafIndex`
agrees with the sibling directions and path depth. V1 proofs contain no leaf
count, so on its own the proof cannot rule out a padded index past the last
leaf or an internal node presented as a leaf. `verifyMerkleProof(proof,
leafCount)` with an authenticated leaf count also requires an index below it
and a path exactly as deep as that tree.
