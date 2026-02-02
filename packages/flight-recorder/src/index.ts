/**
 * @fluxpointstudios/poi-sdk-flight-recorder
 *
 * Streaming flight recorder for Proof of Inference (PoI).
 * Captures inference events with chunking, compression, and encryption.
 *
 * @example
 * ```typescript
 * import { FlightRecorder, LocalStorageAdapter } from '@fluxpointstudios/poi-sdk-flight-recorder';
 *
 * const storage = new LocalStorageAdapter({ baseDir: './traces' });
 *
 * const recorder = new FlightRecorder({
 *   agentId: 'my-agent',
 *   chunkSizeBytes: 4 * 1024 * 1024, // 4MB chunks
 *   encryption: {
 *     algorithm: 'aes-256-gcm',
 *     keyDerivation: 'hkdf-sha256',
 *     keyMode: { type: 'ephemeral' },
 *   },
 *   storage,
 * });
 *
 * await recorder.start();
 *
 * await recorder.record({
 *   kind: 'inference:start',
 *   requestId: 'req-123',
 *   model: 'claude-3-opus',
 *   promptHash: '...',
 *   params: { temperature: 0.7 },
 * });
 *
 * const result = await recorder.finalize();
 * console.log('Manifest:', result.manifest);
 * ```
 */

// Types
export * from "./types.js";

// Core recorder
export { FlightRecorder } from "./recorder/stream-recorder.js";
export { EventBuffer } from "./recorder/event-buffer.js";
export { ChunkManager } from "./recorder/chunk-manager.js";

// Crypto utilities
export {
  generateKey,
  encrypt,
  decrypt,
  exportKey,
  importKey,
  deriveKey,
  type EncryptionKey,
  type EncryptedData,
} from "./crypto/encryption.js";

export {
  compress,
  decompress,
  compressString,
  decompressString,
  isCompressible,
  type CompressionType,
  type CompressionResult,
} from "./crypto/compression.js";

export {
  sha256,
  sha256String,
  sha256Json,
  rollingHash,
  merkleLeaf,
  merkleNode,
  buildMerkleRoot,
  generateMerkleProof,
  verifyMerkleProof,
  HASH_DOMAINS,
  type HashDomain,
  type MerkleProof,
} from "./crypto/hashing.js";

// Manifest
export { ManifestBuilder, type ManifestInput } from "./manifest/manifest-builder.js";

// Storage
export { LocalStorageAdapter, type LocalStorageConfig } from "./storage/local-adapter.js";

// Integration
export {
  OpenClawAdapter,
  type LegacyTraceEvent,
  type LegacyTraceBundle,
  type LegacyManifest,
} from "./integration/openclaw-adapter.js";
