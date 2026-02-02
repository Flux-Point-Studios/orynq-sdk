/**
 * Chunk manager for the flight recorder.
 * Handles chunk creation, compression, encryption, and storage.
 */

import type {
  ChunkRef,
  ChunkData,
  StorageAdapter,
  EncryptionConfig,
} from "../types.js";
import { generateKey, encrypt, type EncryptionKey } from "../crypto/encryption.js";
import { compress, type CompressionType } from "../crypto/compression.js";
import { sha256, merkleLeaf } from "../crypto/hashing.js";
import type { BufferedEvent } from "./event-buffer.js";

export interface ChunkCreateResult {
  chunkRef: ChunkRef;
  chunkData: ChunkData;
  leafHash: string;
}

export class ChunkManager {
  private chunks: ChunkRef[] = [];
  private leafHashes: string[] = [];
  private chunkIndex = 0;
  private encryptionKey: EncryptionKey | null = null;

  constructor(
    private readonly storage: StorageAdapter,
    private readonly encryptionConfig: EncryptionConfig,
    private readonly compressionType: CompressionType = "gzip"
  ) {}

  /**
   * Initialize encryption key for the session.
   */
  async initializeKey(): Promise<void> {
    this.encryptionKey = await generateKey(this.encryptionConfig.algorithm);
  }

  /**
   * Get the current encryption key ID.
   */
  getKeyId(): string | null {
    return this.encryptionKey?.keyId ?? null;
  }

  /**
   * Create a chunk from buffered events.
   */
  async createChunk(
    events: BufferedEvent[],
    eventRange: [number, number],
    spanIds: string[]
  ): Promise<ChunkCreateResult> {
    if (!this.encryptionKey) {
      throw new Error("Encryption key not initialized. Call initializeKey() first.");
    }

    // Serialize events to JSONL
    const lines = events.map((e) => JSON.stringify(e.event));
    const jsonl = lines.join("\n");
    const rawData = new TextEncoder().encode(jsonl);

    // Compress
    const compressed = await compress(rawData, this.compressionType);

    // Encrypt
    const chunkMeta = {
      index: this.chunkIndex,
      eventRange,
      spanIds,
      createdAt: new Date().toISOString(),
    };
    const additionalData = new TextEncoder().encode(JSON.stringify(chunkMeta));
    const encrypted = await encrypt(compressed.data, this.encryptionKey, additionalData);

    // Create chunk data structure
    const chunkData: ChunkData = {
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      tag: encrypted.tag,
      meta: chunkMeta,
    };

    // Compute content hash of encrypted data
    const encryptedPayload = new Uint8Array(
      encrypted.ciphertext.length + encrypted.nonce.length + encrypted.tag.length
    );
    encryptedPayload.set(encrypted.ciphertext, 0);
    encryptedPayload.set(encrypted.nonce, encrypted.ciphertext.length);
    encryptedPayload.set(encrypted.tag, encrypted.ciphertext.length + encrypted.nonce.length);

    const chunkHash = await sha256(encryptedPayload, "encryptedChunk");
    const chunkId = `chunk-${this.chunkIndex.toString().padStart(6, "0")}-${chunkHash.slice(0, 16)}`;

    // Store chunk
    const storagePayload = this.serializeChunkForStorage(chunkData);
    const storageRef = await this.storage.store(storagePayload);

    // Create chunk reference
    const chunkRef: ChunkRef = {
      id: chunkId,
      hash: chunkHash,
      size: storagePayload.length,
      storageUri: storageRef.uri,
      encryptionKeyId: this.encryptionKey.keyId,
      compression: this.compressionType === "gzip" ? "gzip" : "none",
    };

    // Compute Merkle leaf hash
    const leafHash = await merkleLeaf(encryptedPayload);

    // Track chunk
    this.chunks.push(chunkRef);
    this.leafHashes.push(leafHash);
    this.chunkIndex++;

    return {
      chunkRef,
      chunkData,
      leafHash,
    };
  }

  /**
   * Get all chunk references.
   */
  getChunks(): ChunkRef[] {
    return [...this.chunks];
  }

  /**
   * Get all Merkle leaf hashes.
   */
  getLeafHashes(): string[] {
    return [...this.leafHashes];
  }

  /**
   * Get chunk count.
   */
  getChunkCount(): number {
    return this.chunks.length;
  }

  /**
   * Serialize chunk data for storage.
   * Format: [4-byte meta length][meta JSON][nonce][tag][ciphertext]
   */
  private serializeChunkForStorage(chunk: ChunkData): Uint8Array {
    const metaJson = JSON.stringify(chunk.meta);
    const metaBytes = new TextEncoder().encode(metaJson);
    const metaLength = new Uint32Array([metaBytes.length]);
    const metaLengthBytes = new Uint8Array(metaLength.buffer);

    const totalLength =
      4 + // meta length
      metaBytes.length +
      chunk.nonce.length +
      chunk.tag.length +
      chunk.ciphertext.length;

    const result = new Uint8Array(totalLength);
    let offset = 0;

    result.set(metaLengthBytes, offset);
    offset += 4;

    result.set(metaBytes, offset);
    offset += metaBytes.length;

    result.set(chunk.nonce, offset);
    offset += chunk.nonce.length;

    result.set(chunk.tag, offset);
    offset += chunk.tag.length;

    result.set(chunk.ciphertext, offset);

    return result;
  }

  /**
   * Deserialize chunk data from storage.
   */
  static deserializeChunkFromStorage(data: Uint8Array): ChunkData {
    let offset = 0;

    // Read meta length
    const metaLengthBytes = data.slice(offset, offset + 4);
    const metaLengthArr = new Uint32Array(metaLengthBytes.buffer);
    const metaLength = metaLengthArr[0];
    if (metaLength === undefined) {
      throw new Error("Invalid chunk data: missing meta length");
    }
    offset += 4;

    // Read meta
    const metaBytes = data.slice(offset, offset + metaLength);
    const metaJson = new TextDecoder().decode(metaBytes);
    const meta = JSON.parse(metaJson) as ChunkData["meta"];
    offset += metaLength;

    // Read nonce (12 bytes for AES-GCM)
    const nonce = data.slice(offset, offset + 12);
    offset += 12;

    // Read tag (16 bytes)
    const tag = data.slice(offset, offset + 16);
    offset += 16;

    // Read ciphertext (rest)
    const ciphertext = data.slice(offset);

    return {
      ciphertext,
      nonce,
      tag,
      meta,
    };
  }
}
