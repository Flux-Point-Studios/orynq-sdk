# @fluxpointstudios/orynq-sdk-anchors-midnight

Orynq anchors on Midnight. This package holds the `orynq-anchor-registry` Compact contract, the
exact state it is deployed with, and the checks that refuse any other deploy. It is private
until the registry is deployed on mainnet.

## The registry contract

`contract/orynq-anchor-registry.compact` (compactc 0.31.1, language 0.23.0, runtime 0.16.0)
has two circuits. Both only write ledger state, never read it, so concurrent anchors never
conflict and nobody can block one.

| Circuit | Publishes | Proves to consensus |
|---|---|---|
| `anchor(commitment, kind)` | commitment, kind, author key | the author knows the secret behind the author key; refuses kind 2 |
| `anchor_hiding(attribute)` | commitment, attribute, author key | the author knows the secret, and an opening whose commitment is the published one |

The author key is `author_key(secret) = SHA-256(pad32("orynq:anchor:author:v1") ‖ secret)`.
Every digest is plain SHA-256 over 32-byte words, so a verifier recomputes it with any SHA-256:

```
entry_digest(root, manifest, merkle)          = SHA-256(pad32("orynq:anchor-entry:v1")  ‖ root ‖ manifest ‖ merkle)
hidden_digest(root, manifest, merkle, attr)   = SHA-256(pad32("orynq:anchor-hidden:v1") ‖ root ‖ manifest ‖ merkle ‖ attr)
hiding_commitment(digest, salt)               = SHA-256(salt ‖ digest)
derive_salt(salt_key, digest)                 = SHA-256(pad32("orynq:anchor-salt:v1")   ‖ salt_key ‖ digest)
```

A salt key is published only by its id, `SHA-256(pad32("orynq:anchor-salt-key-id:v1") ‖ salt_key)`,
which the contract never computes.

### What a kind-2 anchor binds

`anchor_hiding` proves that the published commitment equals
`hiding_commitment(hidden_digest(root, manifest, merkle, attribute), salt)` for an opening only
the author holds. The published attribute is therefore bound to the published commitment: no
opening of that commitment carries a different attribute.

The circuit does not check the attribute against the trace. It treats `root` as 32 opaque
bytes, and process-trace folds the model manifest into the root hash inside a variable-length
string that no circuit reads, so a trace that ran under model manifest B can be committed with
attribute A.
Only someone holding the opening and the bundle can check that the attribute matches the
manifest bound in the root. `src/__tests__/attribute-binding.test.ts` pins both halves.

### Immutability

The registry is deployed with maintenance authority committee `[]`, threshold 1, counter 0,
and nothing else is accepted. With no committee a maintenance update needs one signature from
a member that cannot exist, so no update can ever apply; threshold 0 would admit an unsigned
one. `assertRegistryDeployBytes` decodes the exact transaction bytes, before or after proving
and binding, and refuses them unless they deploy exactly `registryInitialState()`, byte for
byte, and touch no other contract.

## Commitments and author keys

`entryCommitment`, `hiddenDigest`, `hidingCommitment`, `deriveSalt` and `authorKey` call the
compiled contract's own pure circuits, so the SDK and the registry cannot compute a commitment
differently. They take 32-byte hashes as bytes or as hex, bare or prefixed `sha256:` or `0x`, the
forms process-trace bundles and anchors-cardano entries use. A kind-1 commitment is
`entry_digest(rootHash, manifestHash, merkleRoot)`, with 32 zero bytes when the entry has no
merkle root.

An author key is a fresh random 32-byte secret, never derived from a wallet seed.
`createAuthorKeyFile(path)` writes one to a new file only its owner can read and returns the
public author key; `readAuthorSecret(path)` refuses a symlink, a file the caller does not own and
a file group or others can read or write. A service's salt key, from which its kind-2 anchors
derive their hiding salts, is a fresh random 32-byte secret too: `createSaltKeyFile(path)` writes
one under the same rules and returns `saltKeyId(key)`, its public id, so a salt key disclosed later
to open kind-2 anchors can be matched to the id published when it was made.

