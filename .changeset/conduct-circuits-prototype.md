---
"@fluxpointstudios/orynq-sdk-midnight-prover": patch
---

Prototype conduct circuits ship as Compact sources under `circuits/conduct`,
with `scripts/compile-conduct.mjs`, which rebuilds them from the published
files and checks their pins. They hold the conduct verdict, and openings of
process-trace guard events and conduct mandate CBOR in exact-length classes,
generated from one guard-event template through `scripts/conduct/template.mjs`.
Their tests ship under `tests/conduct` and run inside the workspace, which
holds the conduct fixtures they read, through `vitest.conduct.config.mts`. The
package entry does not export the circuits. They are undeployed and their ABI
is unfrozen. The new `build:conduct` script compiles them and requires the
committed generated circuits and pins to reproduce. `circuits/conduct/reference` holds PoAC's archived verdict core,
which ships only as the tests' explicit-time oracle and is never deployed.
