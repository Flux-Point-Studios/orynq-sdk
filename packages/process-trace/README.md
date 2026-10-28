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

## Building traces

`addEvent()` calls on one run append one at a time, in call order, so events
added concurrently all chain into the rolling hash. An event the run cannot
take changes nothing: one that cannot be hashed, or whose span closes or run is
finalized before it is appended, is refused.

`verifyRollingHash(events, expectedHash)` requires the events' `seq` values to
be exactly 0 to n - 1, in any order: a list that leaves out events, matching a
chain stored over fewer events than the run holds, never verifies.

## Bundles

`verifyBundle()` recomputes every event hash, span hash, the rolling hash, the
root and the Merkle root. It also requires:

- each private span to carry only the fields its hash commits to, plus `hash`;
- no two spans or events to share an ID, and no event ID to appear twice in
  the spans' `eventIds` (`checks.sequenceValid`);
- `privateRun.rootHash` to equal the bundle's `rootHash`;
- the public view to equal the projection of the private run that
  `createBundle()` and `finalizeTrace()` produce: the run fields, totals and
  roots, the public spans with their public events in order, and the redacted
  span hashes. Any added, dropped, reordered or altered element, extra field or
  null-valued key fails `checks.publicViewValid`, with two exceptions for what
  earlier releases produced. Redacted span hashes may come in any order: they
  were sorted with the producer's locale, and are now sorted by the UTF-16 code
  units of their span IDs. For a run without an end time, the public end time
  may be absent or any timestamp from the run's start: `createBundle()` used to
  report the time it made the bundle and now reports the start time. The
  model-manifest fields are bound by `checks.modelManifestValid` instead;
- a top-level `modelManifestHash` or `modelManifest`, which `finalizeTrace()`
  copies there, to equal the committed run's (`checks.modelManifestValid`).
  Read the commitment from `privateRun.modelManifestHash`.

Because the root does not commit to the run fields, a valid bundle shows only
that the public view repeats the private run's values.

`TraceBundlePublicView` keeps `redactionPolicyId` and `redactionRulesHash`
only as deprecated, never-set fields: no hash commits to them, so a public view
that carries them fails verification.

Malformed input returns `valid: false` with errors instead of throwing.

## Disclosures

`selectiveDisclose()` requires at least one span ID and no repeated IDs.

`verifyDisclosure()` rejects an empty disclosure, a repeated span ID, an event
ID disclosed twice and an unknown mode. It reads the disclosure once, as JSON
data, before any check, so later changes to the object, getters and proxies
cannot reach the result; input JSON cannot hold, such as a bigint, fails. A
full entry needs span data and an event array. The verifier recomputes every
event hash, then the span hash and leaf; the span may carry only the fields
its hash commits to, and a `hash` it carries must equal the recomputed one.
When `options.leafHashes` lists the entry's span ID, the leaf must be that one:
a span ID that two committed spans share then names only the authenticated
span. Read disclosed data from the result's `spans`, which holds each verified
span and its events (in `seq` order) exactly as committed.
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
root or internal node presented as a leaf. Only the options' own properties
count, and only span IDs `leafHashes` lists as its own keys: nothing inherited,
as from a polluted `Object.prototype`, authenticates a span.

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
