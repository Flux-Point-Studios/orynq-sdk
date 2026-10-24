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

The module does not load a wallet, prepare final transaction bytes, broadcast,
verify a Midnight landing, or count coverage. The standing controller must use the
existing submission journal and an authenticated follower for those operations.
The independent coverage watch must obtain a fresh census and verify proofs.
