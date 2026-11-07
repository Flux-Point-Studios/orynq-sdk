---
"@fluxpointstudios/orynq-sdk-anchors-midnight": patch
"@fluxpointstudios/orynq-sdk-midnight-prover": patch
---

Depend on ledger 8 as `@midnightntwrk/ledger-v8` 8.1.3, the scope Midnight's
wallet-sdk 2.0.0 depends on, so that one ledger 8 module serves the anchors
packages and the wallet. The published package is the same code as
`@midnight-ntwrk/ledger-v8` 8.1.3: the two tarballs differ only in the
`name` field of `package.json`. The ZKIR prover devDependency and dependency
move to `@midnightntwrk/zkir-v2` 2.2.0, the version wallet-sdk 2.0.0 pins.
