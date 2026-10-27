# @fluxpointstudios/orynq-sdk-core

## 0.3.2

### Patch Changes

- ffa932e: Require Cardano checkpoint wallet pins to name an encoding and inclusive absolute-slot window. Export bounded reviewed historical pins; bare addresses and records outside their windows are refused. Detect repeated Koios pagination, distinguish the checkpoint commitment genesis in diagnostics, and rebuild historical dcbor certificates using their explicit supported certificate domain.

  Correct checkpoint smoke documentation: label 8746 stores root, manifest, range and an integer leaf count, while receipt membership proofs are off chain. Cardano checkpoint probes default to mainnet. Keep source-trust and confirmation-depth assumptions explicit.

## 0.3.1

### Changes

- Share receipt checkpoint primitives between the SDK and hosted anchoring through the `checkpoint` subpath: strict SCALE receipt decoding, certificate format detection, deterministic census batches, shape-bound Merkle paths and bounded member snapshots.
- Share deterministic batch-set commitments for finalized Midnight receipt batches.
