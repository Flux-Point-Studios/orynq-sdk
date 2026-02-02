/**
 * PoI Storage Adapters
 *
 * Content-addressed storage backends for PoI SDK.
 * Supports IPFS, S3, and Arweave.
 *
 * @example
 * ```typescript
 * import { IpfsAdapter, S3Adapter, ReplicatedStorageAdapter } from '@fluxpointstudios/poi-sdk-storage-adapters';
 *
 * // Single adapter usage
 * const ipfs = new IpfsAdapter({
 *   gateway: 'https://ipfs.io',
 *   pinningService: {
 *     name: 'pinata',
 *     apiKey: process.env.PINATA_API_KEY!,
 *   },
 * });
 *
 * const ref = await ipfs.store(data);
 * console.log('Stored at:', ref.uri);
 *
 * // Replication across multiple backends
 * const replicated = new ReplicatedStorageAdapter({
 *   adapters: [ipfsAdapter, s3Adapter],
 *   strategy: 'all',
 * });
 *
 * const ref = await replicated.store(data);
 * ```
 *
 * @packageDocumentation
 */

// === Core Types ===
export type {
  StorageType,
  StorageRef,
  StorableManifest,
  StorageAdapter,
  IpfsAdapterConfig,
  PinningServiceConfig,
  S3AdapterConfig,
  ArweaveAdapterConfig,
  ArweaveWallet,
  BundlrConfig,
  ReplicationConfig,
} from "./types.js";

export { StorageError, StorageException } from "./types.js";

// === IPFS Adapter ===
export {
  IpfsAdapter,
  createIpfsAdapter,
  type PinningService,
  PinataPinningService,
  InfuraPinningService,
  Web3StoragePinningService,
  createPinningService,
} from "./adapters/ipfs/index.js";

// === S3 Adapter ===
export {
  S3Adapter,
  createS3Adapter,
  type S3Client,
} from "./adapters/s3/index.js";

// === Arweave Adapter ===
export {
  ArweaveAdapter,
  createArweaveAdapter,
} from "./adapters/arweave/index.js";

// === Utilities ===
export {
  sha256,
  sha256Raw,
  contentId,
  validateContentHash,
  parseIpfsCid,
  parseArweaveId,
  parseS3Key,
  buildStorageUri,
  HASH_DOMAIN_PREFIXES,
  type HashDomain,
  ReplicatedStorageAdapter,
} from "./utils/index.js";
