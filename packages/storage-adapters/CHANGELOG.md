# @fluxpointstudios/poi-sdk-storage-adapters

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
