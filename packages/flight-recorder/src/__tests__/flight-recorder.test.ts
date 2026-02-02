/**
 * Tests for flight-recorder package.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FlightRecorder } from "../recorder/stream-recorder.js";
import { LocalStorageAdapter } from "../storage/local-adapter.js";
import { sha256String, buildMerkleRoot, merkleLeaf } from "../crypto/hashing.js";
import { generateKey, encrypt, decrypt } from "../crypto/encryption.js";
import { compress, decompress } from "../crypto/compression.js";
import type { RecorderConfig, StorageAdapter, StorageRef, ManifestV2 } from "../types.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("Crypto utilities", () => {
  describe("sha256", () => {
    it("should hash strings consistently", async () => {
      const hash1 = await sha256String("hello");
      const hash2 = await sha256String("hello");
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // 32 bytes hex
    });

    it("should produce different hashes for different inputs", async () => {
      const hash1 = await sha256String("hello");
      const hash2 = await sha256String("world");
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("encryption", () => {
    it("should encrypt and decrypt data", async () => {
      const key = await generateKey();
      const plaintext = new TextEncoder().encode("secret message");

      const encrypted = await encrypt(plaintext, key);
      expect(encrypted.ciphertext).not.toEqual(plaintext);

      const decrypted = await decrypt(encrypted, key);
      expect(new TextDecoder().decode(decrypted)).toBe("secret message");
    });

    it("should encrypt with additional data", async () => {
      const key = await generateKey();
      const plaintext = new TextEncoder().encode("secret");
      const aad = new TextEncoder().encode("metadata");

      const encrypted = await encrypt(plaintext, key, aad);
      const decrypted = await decrypt(encrypted, key, aad);
      expect(new TextDecoder().decode(decrypted)).toBe("secret");
    });
  });

  describe("compression", () => {
    it("should compress and decompress data", async () => {
      const original = new TextEncoder().encode("hello world ".repeat(100));
      const compressed = await compress(original, "gzip");
      expect(compressed.data.length).toBeLessThan(original.length);

      const decompressed = await decompress(compressed.data, "gzip");
      expect(new TextDecoder().decode(decompressed)).toBe("hello world ".repeat(100));
    });
  });

  describe("merkle tree", () => {
    it("should build merkle root from leaf hashes", async () => {
      const leaves = await Promise.all([
        merkleLeaf(new TextEncoder().encode("leaf1")),
        merkleLeaf(new TextEncoder().encode("leaf2")),
        merkleLeaf(new TextEncoder().encode("leaf3")),
      ]);

      const root = await buildMerkleRoot(leaves);
      expect(root).toHaveLength(64);
    });

    it("should return empty tree hash for empty leaves", async () => {
      const root = await buildMerkleRoot([]);
      expect(root).toHaveLength(64);
    });
  });
});

describe("LocalStorageAdapter", () => {
  let tmpDir: string;
  let adapter: LocalStorageAdapter;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flight-recorder-test-"));
    adapter = new LocalStorageAdapter({ baseDir: tmpDir });
  });

  it("should store and fetch data", async () => {
    const data = new TextEncoder().encode("test data");
    const ref = await adapter.store(data);

    expect(ref.type).toBe("local");
    expect(ref.hash).toHaveLength(64);
    expect(ref.size).toBe(data.length);

    const fetched = await adapter.fetch(ref);
    expect(new TextDecoder().decode(fetched)).toBe("test data");
  });

  it("should verify stored data", async () => {
    const data = new TextEncoder().encode("test data");
    const ref = await adapter.store(data);

    const valid = await adapter.verify(ref);
    expect(valid).toBe(true);
  });
});

describe("FlightRecorder", () => {
  let tmpDir: string;
  let storage: LocalStorageAdapter;
  let config: RecorderConfig;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flight-recorder-test-"));
    storage = new LocalStorageAdapter({ baseDir: tmpDir });
    config = {
      agentId: "test-agent",
      chunkSizeBytes: 1024,
      encryption: {
        algorithm: "aes-256-gcm",
        keyDerivation: "hkdf-sha256",
        keyMode: { type: "ephemeral" },
      },
      storage,
    };
  });

  it("should start a recording session", async () => {
    const recorder = new FlightRecorder(config);
    const session = await recorder.start();

    expect(session.agentId).toBe("test-agent");
    expect(session.status).toBe("recording");
    expect(session.sessionId).toBeDefined();
  });

  it("should record events", async () => {
    const recorder = new FlightRecorder(config);
    await recorder.start();

    await recorder.record({
      kind: "inference:start",
      requestId: "req-1",
      model: "test-model",
      promptHash: "abc123",
      params: { temperature: 0.7 },
    });

    await recorder.record({
      kind: "inference:end",
      requestId: "req-1",
      outputHash: "def456",
      tokenCounts: { prompt: 10, completion: 20 },
      durationMs: 100,
    });

    const result = await recorder.finalize();

    expect(result.manifest.formatVersion).toBe("2.0");
    expect(result.manifest.agentId).toBe("test-agent");
    expect(result.manifest.totalEvents).toBe(2);
    expect(result.rootHash).toHaveLength(64);
  });

  it("should manage spans", async () => {
    const recorder = new FlightRecorder(config);
    await recorder.start();

    const spanId = recorder.startSpan("test-span");
    expect(spanId).toBeDefined();

    await recorder.record({
      kind: "inference:start",
      requestId: "req-1",
      model: "test-model",
      promptHash: "abc123",
      params: {},
      spanId,
    });

    recorder.endSpan(spanId);

    const result = await recorder.finalize();
    expect(result.manifest.totalSpans).toBe(1);
  });

  it("should abort recording", async () => {
    const recorder = new FlightRecorder(config);
    await recorder.start();

    await recorder.record({
      kind: "inference:start",
      requestId: "req-1",
      model: "test-model",
      promptHash: "abc123",
      params: {},
    });

    await recorder.abort("test abort");

    const session = recorder.getSession();
    expect(session?.status).toBe("aborted");
  });
});
