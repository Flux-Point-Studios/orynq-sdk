Checkpoint primitives are available from `@fluxpointstudios/orynq-sdk-core/checkpoint`.

`decodeReceiptRecord` consumes one complete SCALE receipt value. `certFormatOf` recomputes its availability certificate hash using SCALE v1 or the two allowlisted legacy CBOR domains. A match establishes byte compatibility; it does not establish committee approval or chain inclusion.

`censusBatch({ genesis, finalizedHeight, receipts })` accepts 1–4,096 distinct certified receipts and orders them by creation time, then receipt id. Its manifest uses Python-compatible serialization, and its identity is SHA-256(root || manifestHash). The caller must obtain every receipt from the same finalized block.

`memberSnapshot` stores public receipt fields and their certificate formats in leaf order. `parseMemberSnapshot` checks the 1.5 MiB budget, rejects unknown fields and formats, and recomputes the leaves, root, manifest and identity. A snapshot alone proves neither chain inclusion nor certification.

The Merkle tree uses SHA-256 over raw child bytes, repeats the last node at odd layers, and leaves a single leaf unchanged. `rootFromPath` binds a proof to its index and leaf count and rejects inconsistent odd-node siblings.

Public receipt fixtures were captured from Materios genesis `0e46e33f639a56cc8780fd871d9a15e16d99af248526f907cb560cb40849f7bf`. Certificate bytes, leaves and manifest hashes were independently computed with Python `hashlib`, `struct` and `cbor2`.
