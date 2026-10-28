---
"@fluxpointstudios/orynq-sdk-flight-recorder": patch
---

`verifyMerkleProof(proof, leafCount)` requires the tree's leaf count from an
authenticated source and returns false without one. The proof must follow
exactly the path `generateMerkleProof` gives its `leafIndex` in a tree of that
many leaves, so the root or an internal node no longer passes as a leaf except
the root of a one-leaf tree. Every hash must be lowercase SHA-256 hex, and
malformed proofs return false instead of throwing.
