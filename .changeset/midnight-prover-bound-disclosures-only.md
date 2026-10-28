---
"@fluxpointstudios/orynq-sdk-midnight-prover": minor
---

`SelectiveDisclosureProver.verifyProof` returns true only for a full disclosure
whose span and events hash to the public span hash, or a membership proof that
discloses no data. A proof made with `includeEventData: false` or
`includeSpanData: false` never verifies, even with authenticated leaves: nothing
binds its disclosed data, so `verifyDisclosure` reports `unbound: true`, names
the authenticated span its Merkle path proves and returns none of that data.
Read disclosed data from `verifyDisclosure`'s result, never from
`proof.disclosedSpan` or `proof.disclosedEvents`.

`verifyDisclosure` and `verifyProof` take the anchored tree's Merkle root as
`expectedMerkleRoot`, which the proof's public Merkle root must equal, and
refuse `leafHashes` or `leafCount` without it, so a full disclosure from another
tree of the same depth no longer passes as bound to the caller's tree. Only the
options' own properties count.
