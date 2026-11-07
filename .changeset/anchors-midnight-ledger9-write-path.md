---
"@fluxpointstudios/orynq-sdk-anchors-midnight": minor
---

Build and settle registry anchors on Midnight after the Ledger 9 upgrade.

- `unprovenRegistryCall` builds against the state it is given with that state's
  ledger. Against the `contract-state[v8]` a ledger 9 network holds for the
  immutable ledger 8 registry, it builds a ledger 9 `transaction[v12]` carrying
  the ledger 8 circuit's call, partitioned with the chain's ledger 9 parameters,
  which it requires as `parameters`. Its circuit outputs, transcript partition
  and transaction shape match midnight-js 5's retained ledger 8 call path for
  every registry circuit. Against a ledger 8 state it builds a ledger 8
  `transaction[v9]` as before.
- `midnightSource`'s indexer reads the head block's ledger parameters
  (`ledgerParameters`), and `ledgerParametersIn` reads them with the ledger their
  header names.
- `decodeTransaction` reads final bytes with the ledger their header names.
  `runtimeLedger` names the ledger a runtime executes (1000300: ledger 8,
  2001100: ledger 9), and `assertTransactionRuntime` refuses a transaction outside
  it. Ledger 8 bytes relabelled `transaction[v12]` decode under ledger 9 as a
  different transaction, so the header alone does not place bytes in an era.
- `verifyMidnightAnchor` adds the `transaction-ledger` check: the anchor's
  transaction must be of the ledger its block's runtime executes.
- `verifyFinalizedTransaction` reads `transaction[v12]`, refuses a transaction
  outside its executing runtime's ledger, and returns `runtimeSpecVersion`.
- The journal reads final bytes of either ledger, and a journal scan refuses a
  block carrying a transaction its runtime's ledger does not read.
- `registryState` returns the immutable registry's state from either ledger's
  bytes; `registryRuntimeAllows` is exported.
