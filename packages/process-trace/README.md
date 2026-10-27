# Process trace verification

`verifyBundle()` recomputes private event and span hashes and checks disclosed
public event bodies and span headers against that committed run.

`verifyDisclosure()` requires both span data and an event array in full mode.
Whenever bodies are supplied, it recomputes event hashes before checking the span
commitment. `verifySpanDisclosure()` and `verifySpanInclusion()` apply the same
event-body checks. Missing hashes and mismatches fail verification.

`generateMerkleProof()` is synchronous and computes actual SHA-256 sibling hashes.
The v1 domain prefixes and duplication of the final odd node at each level remain
unchanged. `verifyMerkleProof()` checks that the nonnegative integer `leafIndex`
agrees with the sibling directions and path depth. V1 proofs contain no leaf
count, so they cannot authenticate the original count or distinguish odd-node
padding from another identical leaf.

Use independently trusted root commitments: `verifyMerkleProof()` and
`verifyBundle()` check consistency with roots carried in their input;
`verifyDisclosure()` also compares against the roots supplied by its caller.
