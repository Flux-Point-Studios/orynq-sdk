# Authenticated Midnight block reads

`verifyFollowerBlock({source, block, checkpoints, maxSetChanges?})` checks one
explicit block reference. It binds the full body to the header's extrinsics root,
verifies GRANDPA finality under the supplied trust anchors, then authenticates
parent runtime code, execution events and timestamp through storage proofs.
Only after exact bare Midnight sends are decoded and bound to their body indices
does it classify their execution outcomes. It never reads indexer status or time.
Any authenticated application outside that body-bound send list stops the read,
including wrapped or scheduled dispatch that this bare-send decoder cannot represent.

`openFollowerReader({source, checkpoints, maxSetChanges?}).range({after, end})`
authenticates an endpoint once and walks each exact parent/body back to the durable
`after` reference. It yields complete verified blocks in ascending order. A range
contains at most 32 blocks and sixteen MiB of decoded bodies. Every block,
including an empty one, still requires runtime, execution-event and time witnesses.
An effects failure preserves only earlier complete blocks already yielded.

The reader keeps at most 64 verified derived authority checkpoints in memory.
It selects the nearest original input root first, then a cached path belonging to
that root. Each path carries its cumulative transition count; the remaining budget
is the original allowance minus that count. Historical fallback from an original
root recounts its path. Cache promotion requires successful finality and exact
linkage to the durable parent. Output policy identity always names the original
inputs; restart re-verifies from those inputs. Conflicting derived checkpoints hold.

The caller supplies one bounded HTTP budget and deadline for each catch-up turn,
including endpoint discovery and execution proofs. Eviction can repeat work; a
cold prefix exceeding that budget needs an explicit recovery or policy migration.
It must never reset transition accounting or trust serialized cache metadata.

The public `verifyBlockEffects(node, {blockHash, header})` shares execution proofs
across a block. Its header must already be authenticated. Its `outcome(index,
txHash)` requires an independently verified body/index/hash binding: System
failure events contain no transaction hash. The block reader enforces that
precondition. The existing anchor verifier still accepts full success only.

`registryOperator({chain, ...})` accepts an explicit reconciliation `ChainView`;
omitting it retains the existing adapter. The supplied view must match the
operator's network. A standing adapter must hold on partial execution. Passing
partial success to the legacy journal would mark a non-deployment attempt failed;
returning null could instead reach its TTL-based absence path.

A single verified block establishes neither source freshness nor continuous
coverage. `openFollowerState` stores hash-linked complete blocks and observations
atomically in private owner-only SQLite with FULL synchronous WAL. Its immutable
scope includes network, genesis, registry, author, runtime and the digest of the
input finality policy. That digest binds checkpoint identities and the captured
authority-transition budget, rather than a derived checkpoint after a transition.

Attempt provenance binds exact bytes, their maximum serialized intent TTL, fee,
commitment and first prebroadcast block. Register only newly prepared bytes or an
already registered retry; never assign a new boundary to an unknown restored
journal row. `assertRecorded` checks provenance, not permission to broadcast.
The reconciliation view snapshots its authenticated head. Authenticated success
proves positive inclusion. Absence requires recorded provenance and complete
ancestry; partial execution always holds. Explicit failure retains its reservation
through strict TTL plus margin; later success remains observable.

`feeFacts()` requires a complete authenticated day and checks the shared retained
interval once. Each attempt must have its exact boundary inside that interval.
`standingFeeUnion` deduplicates paid observations and local reservations by hash,
uses the maximum conflicting amount and prevents admission on a conflict.
Unresolved reservations never age out; paid observations remain counted after a
local absence decision. `assertStandingFeeBudget` applies the existing approved
per-transaction and rolling-day caps.

`assertStandingClock` requires fresh chain time, twenty minutes of both chain and
process-monotonic progress after every start, and agreement between wall and
monotonic elapsed time. The controller must capture a new start point for each
process, preserve it through retries and latch clock faults until restart.

`openStandingSession` captures a fresh verified startup block and host-clock birth
by value. Every new process waits strictly beyond twenty chain minutes and at
least twenty monotonic minutes. It checks coherent follower snapshots, current
signed policy and exact head identity again before reserving copied transaction
bytes. Ordinary catch-up and head advancement can retry; observed clock steps,
rewinds or lost reservation history latch a restart requirement.

