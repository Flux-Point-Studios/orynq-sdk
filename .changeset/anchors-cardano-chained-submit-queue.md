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
function the queue calls. `awaitConfirmation` resolves whether a transaction
landed. A key is remembered for `dedupeTtlMs` only once its chain is seen on
chain; a chain that never lands is forgotten, so its keys submit again. A
submit that fails without saying whether the node took the transaction (a
timeout, a 5xx, an unreadable reply) is checked on chain before it is failed,
and answered with its hash if it landed. `isSpentInputError` recognises the
spent/unknown-input rejections of cardano-node, Blockfrost, Ogmios and the
lucid-evolution Emulator.
