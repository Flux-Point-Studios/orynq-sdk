# @fluxpointstudios/orynq-sdk-anchors-cardano

## 0.5.0

### Minor Changes

- ffa932e: Require Cardano checkpoint wallet pins to name an encoding and inclusive absolute-slot window. Export bounded reviewed historical pins; bare addresses and records outside their windows are refused. Detect repeated Koios pagination, distinguish the checkpoint commitment genesis in diagnostics, and rebuild historical dcbor certificates using their explicit supported certificate domain.

  Correct checkpoint smoke documentation: label 8746 stores root, manifest, range and an integer leaf count, while receipt membership proofs are off chain. Cardano checkpoint probes default to mainnet. Keep source-trust and confirmation-depth assumptions explicit.

- d4880f0: Verify a Materios receipt's checkpoint anchor on Cardano end to end with `verifyMateriosCheckpointAnchor`: it recomputes the receipt's leaf (from its cert hash or the receipt fields that rebuild the Cert), the root through the count-bound `rootFromPath`, the daemon's manifest hash and the anchor id, then requires a label 8746 record carrying them in a tx in a block, funded only by pinned anchor wallets and at least 15 confirmations deep (configurable; 2160 for a stronger finality margin under Cardano consensus assumptions). It finds the tx by hash or by scanning the pinned wallets from a Cardano height, and names the check that refused. It does not compare the record's `chain` field, a label that genuine anchors of two windows set to another chain than the genesis their leaves and manifest commit to; the README lists both. `decodeMateriosAnchorRecord` reads the record in both encodings on mainnet, the detailed-schema map the live anchor worker writes and the flat record a Lucid-based worker wrote until 2026-06-29, and refuses mixed encodings and any other `p`/`v`. `createKoiosCheckpointSource` reads the chain through Koios, and `KoiosConfig.baseUrl` points it, and `createKoiosProvider`, at any Koios-compatible API.

  The existing `createKoiosProvider` tip reader now requires Koios v1 `block_height` rather than `block_no`. This repairs numeric confirmations and makes fresh label-2222 anchors correctly produce low-confirmation warnings (including MCP output); a nonconforming endpoint that supplies only `block_no` now fails explicitly.

### Patch Changes

- b7caae1: Classify structured Ogmios submission refusals by numeric code before legacy prose. Malformed transactions fail immediately; spent/unknown inputs never count as duplicate acceptance, which still requires exact-hash chain confirmation.
- Updated dependencies [ffa932e]
  - @fluxpointstudios/orynq-sdk-core@0.3.2
  - @fluxpointstudios/orynq-sdk-process-trace@0.3.1

## 0.4.0

### Minor Changes

- a918a40: Add `createChainedSubmitQueue`, which lets one wallet submit transactions back
  to back without waiting for each to land. Indexers such as Blockfrost report
  only block-confirmed UTxOs, so concurrent builders all select the same inputs
  and the node rejects all but one ("All inputs are spent"). The queue runs one
  build at a time, hands each build the wallet UTxOs the previous transaction
  left, waits for its last transaction to land before reading the wallet from
  the provider again, and caps how long a chain grows. It coalesces duplicate
  keys onto one submission and rejects new keys with `SubmitQueueFullError`
  once `maxPending` are waiting.

  It is library-agnostic: the caller's build function receives the UTxOs to
  spend (or `undefined` to read the wallet) and returns the signed transaction
  as a `ChainedTx`: its hash, the wallet's UTxOs after it, and a `submit`
  function the queue calls. `awaitConfirmation` waits for a transaction to land,
  and `isOnChain` looks one up without waiting. A key is remembered for
  `dedupeTtlMs` only once its own transaction is seen on chain: when one
  transaction of a chain lands, the queue looks up the others, because a wallet
  with several UTxOs builds parallel lineages and one landed transaction does
  not vouch for the rest. A chain that never lands is forgotten, so its keys
  submit again. A `submit` that rejects with `SubmitRefusedError`, because the
  node refused the transaction, fails that submission at once, and the queue
  keeps chaining on the UTxOs it would have spent. A submit that fails without
  saying whether the node took the transaction (a timeout, a 5xx, an unreadable
  reply) is checked on chain before it is failed, and answered with its hash if
  it landed. `isSpentInputError` recognises the spent/unknown-input rejections
  of cardano-node, Blockfrost, Ogmios and the lucid-evolution Emulator.

## 0.3.0

### Minor Changes

- 48f2049: Make durable off-chain trace storage a first-class concern (#61).

  `@fluxpointstudios/orynq-sdk-storage-adapters`:

  - `pinTraceFor(manifest, { adapters, redundancy })` — pin a manifest + chunk
    artifacts to multiple backends in parallel with an `all`/`any`/`quorum` policy,
    returning every backend's `StorageRef`.
  - `createS3WormAdapter({ bucket, region, retentionYears })` + S3 `objectLock` config
    — AWS Object Lock (WORM) retention for regulatory-grade durability.

  `@fluxpointstudios/orynq-sdk-anchors-cardano`:

  - Optional `storageRefs[]` on `AnchorEntry` (carried in label-2222 metadata,
    built/validated/parsed) so a trace is self-locating from its txHash.
  - `verifyAnchor(provider, txHash, root, { fetchBundle: true })` auto-fetches the
    bundle from the anchor's storage refs (ipfs/ar/https gateways) and attaches it as
    `result.bundle`, with a rootHash integrity check.

  Both are backward compatible — all new fields/options are optional. See
  `docs/durable-storage.md` for the cost-per-year comparison and the retention-bond
  pattern for IPFS pinning.

### Patch Changes

- Updated dependencies [48f2049]
- Updated dependencies [48f2049]
- Updated dependencies [2efef73]
- Updated dependencies [48f2049]
  - @fluxpointstudios/orynq-sdk-process-trace@0.3.0
