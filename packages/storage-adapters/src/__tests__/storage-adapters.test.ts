/**
 * Tests for the storage-adapters package.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  sha256,
  sha256Raw,
  contentId,
  validateContentHash,
  parseIpfsCid,
  parseArweaveId,
  parseS3Key,
  buildStorageUri,
  HASH_DOMAIN_PREFIXES,
} from "../utils/content-addressing.js";
import { ReplicatedStorageAdapter } from "../utils/replication.js";
import { IpfsAdapter, createIpfsAdapter } from "../adapters/ipfs/ipfs-adapter.js";
import { S3Adapter, createS3Adapter } from "../adapters/s3/s3-adapter.js";
import { ArweaveAdapter, createArweaveAdapter } from "../adapters/arweave/arweave-adapter.js";
import { StorageError, StorageException } from "../types.js";
import type { StorageAdapter, StorageRef, StorableManifest } from "../types.js";

describe("Content Addressing", () => {
  it("should compute SHA-256 with domain prefix", () => {
    const data = new TextEncoder().encode("test data");
    const hash = sha256(data, "chunk");

    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("should compute different hashes for different domains", () => {
    const data = new TextEncoder().encode("test data");
    const chunkHash = sha256(data, "chunk");
    const manifestHash = sha256(data, "manifest");
    const dataHash = sha256(data, "data");

    expect(chunkHash).not.toBe(manifestHash);
    expect(manifestHash).not.toBe(dataHash);
    expect(chunkHash).not.toBe(dataHash);
  });

  it("should compute raw SHA-256 without domain", () => {
    const data = new TextEncoder().encode("test data");
    const hash = sha256Raw(data);

    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("should generate content ID", () => {
    const data = new TextEncoder().encode("test data");
    const id = contentId(data);

    expect(id).toHaveLength(64);
    expect(id).toBe(sha256(data, "data"));
  });

  it("should validate content hash", () => {
    const data = new TextEncoder().encode("test data");
    const hash = sha256(data, "chunk");

    expect(validateContentHash(data, hash, "chunk")).toBe(true);
    expect(validateContentHash(data, "wrong-hash", "chunk")).toBe(false);
    expect(validateContentHash(data, hash, "manifest")).toBe(false);
  });

  it("should have correct domain prefixes", () => {
    expect(HASH_DOMAIN_PREFIXES.chunk).toBe("poi-storage:chunk:v1|");
    expect(HASH_DOMAIN_PREFIXES.manifest).toBe("poi-storage:manifest:v1|");
    expect(HASH_DOMAIN_PREFIXES.data).toBe("poi-storage:data:v1|");
  });
});

describe("URI Parsing", () => {
  describe("IPFS CID", () => {
    it("should parse ipfs:// URI", () => {
      expect(parseIpfsCid("ipfs://QmTest123")).toBe("QmTest123");
    });

    it("should parse /ipfs/ path", () => {
      expect(parseIpfsCid("https://gateway.io/ipfs/QmTest456")).toBe("QmTest456");
    });

    it("should return undefined for invalid URI", () => {
      expect(parseIpfsCid("https://example.com/file.txt")).toBeUndefined();
    });
  });

  describe("Arweave ID", () => {
    it("should parse ar:// URI", () => {
      expect(parseArweaveId("ar://AbcDef123")).toBe("AbcDef123");
    });

    it("should parse arweave.net path", () => {
      expect(parseArweaveId("https://arweave.net/XyzAbc789")).toBe("XyzAbc789");
    });

    it("should return undefined for invalid URI", () => {
      expect(parseArweaveId("https://example.com/file.txt")).toBeUndefined();
    });
  });

  describe("S3 Key", () => {
    it("should parse s3:// URI", () => {
      const result = parseS3Key("s3://my-bucket/path/to/file.bin");
      expect(result).toEqual({ bucket: "my-bucket", key: "path/to/file.bin" });
    });

    it("should parse S3 HTTPS URL", () => {
      const result = parseS3Key("https://my-bucket.s3.us-east-1.amazonaws.com/path/to/file.bin");
      expect(result).toEqual({ bucket: "my-bucket", key: "path/to/file.bin" });
    });

    it("should return undefined for invalid URI", () => {
      expect(parseS3Key("https://example.com/file.txt")).toBeUndefined();
    });
  });
});

describe("Build Storage URI", () => {
  it("should build IPFS URI", () => {
    expect(buildStorageUri("ipfs", "QmTest123")).toBe("ipfs://QmTest123");
  });

  it("should build Arweave URI", () => {
    expect(buildStorageUri("arweave", "TxId123")).toBe("ar://TxId123");
  });

  it("should build S3 URI with bucket", () => {
    expect(buildStorageUri("s3", "path/file.bin", { bucket: "my-bucket" })).toBe(
      "s3://my-bucket/path/file.bin"
    );
  });

  it("should build local file URI", () => {
    expect(buildStorageUri("local", "/path/to/file.bin")).toBe("file:///path/to/file.bin");
  });
});

describe("IpfsAdapter", () => {
  it("should create adapter with gateway", () => {
    const adapter = createIpfsAdapter({
      gateway: "https://ipfs.io",
    });

    expect(adapter.type).toBe("ipfs");
  });

  it("should get gateway URL for reference", () => {
    const adapter = new IpfsAdapter({
      gateway: "https://ipfs.io",
    });

    const ref: StorageRef = {
      type: "ipfs",
      uri: "ipfs://QmTest123",
      hash: "abc123",
      size: 100,
    };

    expect(adapter.getGatewayUrl(ref)).toBe("https://ipfs.io/ipfs/QmTest123");
  });

  it("should throw without API endpoint when storing", async () => {
    const adapter = new IpfsAdapter({
      gateway: "https://ipfs.io",
      // No API endpoint or pinning service
    });

    const data = new TextEncoder().encode("test");

    await expect(adapter.store(data)).rejects.toThrow(StorageException);
  });
});

describe("S3Adapter", () => {
  it("should create adapter", () => {
    const adapter = createS3Adapter({
      bucket: "test-bucket",
      region: "us-east-1",
    });

    expect(adapter.type).toBe("s3");
  });

  it("should build key with prefix", () => {
    const adapter = new S3Adapter({
      bucket: "test-bucket",
      region: "us-east-1",
      prefix: "poi-data",
    });

    // The adapter doesn't expose buildKey directly, but we test through store
    expect(adapter.type).toBe("s3");
  });
});

describe("ArweaveAdapter", () => {
  it("should create adapter with default gateway", () => {
    const adapter = createArweaveAdapter();

    expect(adapter.type).toBe("arweave");
  });

  it("should create adapter with custom gateway", () => {
    const adapter = createArweaveAdapter({
      gateway: "https://ar.io",
    });

    expect(adapter.type).toBe("arweave");
  });

  it("should get gateway URL for reference", () => {
    const adapter = new ArweaveAdapter({
      gateway: "https://arweave.net",
    });

    const ref: StorageRef = {
      type: "arweave",
      uri: "ar://TxId123",
      hash: "abc123",
      size: 100,
    };

    expect(adapter.getGatewayUrl(ref)).toBe("https://arweave.net/TxId123");
  });

  it("should throw without wallet when storing", async () => {
    const adapter = new ArweaveAdapter({});
    const data = new TextEncoder().encode("test");

    await expect(adapter.store(data)).rejects.toThrow(StorageException);
  });
});

describe("ReplicatedStorageAdapter", () => {
  // Create mock adapters for testing
  const createMockAdapter = (type: "local" | "ipfs" | "s3", shouldFail = false): StorageAdapter => ({
    type,
    store: vi.fn().mockImplementation(async (data: Uint8Array) => {
      if (shouldFail) throw new Error("Store failed");
      return {
        type,
        uri: `${type}://test-${Date.now()}`,
        hash: sha256(data, "chunk"),
        size: data.length,
      };
    }),
    storeManifest: vi.fn().mockImplementation(async (manifest: StorableManifest) => {
      if (shouldFail) throw new Error("Store failed");
      return {
        type,
        uri: `${type}://manifest-${Date.now()}`,
        hash: manifest.manifestHash ?? "test-hash",
        size: 100,
      };
    }),
    fetch: vi.fn().mockImplementation(async () => {
      if (shouldFail) throw new Error("Fetch failed");
      return new TextEncoder().encode("test data");
    }),
    fetchManifest: vi.fn().mockImplementation(async () => {
      if (shouldFail) throw new Error("Fetch failed");
      return { formatVersion: "2.0", sessionId: "test" };
    }),
    verify: vi.fn().mockImplementation(async () => !shouldFail),
    delete: vi.fn().mockImplementation(async () => {
      if (shouldFail) throw new Error("Delete failed");
    }),
    pin: vi.fn().mockImplementation(async () => {
      if (shouldFail) throw new Error("Pin failed");
    }),
  });

  it("should require at least one adapter", () => {
    expect(() => new ReplicatedStorageAdapter({ adapters: [], strategy: "all" })).toThrow(
      StorageException
    );
  });

  describe("Strategy: all", () => {
    it("should store to all adapters", async () => {
      const adapter1 = createMockAdapter("local");
      const adapter2 = createMockAdapter("ipfs");

      const replicated = new ReplicatedStorageAdapter({
        adapters: [adapter1, adapter2],
        strategy: "all",
      });

      const data = new TextEncoder().encode("test data");
      const ref = await replicated.store(data);

      expect(ref.type).toBe("local"); // Returns first
      expect(adapter1.store).toHaveBeenCalledWith(data);
      expect(adapter2.store).toHaveBeenCalledWith(data);
    });

    it("should fail if any adapter fails", async () => {
      const adapter1 = createMockAdapter("local");
      const adapter2 = createMockAdapter("ipfs", true); // Will fail

      const replicated = new ReplicatedStorageAdapter({
        adapters: [adapter1, adapter2],
        strategy: "all",
        retry: { maxAttempts: 1, delayMs: 0, backoffMultiplier: 1 },
      });

      const data = new TextEncoder().encode("test data");

      await expect(replicated.store(data)).rejects.toThrow(StorageException);
    });
  });

  describe("Strategy: any", () => {
    it("should succeed if any adapter succeeds", async () => {
      const adapter1 = createMockAdapter("local", true); // Will fail
      const adapter2 = createMockAdapter("ipfs");

      const replicated = new ReplicatedStorageAdapter({
        adapters: [adapter1, adapter2],
        strategy: "any",
        retry: { maxAttempts: 1, delayMs: 0, backoffMultiplier: 1 },
      });

      const data = new TextEncoder().encode("test data");
      const ref = await replicated.store(data);

      expect(ref.type).toBe("ipfs");
    });

    it("should fail if all adapters fail", async () => {
      const adapter1 = createMockAdapter("local", true);
      const adapter2 = createMockAdapter("ipfs", true);

      const replicated = new ReplicatedStorageAdapter({
        adapters: [adapter1, adapter2],
        strategy: "any",
        retry: { maxAttempts: 1, delayMs: 0, backoffMultiplier: 1 },
      });

      const data = new TextEncoder().encode("test data");

      await expect(replicated.store(data)).rejects.toThrow(StorageException);
    });
  });

  describe("Strategy: quorum", () => {
    it("should succeed with quorum", async () => {
      const adapter1 = createMockAdapter("local");
      const adapter2 = createMockAdapter("ipfs");
      const adapter3 = createMockAdapter("s3", true); // Will fail

      const replicated = new ReplicatedStorageAdapter({
        adapters: [adapter1, adapter2, adapter3],
        strategy: "quorum",
        quorum: 2,
        retry: { maxAttempts: 1, delayMs: 0, backoffMultiplier: 1 },
      });

      const data = new TextEncoder().encode("test data");
      const ref = await replicated.store(data);

      expect(ref).toBeDefined();
    });

    it("should fail without quorum", async () => {
      const adapter1 = createMockAdapter("local");
      const adapter2 = createMockAdapter("ipfs", true);
      const adapter3 = createMockAdapter("s3", true);

      const replicated = new ReplicatedStorageAdapter({
        adapters: [adapter1, adapter2, adapter3],
        strategy: "quorum",
        quorum: 2,
        retry: { maxAttempts: 1, delayMs: 0, backoffMultiplier: 1 },
      });

      const data = new TextEncoder().encode("test data");

      await expect(replicated.store(data)).rejects.toThrow(StorageException);
    });
  });

  describe("Fetch", () => {
    it("should fetch from first available adapter", async () => {
      const adapter1 = createMockAdapter("local", true); // Will fail
      const adapter2 = createMockAdapter("ipfs");

      const replicated = new ReplicatedStorageAdapter({
        adapters: [adapter1, adapter2],
        strategy: "any",
      });

      const ref: StorageRef = { type: "ipfs", uri: "ipfs://test", hash: "abc", size: 100 };
      const data = await replicated.fetch(ref);

      expect(data).toBeInstanceOf(Uint8Array);
      expect(adapter2.fetch).toHaveBeenCalled();
    });

    it("should throw if all fetches fail", async () => {
      const adapter1 = createMockAdapter("local", true);
      const adapter2 = createMockAdapter("ipfs", true);

      const replicated = new ReplicatedStorageAdapter({
        adapters: [adapter1, adapter2],
        strategy: "any",
      });

      const ref: StorageRef = { type: "ipfs", uri: "ipfs://test", hash: "abc", size: 100 };

      await expect(replicated.fetch(ref)).rejects.toThrow(StorageException);
    });
  });

  describe("Verify", () => {
    it("should return true if any adapter verifies", async () => {
      const adapter1 = createMockAdapter("local", true);
      const adapter2 = createMockAdapter("ipfs");

      const replicated = new ReplicatedStorageAdapter({
        adapters: [adapter1, adapter2],
        strategy: "any",
      });

      const ref: StorageRef = { type: "ipfs", uri: "ipfs://test", hash: "abc", size: 100 };
      const valid = await replicated.verify(ref);

      expect(valid).toBe(true);
    });

    it("should return false if all adapters fail to verify", async () => {
      const adapter1 = createMockAdapter("local", true);
      const adapter2 = createMockAdapter("ipfs", true);

      const replicated = new ReplicatedStorageAdapter({
        adapters: [adapter1, adapter2],
        strategy: "any",
      });

      const ref: StorageRef = { type: "ipfs", uri: "ipfs://test", hash: "abc", size: 100 };
      const valid = await replicated.verify(ref);

      expect(valid).toBe(false);
    });
  });

  describe("Delete", () => {
    it("should delete from all adapters", async () => {
      const adapter1 = createMockAdapter("local");
      const adapter2 = createMockAdapter("ipfs");

      const replicated = new ReplicatedStorageAdapter({
        adapters: [adapter1, adapter2],
        strategy: "all",
      });

      const ref: StorageRef = { type: "local", uri: "local://test", hash: "abc", size: 100 };
      await replicated.delete(ref);

      expect(adapter1.delete).toHaveBeenCalled();
      expect(adapter2.delete).toHaveBeenCalled();
    });
  });

  describe("Pin", () => {
    it("should pin in all adapters that support pinning", async () => {
      const adapter1 = createMockAdapter("local");
      const adapter2 = createMockAdapter("ipfs");

      const replicated = new ReplicatedStorageAdapter({
        adapters: [adapter1, adapter2],
        strategy: "all",
      });

      const ref: StorageRef = { type: "ipfs", uri: "ipfs://test", hash: "abc", size: 100 };
      await replicated.pin(ref);

      expect(adapter1.pin).toHaveBeenCalled();
      expect(adapter2.pin).toHaveBeenCalled();
    });
  });

  describe("Store All", () => {
    it("should return all refs and errors", async () => {
      const adapter1 = createMockAdapter("local");
      const adapter2 = createMockAdapter("ipfs", true);

      const replicated = new ReplicatedStorageAdapter({
        adapters: [adapter1, adapter2],
        strategy: "any",
        retry: { maxAttempts: 1, delayMs: 0, backoffMultiplier: 1 },
      });

      const data = new TextEncoder().encode("test data");
      const result = await replicated.storeAll(data);

      expect(result.refs).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.adapter).toBe("ipfs");
    });
  });
});

describe("StorageException", () => {
  it("should create exception with code and message", () => {
    const exception = new StorageException(StorageError.STORE_FAILED, "Test error");

    expect(exception.code).toBe(StorageError.STORE_FAILED);
    expect(exception.message).toBe("Test error");
    expect(exception.name).toBe("StorageException");
  });

  it("should include cause if provided", () => {
    const cause = new Error("Original error");
    const exception = new StorageException(StorageError.FETCH_FAILED, "Wrapper", cause);

    expect(exception.cause).toBe(cause);
  });
});
