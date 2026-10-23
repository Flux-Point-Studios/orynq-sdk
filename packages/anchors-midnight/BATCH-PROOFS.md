`verifyBatchProof` checks a public `orynq-midnight-batch-proof/v1` bundle against the caller's expected content hash, Materios genesis and Midnight network. It reconstructs the allowed certificate, checkpoint leaf, shape-bound Merkle path, census manifest, anchor identity and batch-set commitment before verifying the Midnight anchor's registry, transaction inclusion, author and GRANDPA finality.

Kind 3 requires a signed known-author entry with role `batch` whose window includes the block. An expected-author key alone cannot establish that role. `verifyBatchSet` returns the verified author, block, checkpoint identity and known-authors serial so a store can revalidate an author's window without chain access after a document update.

A valid result establishes that the requested content hash belongs to the receipt batch committed by that finalized Midnight transaction. The batch role records the operator's claim that it observed certification on the stated Materios chain and block. Committee approval and content correctness require separate checks.

`batchSetCommitment` accepts 1–1,024 strictly ascending, unique anchor identifiers. Its SHA-256 input is the zero-padded 32-byte `orynq:anchor-batches:v1` tag, Materios genesis and the raw identifiers. A bundle is a hint: its field names, member ordering, counts, proof shape, registry and block hint are checked.

`auditCheckpoints` rejects edits or removals from a checkpoint prefix. `knownAuthors` applies this guard between signed serials in increasing order. Newly appended derived checkpoints still need a verified chain from an existing trusted checkpoint; an append-only list alone does not authenticate them.
