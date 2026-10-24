# Durable census plans

`openCensusState(path, {network, genesis, registry})` owns a private SQLite database. Schema,
scope and version are initialized in one transaction; plans use WAL with full
synchronous writes. Scope changes and unknown schema versions are refused.

`prepare(census, nowMillis)` atomically records the observed census, canonical
member snapshots, a kind-3 plan, publication objects and exclusive receipt claims.
It selects recent receipts first, then historical receipts, with deterministic
ordering and at most 64 snapshots of 4096 receipts. An active plan is resumed
byte-for-byte. A receipt that disappears, a finalized height rewind, or a changed
hash at the same height stops planning.

`pendingObjects()` supplies immutable objects for an external retained proof store.
The publisher must read back and hash each remote object before calling
`acknowledgePublication(key, sha256)`. Acknowledgement records delivery evidence;
it does not authenticate a remote store or establish on-chain coverage.
`publicationObjects(commitment)` returns all bound objects, including acknowledged
ones, so a publisher can repeat readback checks before a later confirmation.

`confirm(commitment, freshCensus)` requires all publication acknowledgements and
revalidates every claimed certificate. A planned plan may be abandoned and its
claims released before confirmation. Its immutable history remains; an identical
never-confirmed plan may be reactivated. Confirmed claims cannot be released, and
later recertification requires reconciliation rather than permission for another
fee.

`publishLandedSet(set, {verify, publication})` parses and copies exact set evidence,
requires the complete confirmed plan membership and performs the public consensus
verifier before staging immutable set bytes. It freshly publishes every member,
plan and set to both retained stores, re-runs verification under the current
policy returned by `verify()`, then atomically lands the exact retained set.
No separate acknowledgement-only landing API exists. All claims remain retained.
An interrupted publication leaves a confirmed plan and staged set; recovery repeats
proof verification and readbacks without requesting another transaction.

Plan landing proves coverage of its fixed certificates. It does not settle another
prepared or uncertain transaction, release fee reservations or free wallet inputs.
The controller must retain those in its authenticated follower and submission journal.
This module does not load a wallet, prepare final transaction bytes or broadcast.
The independent coverage watch must obtain a fresh census and verify proofs.
