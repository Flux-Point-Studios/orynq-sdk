/**
 * @summary Tests for durable trace pinning + S3-WORM retention (issue #61).
 */

import { describe, it, expect, vi } from "vitest";
import {
  pinTraceFor,
  createS3WormAdapter,
  computeObjectLockRetainUntil,
  type StorageAdapter,
  type StorableManifest,
  type StorageRef,
} from "../index.js";

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

function mockAdapter(type: "ipfs" | "s3" | "arweave", shouldFail = false): StorageAdapter {
  return {
    type,
    store: vi.fn().mockImplementation(async (data: Uint8Array): Promise<StorageRef> => {
      if (shouldFail) throw new Error(`${type} store failed`);
      return { type, uri: `${type}://chunk-${data.length}`, hash: "h", size: data.length };
    }),
    storeManifest: vi.fn().mockImplementation(async (m: StorableManifest): Promise<StorageRef> => {
      if (shouldFail) throw new Error(`${type} storeManifest failed`);
      return { type, uri: `${type}://manifest-${m.sessionId}`, hash: m.manifestHash ?? "h", size: 1 };
    }),
    fetch: vi.fn(),
    fetchManifest: vi.fn(),
    verify: vi.fn().mockResolvedValue(!shouldFail),
  };
}

const manifest: StorableManifest = {
  formatVersion: "1.0",
  sessionId: "run-1",
  manifestHash: "deadbeef",
};

const noRetry = { maxAttempts: 1, delayMs: 0, backoffMultiplier: 1 };

describe("pinTraceFor", () => {
  it("pins the manifest to every adapter under 'all' redundancy", async () => {
    const ipfs = mockAdapter("ipfs");
    const arweave = mockAdapter("arweave");
    const result = await pinTraceFor(manifest, {
      adapters: [ipfs, arweave],
      redundancy: "all",
      retry: noRetry,
    });

    expect(ipfs.storeManifest).toHaveBeenCalledOnce();
    expect(arweave.storeManifest).toHaveBeenCalledOnce();
    expect(result.manifestRefs).toHaveLength(2);
    expect(result.refs).toHaveLength(2);
    expect(result.manifest.type).toBe("ipfs");
  });

  it("stores artifacts alongside the manifest and aggregates all refs", async () => {
    const ipfs = mockAdapter("ipfs");
    const arweave = mockAdapter("arweave");
    const result = await pinTraceFor(manifest, {
      adapters: [ipfs, arweave],
      redundancy: "all",
      artifacts: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])],
      retry: noRetry,
    });

    expect(ipfs.store).toHaveBeenCalledTimes(2);
    expect(result.artifactRefs).toHaveLength(2);
    // 2 manifest refs + 2 artifacts * 2 backends = 6 total refs
    expect(result.refs).toHaveLength(6);
  });

  it("fails under 'all' redundancy when any backend fails", async () => {
    const ipfs = mockAdapter("ipfs");
    const arweave = mockAdapter("arweave", true);
    await expect(
      pinTraceFor(manifest, { adapters: [ipfs, arweave], redundancy: "all", retry: noRetry })
    ).rejects.toThrow(/redundancy/i);
  });

  it("succeeds under 'any' redundancy when one backend fails", async () => {
    const ipfs = mockAdapter("ipfs");
    const arweave = mockAdapter("arweave", true);
    const result = await pinTraceFor(manifest, {
      adapters: [ipfs, arweave],
      redundancy: "any",
      retry: noRetry,
    });
    expect(result.manifestRefs).toHaveLength(1);
    expect(result.manifest.type).toBe("ipfs");
  });

  it("requires at least one adapter", async () => {
    await expect(pinTraceFor(manifest, { adapters: [] })).rejects.toThrow(/at least one adapter/i);
  });
});

describe("S3 WORM retention", () => {
  it("computes retain-until from retentionYears", () => {
    const now = 1_900_000_000_000;
    const date = computeObjectLockRetainUntil({ mode: "COMPLIANCE", retentionYears: 7 }, now);
    expect(date).toBeInstanceOf(Date);
    expect(date!.getTime()).toBeCloseTo(now + 7 * MS_PER_YEAR, -3);
  });

  it("passes through an explicit retainUntilDate", () => {
    const explicit = new Date("2035-01-01T00:00:00.000Z");
    const date = computeObjectLockRetainUntil({ mode: "GOVERNANCE", retainUntilDate: explicit });
    expect(date).toBe(explicit);
  });

  it("returns undefined when no retention is configured", () => {
    expect(computeObjectLockRetainUntil({ mode: "COMPLIANCE" })).toBeUndefined();
  });

  it("createS3WormAdapter builds an s3 adapter (default COMPLIANCE)", () => {
    const worm = createS3WormAdapter({ bucket: "audit", region: "us-east-1", retentionYears: 7 });
    expect(worm.type).toBe("s3");
  });
});
