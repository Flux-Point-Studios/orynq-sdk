---
"@fluxpointstudios/orynq-sdk-midnight-prover": patch
---

Prototype conduct verdict circuits ship as Compact sources under
`circuits/conduct`, with `scripts/compile-conduct.mjs`, which rebuilds them from
the published files and checks their pins. Their tests ship under
`tests/conduct` and run inside the workspace, which holds the conduct fixtures
they read. The package entry does not export the circuits. They are undeployed
and their ABI is unfrozen. `build:circuits` now also compiles them and requires
their committed pins to reproduce.