A user anchoring with their own key holds a user key file instead: `createUserKeyFile(path)`
writes a fresh author secret and a fresh salt key (from which a kind-2 anchor derives its hiding
salt) as `{"format":"orynq-midnight-user-key/v1","authorSecret":…,"saltKey":…}`, under the same
rules, and returns the public author key. `readUserKey(path)` refuses everything
`readAuthorSecret` refuses, any other format, unknown fields, and equal keys. It refuses a bare
author key file too, so a tool that anchors with a user's key never takes a service's key file.

`MIDNIGHT_REGISTRIES` lists the deployed registry generations per network. None is deployed yet.
Each entry pins its address, deploy transaction, the runtime whose extrinsic layout the decoder
knows (spec 1000300), and this contract's verifier keys, which `assertRegistryGenerations` checks.

## Verifying an anchor

`verifyMidnightAnchor({ network, txHash, expect }, { source })` checks an anchor from the
transaction's own bytes, never from what a source says about them. Each step is a named check
in the result:

1. The indexer's bytes must decode to a transaction whose own hash is `txHash`, before anything
   else is asked of them.
2. The transaction must write exactly one anchor to a registry generation in
   `MIDNIGHT_REGISTRIES`, with a guaranteed transcript equal, op for op, to what the compiled
   circuits write; `anchor()` never with kind 2 or a nonzero attribute. A deploy or maintenance
   update aimed at the registry in the same transaction is refused.
3. The node's block at the indexer's height must have the indexer's hash, hash to it from its
   header, and commit to its body through `extrinsicsRoot`; its runtime must be one whose
   extrinsic layout the decoder knows, and one extrinsic must be exactly the bare
   `Midnight.send_mn_transaction` of these bytes.
