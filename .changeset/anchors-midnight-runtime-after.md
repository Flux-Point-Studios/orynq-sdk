---
"@fluxpointstudios/orynq-sdk-anchors-midnight": minor
---

`runtimeAfter(node, header)` names the runtime that will execute the block
after `header`: the earliest block a transaction sent while `header` is the
node's best can land in. It reads `:pending_code` from `header`'s own state
when present, and `:code` otherwise, through a read proof of the keys
execution verification already uses, checked against `header`'s state root.
The code hash is mapped through the runtime table, and code outside that table
is refused. The node's `state_getRuntimeVersion` reports `:code` alone, so at a
`set_code` block it names the runtime the next block no longer runs.
