# @fluxpointstudios/poi-sdk-storage-adapters

## 0.2.1

### Patch Changes

- Updated dependencies [ffa932e]
  - @fluxpointstudios/orynq-sdk-core@0.3.2

## 0.2.0

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

## 0.1.0

### Minor Changes

- 5a2687e: feat: Add storage-adapters package for cloud storage backends

  New package implementing content-addressed storage adapters for PoI SDK:

  - **IPFS Adapter**: Store and fetch data on IPFS with gateway support

    - Pinata, Infura, and web3.storage pinning service integrations
    - Automatic pinning and CID management

  - **S3 Adapter**: Store data on AWS S3 or S3-compatible services

    - Presigned URL generation for secure uploads/downloads
    - Server-side encryption support

  - **Arweave Adapter**: Permanent storage on Arweave network

    - Gateway-based reading with fallback to direct node access
    - Transaction status checking

  - **Replication Utility**: Store data across multiple backends

    - Strategies: "all", "any", or "quorum"
    - Automatic retry with exponential backoff
    - Parallel writes for performance

  - **Content Addressing Utilities**:
    - SHA-256 hashing with domain separation
    - URI parsing for IPFS, S3, and Arweave
    - Content hash validation
