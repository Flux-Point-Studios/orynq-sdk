# @fluxpointstudios/orynq-sdk-flight-recorder

## 0.2.0

### Minor Changes

- 612bca2: `verifyMerkleProof(proof, leafCount)` requires the tree's leaf count from an
  authenticated source and returns false without one. The proof must follow
  exactly the path `generateMerkleProof` gives its `leafIndex` in a tree of that
  many leaves, so the root or an internal node no longer passes as a leaf except
  the root of a one-leaf tree. Every hash must be lowercase SHA-256 hex, and
  malformed proofs return false instead of throwing.

### Patch Changes

- Updated dependencies [ab2e261]
  - @fluxpointstudios/orynq-sdk-process-trace@0.4.0

## 0.1.2

### Patch Changes

- Updated dependencies [ffa932e]
  - @fluxpointstudios/orynq-sdk-core@0.3.2
  - @fluxpointstudios/orynq-sdk-process-trace@0.3.1

## 0.1.1

### Patch Changes

- Updated dependencies [48f2049]
- Updated dependencies [48f2049]
- Updated dependencies [2efef73]
- Updated dependencies [48f2049]
  - @fluxpointstudios/orynq-sdk-process-trace@0.3.0
