---
"@fluxpointstudios/orynq-sdk-midnight-prover": patch
---

Prototype conduct verdict circuits ship as Compact sources under
`circuits/conduct`, with `scripts/compile-conduct.mjs` and their tests. The
package entry does not export them. They are undeployed and their ABI is
unfrozen. `build:circuits` now also compiles them and requires their committed
pins to reproduce.
