---
"@fluxpointstudios/orynq-sdk-process-trace": minor
---

`addEvent()` appends to a run one call at a time, in call order: concurrent
calls on one run left a rolling hash that chained only the last event. An event
the run cannot take changes nothing and leaves no gap in `seq`: one that cannot
be hashed, or whose span closes or run is finalized before it is appended, is
refused.

`verifyRollingHash()` requires the events' `seq` values to be exactly 0 to
n - 1, so a list that leaves out events no longer verifies against a chain over
fewer events than the run holds.

`verifyDisclosure()` and `verifySpanDisclosure()` read only the options' own
properties, so a `leafHashes` or `leafCount` inherited from a polluted
`Object.prototype` authenticates nothing.

Trace hashing computes SHA-256 synchronously instead of awaiting a Web Crypto
digest for each event, span and Merkle node. Every hash is unchanged.
