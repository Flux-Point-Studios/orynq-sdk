# @fluxpointstudios/orynq-sdk-anchors-cardano

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
- Updated dependencies [48f2049]
  - @fluxpointstudios/orynq-sdk-process-trace@0.2.0