The process remembers its admissions and latest observed authenticated policy.
Admission watermarks are checked inside the reservation transaction so a
same-head restore cannot silently erase an earlier claim. A whole-process restore
still needs independent retained policy and accounting history. A ready session
or historical admission does not grant wallet delivery permission.

SQLite and its owning process are a trusted local persistence boundary. Reads do
not cryptographically reauthenticate stored observations against retained proofs.
Private permissions, atomic transactions and interval checks do not protect against
an owner rewriting the database. Restoration must preserve provenance and all
unresolved reservations. One-process ownership and standing execution remain
separate integration work.

`reserveStandingAttempt` checks the current opened signed-author view, exact
canonical kind-3 call, registry/author/commitment, runtime and every serialized
intent TTL. It rejects unrelated contract actions, rewards, asset offers and DUST
registrations. The maximum TTL is fifteen authenticated chain minutes; the
earliest TTL must also remain ahead of host UTC. A standing preparer uses a
ten-minute TTL to allow for normal finalized-head delay.

Reservation checks and exact provenance/admission insertion share one immediate
transaction. Fee history covers a complete day. Commitment history must start no
later than the configured author's earliest retained batch window. Observed
success or partial execution retains its commitment beyond the fee window;
unresolved other bytes retain their claim. An identical live retry shares its
reservation. Only complete strict TTL-plus-margin absence permits replacement.
This is one author/registry scope; rotations must preserve historical windows,
fees and commitments across authors rather than creating an empty counter.

Schema two migrates provenance without granting old admissions. Earlier blocks
are unindexed until their complete authenticated results are replayed with the
same durable digest. Historical replay fills commitment indexes without moving
the head backward. No admission is possible while any retained block needs replay.

`observeStandingPolicy` takes an already authenticated `KnownAuthors` view.
The highest serial and scoped author/checkpoint digest persist even when a newer
revocation refuses admission. Conflicting views at one serial latch a durable
hold; only a strictly newer authoritative serial can resolve it. Admission also
requires its checkpoint identities and default transition budget to match the
durable follower policy. Scope/checkpoint changes require a reviewed migration
that retains prior accounting; they never reset it automatically.

`assertAdmitted` proves only that the exact bytes have a historical admission.
Before each delivery, the wallet boundary must require that record and re-run
reservation checks with fresh clocks and the current authenticated author policy.
It must also require fresh retained publication and confirmed membership under
the controller's lifetime lock. This module does not authorize broadcast alone.

`openStandingDelivery` composes the session, census, two retained stores and
submission journal around the wallet's raw submission method. Each call copies
its bytes, verifies pending journal provenance and serialized maximum TTLs, saves
wallet state, freshly publishes both copies, and confirms membership against a
fresh census. Only then does it mint a thirty-second, exact-byte, single-use
permission. The callback consumes permission before awaiting, rechecks admission
asynchronously and synchronously, and samples clocks after deserializing the
transaction. Current policy, head freshness, host-clock continuity and every
serialized TTL still apply at the final wallet handoff.

Unknown delivery retains journal, claim and fee reservations. An explicit wallet
refusal forbids reusing those bytes in that process. Failed wallet persistence
latches restart. Reconciliation requires known provenance and the serialized
journal TTL before consulting a fresh follower view. The caller must acquire a
lifetime lock before opening the wallet and retain it through preparation,
publication, delivery, persistence and close; this factory does not acquire it.

Undecodable sends or ambiguous execution stop this reader. They must not be
silently converted into missing transactions or coverage. Production transport
must separately bound decoded responses, deadlines and catch-up work.

Validation includes recorded real mainnet data and read-only public RPC checks at
blocks 3113832 and 3113847, including all three and five Midnight sends respectively.
No wallet is loaded and no transaction is prepared or broadcast by this module.

A read-only mainnet acceptance sequence verified three consecutive blocks with
the range reader. Its cold block used 27 HTTP requests and 16,702,494 decoded
bytes; two warm blocks used five requests and 2,259,340 bytes in 1.747 seconds.
Every block retained the original policy identity and exact parent links.
This sample establishes neither sustained catch-up speed nor complete history.
Raw runtime-code witnesses still account for about 1.078 MB per block.
