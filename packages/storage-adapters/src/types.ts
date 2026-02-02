/**
 * Types for storage adapters.
 */

// === Storage Types ===

export type StorageType = "local" | "ipfs" | "s3" | "arweave";

export interface StorageRef {
  type: StorageType;
  uri: string;
  hash: string;
  size: number;
}

// === Manifest Interface ===

/**
 * Minimal manifest interface for storage operations.
 * Compatible with ManifestV2 from flight-recorder.
 */
export interface StorableManifest {
  formatVersion: string;
  sessionId: string;
  manifestHash?: string;
  [key: string]: unknown;
}

// === Storage Adapter Interface ===

export interface StorageAdapter {
  readonly type: StorageType;

  /**
   * Store raw data.
   */
  store(data: Uint8Array): Promise<StorageRef>;

  /**
   * Store a manifest.
   */
  storeManifest(manifest: StorableManifest): Promise<StorageRef>;

  /**
   * Fetch data by reference.
   */
  fetch(ref: StorageRef): Promise<Uint8Array>;

  /**
   * Fetch a manifest by reference.
   */
  fetchManifest(ref: StorageRef): Promise<StorableManifest>;

  /**
   * Verify data integrity.
   */
  verify(ref: StorageRef): Promise<boolean>;

  /**
   * Delete data (optional).
   */
  delete?(ref: StorageRef): Promise<void>;

  /**
   * Pin data for persistence (optional).
   */
  pin?(ref: StorageRef): Promise<void>;
}

// === IPFS Configuration ===

export interface IpfsAdapterConfig {
  /**
   * IPFS gateway URL for reading (e.g., "https://ipfs.io").
   */
  gateway: string;

  /**
   * IPFS API endpoint for writing (e.g., "http://localhost:5001").
   * Required for storing data.
   */
  apiEndpoint?: string;

  /**
   * Pinning service configuration.
   */
  pinningService?: PinningServiceConfig;

  /**
   * Request timeout in milliseconds.
   */
  timeoutMs?: number;
}

export interface PinningServiceConfig {
  name: "pinata" | "infura" | "web3.storage" | "custom";
  apiKey: string;
  apiSecret?: string;
  endpoint?: string;
}

// === S3 Configuration ===

export interface S3AdapterConfig {
  /**
   * S3 bucket name.
   */
  bucket: string;

  /**
   * AWS region.
   */
  region: string;

  /**
   * Optional prefix for all keys.
   */
  prefix?: string;

  /**
   * AWS credentials.
   */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };

  /**
   * Custom endpoint (for S3-compatible services).
   */
  endpoint?: string;

  /**
   * Enable server-side encryption.
   */
  serverSideEncryption?: boolean;

  /**
   * Presigned URL expiry in seconds (default: 3600).
   */
  presignedUrlExpiry?: number;
}

// === Arweave Configuration ===

export interface ArweaveAdapterConfig {
  /**
   * Arweave gateway URL (default: "https://arweave.net").
   */
  gateway?: string;

  /**
   * JWK wallet for signing transactions.
   */
  wallet?: ArweaveWallet;

  /**
   * Bundlr/Irys configuration for bundled uploads.
   */
  bundlr?: BundlrConfig;

  /**
   * Request timeout in milliseconds.
   */
  timeoutMs?: number;
}

export interface ArweaveWallet {
  kty: string;
  n: string;
  e: string;
  d?: string;
  p?: string;
  q?: string;
  dp?: string;
  dq?: string;
  qi?: string;
}

export interface BundlrConfig {
  url: string;
  currency: "arweave" | "matic" | "ethereum";
  providerUrl?: string;
}

// === Replication Configuration ===

export interface ReplicationConfig {
  /**
   * Storage adapters to replicate to.
   */
  adapters: StorageAdapter[];

  /**
   * Strategy for handling failures.
   */
  strategy: "all" | "any" | "quorum";

  /**
   * Minimum number of successful stores for quorum strategy.
   */
  quorum?: number;

  /**
   * Retry configuration.
   */
  retry?: {
    maxAttempts: number;
    delayMs: number;
    backoffMultiplier: number;
  };
}

// === Error Codes ===

export enum StorageError {
  STORE_FAILED = 2001,
  FETCH_FAILED = 2002,
  NOT_FOUND = 2003,
  VERIFICATION_FAILED = 2004,
  DELETE_FAILED = 2005,
  PIN_FAILED = 2006,
  TIMEOUT = 2007,
  INVALID_CONFIG = 2008,
  REPLICATION_FAILED = 2009,
}

export class StorageException extends Error {
  constructor(
    public readonly code: StorageError,
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "StorageException";
  }
}
