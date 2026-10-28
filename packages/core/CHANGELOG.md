# @fluxpointstudios/orynq-sdk-core

## 0.4.0

### Minor Changes

- 14bb540: `verifyMerkleProof(leaf, proof, root, leafCount)` requires the tree's leaf count
  from an authenticated source and the leaf's `index`, which
  `merkleInclusionProof` now returns in the proof. The siblings must follow
  exactly the path for that index in a tree of that many leaves, so the root or an
  internal node no longer passes as a leaf, except the root of a one-leaf tree.
  Every hash must be lowercase SHA-256 hex, with or without `0x`, and malformed
  input returns false instead of throwing. anchors-materios re-exports both
  functions.

## 0.3.2

### Patch Changes

- ffa932e: Require Cardano checkpoint wallet pins to name an encoding and inclusive absolute-slot window. Export bounded reviewed historical pins; bare addresses and records outside their windows are refused. Detect repeated Koios pagination, distinguish the checkpoint commitment genesis in diagnostics, and rebuild historical dcbor certificates using their explicit supported certificate domain.

  Correct checkpoint smoke documentation: label 8746 stores root, manifest, range and an integer leaf count, while receipt membership proofs are off chain. Cardano checkpoint probes default to mainnet. Keep source-trust and confirmation-depth assumptions explicit.

## 0.3.1

### Changes

- Share receipt checkpoint primitives between the SDK and hosted anchoring through the `checkpoint` subpath: strict SCALE receipt decoding, certificate format detection, deterministic census batches, shape-bound Merkle paths and bounded member snapshots.
- Share deterministic batch-set commitments for finalized Midnight receipt batches.
