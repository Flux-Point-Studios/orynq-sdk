---
"@fluxpointstudios/orynq-sdk-anchors-cardano": minor
"@fluxpointstudios/orynq-sdk-core": patch
---

Require Cardano checkpoint wallet pins to name an encoding and inclusive absolute-slot window. Export bounded reviewed historical pins; bare addresses and records outside their windows are refused. Detect repeated Koios pagination, distinguish the checkpoint commitment genesis in diagnostics, and rebuild historical dcbor certificates using their explicit supported certificate domain.

Correct checkpoint smoke documentation: label 8746 stores root, manifest, range and an integer leaf count, while receipt membership proofs are off chain. Cardano checkpoint probes default to mainnet. Keep source-trust and confirmation-depth assumptions explicit.
