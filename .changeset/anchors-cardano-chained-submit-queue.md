---
"@fluxpointstudios/orynq-sdk-anchors-cardano": minor
---

Add `createChainedSubmitQueue`, which lets one wallet submit transactions back
to back without waiting for each to land. Indexers such as Blockfrost report
only block-confirmed UTxOs, so concurrent builders all select the same inputs
and the node rejects all but one ("All inputs are spent"). The queue runs one
build at a time, hands each build the wallet UTxOs the previous transaction
left, waits for its last transaction to land before reading the wallet from
the provider again, and caps how long a chain grows. It coalesces duplicate
keys onto one submission and rejects new keys with `SubmitQueueFullError`
once `maxPending` are waiting.

It is library-agnostic: the caller's build function receives the UTxOs to
spend (or `undefined` to read the wallet) and returns the signed transaction
as a `ChainedTx`: its hash, the wallet's UTxOs after it, and a `submit`
function the queue calls. `awaitConfirmation` waits for a transaction to land,
and `isOnChain` looks one up without waiting. A key is remembered for
`dedupeTtlMs` only once its own transaction is seen on chain: when one
transaction of a chain lands, the queue looks up the others, because a wallet
with several UTxOs builds parallel lineages and one landed transaction does
not vouch for the rest. A chain that never lands is forgotten, so its keys
submit again. A `submit` that rejects with `SubmitRefusedError`, because the
node refused the transaction, fails that submission at once, and the queue
keeps chaining on the UTxOs it would have spent. A submit that fails without
saying whether the node took the transaction (a timeout, a 5xx, an unreadable
reply) is checked on chain before it is failed, and answered with its hash if
it landed. `isSpentInputError` recognises the spent/unknown-input rejections
of cardano-node, Blockfrost, Ogmios and the lucid-evolution Emulator.