4. GRANDPA must show the block final from a trusted checkpoint (the KNOWN_AUTHORS document's,
   or the caller's).
5. The registry's pinned deploy goes through the same steps and must deploy exactly the
   immutable registry state at the registry's address, in the pinned block; the indexer's and the
   node's state snapshots are cross-checks.
6. The anchor must match the request, and its author must be known for that height.

Statuses, most severe first: `invalid`, `conflict` (sources disagree with each other or with
consensus), `unavailable`, `unverified-finality`, `unauthenticated`, `author-revoked`, and
`valid`. Assurance says how far inclusion is established: `consensus-verified`, `multi-path`
(indexer and node agree; on Blockfrost that is one operator running two pieces of software),
`single-path` or `none`. A result is `valid` only at `consensus-verified`: skipping finality
(`finality: "skip"`), a checkpoint more than `maxSetChanges` set changes away, or a node that
cannot answer leaves it `unverified-finality` or `unavailable`, never `valid`.

`verifiedFields` names only what the commitment binds and the request matched: `rootHash`,
`manifestHash` and `merkleRoot` for a kind-1 entry, `commitment` for a bare kind-1 commitment,
and `committedAttribute` for kind 2, plus the entry's hashes when the caller supplies the
private opening, which is checked locally. `expect: { kind: "any" }` expects nothing: every
other check runs, the anchor's commitment is reported, and `verifiedFields` stays empty. A kind-2 result always carries a note that the
circuit binds the attribute to the commitment and never checks it against the trace. No proof is
re-verified locally: the npm ledger WASM cannot verify one, and inclusion in a final block is
what shows consensus did.

`verifyReport(result)` is the result as a terminal prints it and a model reads it: the finality
checkpoint is dropped (its weights are bigints, which JSON cannot carry), a block hash that is not
64 hex characters drops the block, and every check, note, operator and the transaction hash pass
through `printable`, which turns control, format, private-use and unassigned characters and line
separators into `?` and cuts text at 300 characters. A source's text can still say anything
printable; the status and assurance are what to act on.

## Finding anchors

`findMidnightAnchors({ network, source, fromHeight, toHeight })` lists the anchors a set of
authors (the KNOWN_AUTHORS document's by default) wrote in a window of at most 20,000 blocks that
lies at or below the indexer's head. It reads the indexer's `contractActions` subscription for
each registry generation and decodes every action from its transaction's own bytes; a call to a
registry that is not an anchor is reported under `rejected`. It stops at the first action past
the window, when the subscription has delivered the newest action the indexer knows, or after
`maxActions` actions (default 2,000), returning a cursor to resume from, so strangers anchoring
in the same window cannot make one call read more than `maxActions` actions. A result is a list
of candidates: each one is shown final and authentic only by `verifyMidnightAnchor`. Nothing on
a critical path scans the registry; the submitter reconciles by transaction hash. The search
needs a global `WebSocket`, which Node has from version 22.

## Submission journal

`@fluxpointstudios/orynq-sdk-anchors-midnight/journal` keeps a write-ahead journal of anchor
submissions in SQLite (`node:sqlite`, Node 22.13 or later). `submitOnce(key, { prepare,
broadcast, chain })` allows one live attempt per anchor key (network, registry, author, kind,
commitment, attribute). It writes the attempt's row, with the hash it computes from the final
bytes `prepare` returns, before `broadcast` sees those bytes, so a broadcast that times out after
the node accepted it, or a process that dies before or during it, is answered later by that
hash and never sent as a second transaction. A row whose broadcast never returned is resent with
the same bytes. A pending row is retired only when the indexer reports its transaction (landed
or failed), or when the indexer's newest block is past the transaction's TTL plus a margin, in
chain time rather than the local clock. Calls are serialized per journal, and across processes
the attempt that writes its row second never broadcasts. `chainView(source)` reads transactions
from a source's indexer, and chain time from the indexer's newest block only once the source's
node holds that block at that height, as the smaller of the indexer's time for it and the
node's own `Timestamp.Now` in it; until the node holds it, chain time is the epoch, so an
indexer that is forked, foreign or ahead of the node retires nothing.

## Known authors

Which author keys a verifier recognizes, over which block heights and in which role, and which
GRANDPA checkpoints it trusts, come from a KNOWN_AUTHORS document (`orynq-known-authors/v1`)
signed with Ed25519 by an offline trust-root key over `"orynq-known-authors/v1\n" ‖ document`.
The document is shipped as the exact string that was signed, in `known-authors.json`, so no
JSON canonicalization sits between a signature and what it covers. Parsing is strict: unknown
fields, networks and roles, malformed keys, and overlapping windows for one key are refused.
Each signature check refuses with its own message, so a caller can tell which one failed: `the
known-authors document carries no signature by a trust root` when no signature names one,
`... is not 64 bytes of lowercase hex` when every trust-root signature is malformed, and `... does
not verify` only after Ed25519 verification failed for every well-formed trust-root signature.

Each author has a role (`relay`: an anchor the FPS service wrote for whoever asked it) and a
window of block heights, `validFrom` to `validTo` inclusive. Revoking a key is a later document
with a higher serial that closes its window at the height the compromise began; anchors below
it stay valid and anchors above it read `outside-window`. A verifier learns of a revocation from
the documents it is given, never by scanning the permissionless registry. `knownAuthors()` keeps
the highest serial among the shipped documents and any newer ones a caller passes, so an older
document cannot roll a revocation back, and a document that fails to verify is an error.

No trust root and no document ship yet: the first trust-root key is generated, and the first
document signed, by deci on a machine no model drives, with
`node --import tsx scripts/known-authors.ts new-root-key SEED_FILE` and
`... sign DOCUMENT_FILE SEED_FILE`. Until then every author is `unknown`, and no checkpoint is
trusted.

## Finality and inclusion

`verifyFinality` decides whether a block is final under GRANDPA from data any untrusted source
supplies (`grandpa_proveFinality` and `chain_getHeader`, batched), trusting only the
checkpoints it is given. A checkpoint names a GRANDPA set id, its weighted authorities, and the
set-change block after which that set finalizes. From the nearest checkpoint below the block,
the verifier follows each set change: the outgoing set must justify the set-change block with a
supermajority of its weight (finality-grandpa's threshold, `total - (total - 1) / 3`), and that
block's header, which must hash to the justified hash, names the next set in its FRNK log; a
forced or delayed change stops the walk. The set that finalized the block must then justify a block
at or above it, and the headers in its proof must chain down to the block's hash. A
justification's own target is not signed, so a precommit counts for it only when it signed that
hash at that number, or a descendant whose ancestry headers lead down to it at that number: a
source cannot relabel a final block's justification as a higher block. A set finalizes only
with more than two thirds of a total weight above 0, from distinct authorities: a checkpoint
with no voting weight (no authorities, or every weight 0) or with a negative weight is refused
before anything is asked of the source, and so is a set change that schedules a set with no
voting weight.

Trust assumption: "consensus-verified" means that the checkpoint really is that GRANDPA set, and
that every set from it to the block had more than two thirds of its weight honest. Signatures
are Ed25519 (OpenSSL, RFC 8032 strict, which can refuse a ZIP-215 signature Substrate accepts
but never accept one it refuses) and headers BLAKE2b-256.

Cost: one batched request per 64 set changes for the proofs and one for the headers, about 6.7 KB
per set change on mainnet, where a set lasts 300 blocks (30 minutes). The walk stops after
`maxSetChanges` (default 2016, six weeks) and reports the block not finalized, so the cost never
grows with the chain's age; a fresher checkpoint is the remedy. A finalized result returns the
set that justified the block as a checkpoint the caller can keep.

Inclusion is a strict decode, never a byte search. `orderedTrieRoot` recomputes a block body's
`extrinsicsRoot` (trie layout V1, which Midnight's state version 3 selects), and
`includedTransactionIndex` finds the one extrinsic that is exactly a bare
`Midnight.send_mn_transaction(tx)` (pallet 5, call 0 in runtime 1000300) with nothing before or
after the transaction. Only a bare extrinsic counts, because for those the runtime runs the
ledger's full `well_formed` check, proofs included, in `pre_dispatch`: a block holding one is
invalid unless the transaction is, so inclusion in a final block means consensus checked the
proof. A transaction carried inside another call, another pallet, a signed or general extrinsic,
or another transaction's bytes is not included.

`midnightSource` reads a Midnight indexer (GraphQL) and node (JSON-RPC); `blockfrostEndpoints`
points it at Blockfrost, with the project id read from a file only its owner can read and sent
as a header. No error, status or echoed body carries the project id, and a file that does not
hold one (a lowercase prefix, then 32 letters and digits) is refused, so naming the wrong file,
a mnemonic or an author key, never sends that secret to Blockfrost. `sourceEndpoints(network,
{ blockfrostProjectIdFile } | { indexer, node })` is what a user configures: Blockfrost through a
project id file, or an http or https indexer GraphQL URL and node JSON-RPC URL that need no
credential, such as a self-hosted node. It returns null when neither is given and refuses both,
or half a pair.

## Reproducing the build

```
tools/compactc/install.sh ~/.cache/midnight/compactc ~/.cache/midnight/zk-params
COMPACTC=~/.cache/midnight/compactc/compactc MIDNIGHT_PP=~/.cache/midnight/zk-params packages/anchors-midnight/contract/compile.sh --check
```

The installer verifies every compactc file and the k=13/14 parameters by sha256, and refuses
either directory unless you own it, no group or other user can write it, and every directory
above it is a real directory owned by you or root that no group or other user can write; it
installs nothing below a shared sticky directory such as /tmp. An install anyone else can change
or swap out would no longer be the pinned compiler by the time it runs. The check recompiles the
contract and requires `managed/` and `HASHES.txt` to match byte for byte, and requires the same
keys and zkir when the pure circuits are not exported. The verifier keys hash to
`85dc57a4…77c5` (`anchor`, k=13) and `081384ce…790f` (`anchor_hiding`, k=14).

## Tests

`pnpm test` runs the contract, ledger, decoder, finality, known-authors, verifier, search and
journal suites; `pnpm test:journal` runs the journal alone, which needs Node 22.13 or later for
`node:sqlite`. The verifier's golden vectors are real: mainnet and preprod blocks, set-change
headers and a state read proof, and recordings of the finality walk, the verifier and the search
run against Blockfrost, which the tests replay and which fail on any request that was not
recorded. The registry transactions in `src/__tests__/fixtures/registry-transactions.json` were
proven in-process with the committed keys by `scripts/registry-fixtures.ts`.

`MIDNIGHT_PP=~/.cache/midnight/zk-params nice -n 19 pnpm test:slow` proves both circuits
in-process (about a minute on one core) and scans the proven, bound bytes. The npm ledger WASM
does not verify contract proofs; the slow suite pins that, and nothing in this package presents
a local `wellFormed()` as proof verification.
