# Prepared proof-contract release intent

This is review material, not an approval. No live mainnet runner or deployment was executed. The preprod faucet payment is located at block 3150901; wallet sync and deployment await authorized indexer access as recorded in [the rehearsal](../../midnight-prover/onchain/REHEARSAL.md). Recompilation reproduced the code, initial-state and verifier-key pins unchanged. The DUST figures below are authorization ceilings; funded proof-contract fees remain unmeasured. CTO review and preprod finality evidence precede execution.

## Exact proposed authorization text

> Authorize exactly one immutable orynq proof-presentation contract deployment on Midnight MAINNET (genesis `1941ca8e2bb88146c14dea084d3be7eb6e96ca7135429c543848b628124f2854`), followed by one synthetic `proveCapability` call and one synthetic `proveRolling1` call with the statements below. Contract code hash: `bd518847ed1c6800d129bdac57a1d595a0912afd74406a07d7838ae1ab060361`. Initial-state SHA-256: `55041c6c05f64fb1cf3aa974aba8e27a83206506bc40a6d21c540d8d294f01b2`. Maintenance authority: empty committee, threshold 1, counter 0. The address is SHA-256 of ledger-8's tagged serialized `ContractDeploy` containing that exact state and its sampled nonce; preserve and reuse the journal's deployment bytes and address. Pay from `mn_addr1hdg7gg557cwmd9v67jv37z38zvprt7d46xqhk7c4a7hfask6jwrs7qesvq`. Cap each transaction at 0.01 DUST and all runner confirmations at 0.1 DUST in the shared rolling 24-hour window. This three-transaction intent initially reserves at most 0.03 DUST. Approval is single-use and expires exactly 24 hours after its recorded `approved_at`; record both UTC instants when approved. Each transaction and proved deadline must expire no later than that approval and within one hour of preparation. Retries preserve exact bytes; replacements require retirement of the earlier bytes under the existing journal rules and remain within the per-transaction, retry and daily caps. This authorizes no hosted proof relay or standing proof spending.

The executable action string is `deploy immutable orynq proof presentations and post one synthetic proof per circuit on Midnight MAINNET`. `proofReleaseIntent()` supplies the exact ordered intent object for the reviewed runner. No intent or approval has been written to the runner's state directory.

## Pinned proof material and statements

| Field | SHA-256 / value |
|---|---|
| Capability verifier key | `33197b9416d101c79df3d9b18ec092c7594d592498679feb920041e9856e5554` |
| Rolling verifier key | `877ec547709026e5fd60f6386521c7634d6a95ba71ad8e35fc092c332217975d` |
| Both contexts | `4770ef105d104ebe892876677489a67c4ccb046d46655b0ff36a80c89fff47dc` |
| Capability commitment | `d51d825634d331539b98e22b64a856ccf1210fdb7a422ef7815ba86f6810bd3a` |
| Rolling genesis | `ff7becf8f8d6ed64167ded450b1887baa59edb6515148201bf533f91abb568ba` |
| Rolling root | `dc18beb5501a78e97517cbc4ea8be924816517af751beb0cc73efbd208af28ba` |
| Rolling anchor field | `b77016351de3f95a03f40de79f7bc925876faf9eb976512cb4449d60827aefc1` |

All demo inputs derive from explicit public `orynq:proof-release:synthetic-*:v1` strings in `proof-release-intent.ts`. The anchor field is synthetic and claims no Cardano inclusion. The code hash is SHA-256 of serialized capability operation followed by serialized rolling operation, not a deployment address. The exact initial-state digest also binds the empty map, schema and immutable authority.

The runner retains its existing approval authentication, file digest checks, expiry, durable single-use records, execution lock, DUST accounting and three-confirmation retry ceiling per intended transaction. Its separate proof journal contains the deploy and both first presentations. A zero process exit is insufficient: the runner checks all three landed records and their pinned transaction contents. The script's readback establishes node-reported finality and exact inclusion; the independent public `verifyPosted` result is the consensus-verified evidence required by the rehearsal.
