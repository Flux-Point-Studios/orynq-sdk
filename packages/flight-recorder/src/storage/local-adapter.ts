/**
 * Local filesystem storage adapter for flight recorder.
 * Stores chunks and manifests on the local filesystem.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { StorageAdapter, StorageRef, ManifestV2 } from "../types.js";
import { sha256 } from "../crypto/hashing.js";

export interface LocalStorageConfig {
  baseDir: string;
  createDirs?: boolean;
}

export class LocalStorageAdapter implements StorageAdapter {
  readonly type = "local" as const;
  private initialized = false;

  constructor(private readonly config: LocalStorageConfig) {}

  /**
   * Initialize storage directories.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (this.config.createDirs !== false) {
      await fs.mkdir(path.join(this.config.baseDir, "chunks"), { recursive: true });
      await fs.mkdir(path.join(this.config.baseDir, "manifests"), { recursive: true });
    }

    this.initialized = true;
  }

  /**
   * Store a chunk.
   */
  async store(data: Uint8Array): Promise<StorageRef> {
    await this.initialize();

    const hash = await sha256(data, "chunk");
    const filename = `${hash}.bin`;
    const filepath = path.join(this.config.baseDir, "chunks", filename);

    await fs.writeFile(filepath, data);

    return {
      type: "local",
      uri: `file://${filepath}`,
      hash,
      size: data.length,
    };
  }

  /**
   * Store a manifest.
   */
  async storeManifest(manifest: ManifestV2): Promise<StorageRef> {
    await this.initialize();

    const json = JSON.stringify(manifest, null, 2);
    const data = new TextEncoder().encode(json);
    const hash = manifest.manifestHash || await sha256(data, "manifest");

    const filename = `${manifest.sessionId}-${hash.slice(0, 16)}.json`;
    const filepath = path.join(this.config.baseDir, "manifests", filename);

    await fs.writeFile(filepath, json, "utf-8");

    return {
      type: "local",
      uri: `file://${filepath}`,
      hash,
      size: data.length,
    };
  }

  /**
   * Fetch data by reference.
   */
  async fetch(ref: StorageRef): Promise<Uint8Array> {
    const filepath = this.uriToPath(ref.uri);
    const data = await fs.readFile(filepath);
    return new Uint8Array(data);
  }

  /**
   * Fetch a manifest by reference.
   */
  async fetchManifest(ref: StorageRef): Promise<ManifestV2> {
    const filepath = this.uriToPath(ref.uri);
    const json = await fs.readFile(filepath, "utf-8");
    return JSON.parse(json);
  }

  /**
   * Verify data integrity.
   */
  async verify(ref: StorageRef): Promise<boolean> {
    try {
      const data = await this.fetch(ref);
      const hash = await sha256(data, "chunk");
      return hash === ref.hash;
    } catch {
      return false;
    }
  }

  /**
   * Delete data.
   */
  async delete(ref: StorageRef): Promise<void> {
    const filepath = this.uriToPath(ref.uri);
    await fs.unlink(filepath);
  }

  /**
   * Pin data (no-op for local storage).
   */
  async pin(_ref: StorageRef): Promise<void> {
    // No-op for local storage
  }

  /**
   * List all stored chunks.
   */
  async listChunks(): Promise<string[]> {
    await this.initialize();
    const chunksDir = path.join(this.config.baseDir, "chunks");
    const files = await fs.readdir(chunksDir);
    return files.filter((f) => f.endsWith(".bin"));
  }

  /**
   * List all stored manifests.
   */
  async listManifests(): Promise<string[]> {
    await this.initialize();
    const manifestsDir = path.join(this.config.baseDir, "manifests");
    const files = await fs.readdir(manifestsDir);
    return files.filter((f) => f.endsWith(".json"));
  }

  /**
   * Get storage statistics.
   */
  async getStats(): Promise<{ chunkCount: number; manifestCount: number; totalBytes: number }> {
    await this.initialize();

    const chunks = await this.listChunks();
    const manifests = await this.listManifests();

    let totalBytes = 0;

    for (const chunk of chunks) {
      const filepath = path.join(this.config.baseDir, "chunks", chunk);
      const stat = await fs.stat(filepath);
      totalBytes += stat.size;
    }

    for (const manifest of manifests) {
      const filepath = path.join(this.config.baseDir, "manifests", manifest);
      const stat = await fs.stat(filepath);
      totalBytes += stat.size;
    }

    return {
      chunkCount: chunks.length,
      manifestCount: manifests.length,
      totalBytes,
    };
  }

  private uriToPath(uri: string): string {
    if (uri.startsWith("file://")) {
      return uri.slice(7);
    }
    return uri;
  }
}
