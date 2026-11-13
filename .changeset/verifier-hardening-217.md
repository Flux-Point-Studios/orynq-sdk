---
"@fluxpointstudios/orynq-sdk-core": patch
"@fluxpointstudios/orynq-sdk-process-trace": patch
"@fluxpointstudios/orynq-sdk-anchors-cardano": patch
"@fluxpointstudios/orynq-sdk-midnight-prover": patch
---

Verifiers read their input once and fail closed on more malformed input.

core: `verifyMerkleProof()` copies the proof's index and siblings as it
validates them and walks the copy, so a getter or proxy cannot be validated as
one index or path and walked as another.

process-trace: `addEvent()` copies its event when it is called, so the event
recorded is the one passed, whatever the caller does with the object while
earlier appends finish; an event holding a circular reference is refused. A
run's append queue is kept on the run under a `Symbol.for()` key (a
non-enumerable property), so the ESM and CJS builds loaded into one process
append to a run one at a time instead of interleaving sequence numbers.
`verifyRollingHash()` resolves to `false` instead of throwing for events that
are not an array, a sparse array, an event that cannot be hashed (a cycle, a
bigint) and an expected hash that is not a string. `buildSpanMerkleTree()`
takes an optional `{ afterItems }` callback, awaited after each span and tree
node, with which a caller can yield to the event loop; the tree is unchanged.

anchors-cardano: `verifyAnchor` with `fetchBundle` yields to the event loop
every 2,048 events, spans and Merkle nodes while it recomputes a fetched
bundle. A document at the 8 MiB cap still costs on the order of 10 to 20 s of
CPU time (about 300,000 empty spans or 600,000 bare events), but timers, I/O
and other requests are now served meanwhile; the JSON parse, the ID uniqueness
check, sorting and the root hash remain uninterrupted stretches of up to about
a second each. Lower `maxBundleBytes` or verify in a worker where that matters.

midnight-prover: `SelectiveDisclosureProver.verifyDisclosure()` reads the
proof's public inputs, bytes and disclosed data once at entry and uses those
values for the proof ID, the Merkle root comparison and the Merkle path, so a
proof whose public inputs change between reads cannot pass the
`expectedMerkleRoot` comparison with one root and be verified against another.
A proof whose `disclosedSpan` or `disclosedEvents` is `null` now yields an
invalid result instead of a rejected promise.
