---
"@fluxpointstudios/orynq-sdk-anchors-midnight": minor
"@fluxpointstudios/orynq-sdk-midnight-prover": minor
---

Depend on ledger 8 as `@midnightntwrk/ledger-v8` 8.1.3 instead of
`@midnight-ntwrk/ledger-v8`, the scope Midnight's wallet-sdk 2.0.0 depends on,
so that one ledger 8 module serves the anchors packages and the wallet. The
published package is the same code as `@midnight-ntwrk/ledger-v8` 8.1.3: the
two tarballs differ only in the `name` field of `package.json`.

This breaks consumers that pass ledger 8 objects in. Both packages take and
return ledger 8 objects: contract states, transactions, operations and
parameters. For example, midnight-prover's `buildProofCall`, the on-chain
proof builders and `post` take them, as do anchors-midnight's
`unprovenRegistryCall` and `registryState`. An object made by the other scope's
module is a different class, so it is refused (for example, "expected
instance of ContractOperation"). Consumers must import ledger 8 from
`@midnightntwrk/ledger-v8` 8.1.3.

The ZKIR prover devDependency and dependency move to `@midnightntwrk/zkir-v2`
2.2.0, the version wallet-sdk 2.0.0 pins.
