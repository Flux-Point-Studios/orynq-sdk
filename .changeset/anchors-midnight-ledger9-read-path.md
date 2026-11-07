---
"@fluxpointstudios/orynq-sdk-anchors-midnight": minor
---

Read Midnight mainnet across the Ledger 9 runtime upgrade. Block 3346138 carries
`set_code`; 3346139 is the first block runtime 2001100 executes.

- Execution verification selects the executing runtime from the parent state:
  its `:pending_code` when present, its `:code` otherwise, both from one
  strict-extension read proof. The absence of `:pending_code` must be proven by
  the nodes on its path; a witness that leaves that path is refused. Events
  decode under the SHA256-pinned metadata of runtime 1000300 or 2001100, chosen
  by the executing code hash. Any other code hash is refused.
- `provedEntry` returns a storage value or `null` when the proof shows no value
  at the key.
- Transactions and contract states are read with the ledger their header tag
  names: `transaction[v9]` and `contract-state[v6]` with ledger 8,
  `transaction[v12]` and `contract-state[v8]` with ledger 9
  (`@midnightntwrk/ledger-v9` 1.0.0). Any other tag is refused.
  `registryVerifierKeysIn` reads the registry's verifier key hashes from either
  state, and the verifier checks indexer and node states through it.
- `KNOWN_RUNTIME_SPEC_VERSIONS` is `[1000300, 2001100]`.
- Breaking: `RegistryInfo.runtimeSpecVersion` is replaced by `runtimes`, a list of
  `{ specVersion, fromHeight, toHeight }` spans that run contiguously from the
  deploy height and end with one open span. Generation 1 on mainnet runs 1000300
  for 3113819 through 3346138 and 2001100 from 3346139. `registryRuntimeAllows`
  checks a block's runtime against its height, and an anchor in a block outside
  its generation's spans is invalid.
