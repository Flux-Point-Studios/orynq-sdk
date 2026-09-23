---
"@fluxpointstudios/orynq-sdk-anchors-cardano": minor
---

Add `createChainedSubmitQueue`, which lets one wallet submit transactions back
to back without waiting for each to land. Indexers such as Blockfrost report
only block-confirmed UTxOs, so concurrent builders all select the same inputs
and the node rejects all but one ("All inputs are spent"). The queue runs one
build at a time, hands each build the wallet UTxOs the previous transaction
left, waits for its last transaction to land before reading the wallet from
the provider again, and caps how long a chain grows. It also coalesces
duplicate keys onto one submission, remembers landed keys for a TTL, and
rejects new keys with `SubmitQueueFullError` once `maxPending` are waiting.

It is library-agnostic: the caller's build function receives the UTxOs to
spend (or `undefined` to read the wallet) and returns the txHash and the
wallet's UTxOs after the transaction. `isSpentInputError` recognises the
spent/unknown-input rejections of cardano-node, Blockfrost, Ogmios and the
lucid-evolution Emulator.
