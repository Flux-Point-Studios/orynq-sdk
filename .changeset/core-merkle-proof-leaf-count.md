---
"@fluxpointstudios/orynq-sdk-core": minor
"@fluxpointstudios/orynq-sdk-anchors-materios": minor
---

`verifyMerkleProof(leaf, proof, root, leafCount)` requires the tree's leaf count
from an authenticated source and the leaf's `index`, which
`merkleInclusionProof` now returns in the proof. The siblings must follow
exactly the path for that index in a tree of that many leaves, so the root or an
internal node no longer passes as a leaf, except the root of a one-leaf tree.
Every hash must be lowercase SHA-256 hex, with or without `0x`, and malformed
input returns false instead of throwing. anchors-materios re-exports both
functions.
