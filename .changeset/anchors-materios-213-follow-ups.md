---
"@fluxpointstudios/orynq-sdk-anchors-materios": patch
---

Liveness and hardening follow-ups to the 0.7.0 submission contract. No result label changes.

- A watch that timed out is taken for an unresponsive connection only when the socket carried nothing for it: no reply to the submission and no status. A watch that merely outlasted its window, as an anchor's does whenever finality is slower, no longer has the connection replaced under other calls' watches.
- A `1016` refusal (the pool is full) is `not-landed` at once instead of going to recovery. `1012` and `1013` still go to recovery: that transaction may already be pooled or included.
- Recovery uses one reader connection per provider, shared by every submission in recovery and every `resolveInclusion` call, in place of one per lost watch.
- `disconnect()` closes that reader and ends the polls using it. A submission in recovery, or a `resolveInclusion` call, then rejects with `inclusion-unknown` at once instead of opening readers until its deadline.
- Receipts and anchors are signed with an explicit era and block hash: the ones polkadot.js picks by default, the finalized head, or the best block's parent when finality lags more than five blocks. `mortalityEnd` is computed from the block the era was born at, so a reorg after signing can no longer make it one period too early.
