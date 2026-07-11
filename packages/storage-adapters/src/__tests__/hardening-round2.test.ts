/**
 * @summary Round-2 hardening regression tests for storage-adapters (#61).
 *
 *  1. pinTraceFor durability: under 'any'/'quorum' redundancy, if the WORM
 *     (Object-Lock) backend is the one that FAILED, the result must NOT report
 *     success — the durability guarantee the PR advertises requires the WORM
 *     backend specifically.
 *  2. computeObjectLockRetainUntil must reject retentionYears <= 0 and a
 *     retainUntilDate in the past.
 */

import { describe, it, expect, vi } from "vitest";
import {
  pinTraceFor,
  computeObjectLockRetainUntil,
  type StorageAdapter,
  type StorableManifest,
  type StorageRef,
} from "../index.js";

function mockAdapter(
  type: "ipfs" | "s3" | "arweave",
  opts: { fail?: boolean; isWorm?: boolean } = {}
): StorageAdapter {
  const adapter: StorageAdapter = {
    type,
    store: vi.fn().mockImplementation(async (data: Uint8Array): Promise<StorageRef> => {
      if (opts.fail) throw new Error(`${type} store failed`);
      return { type, uri: `${type}://chunk-${data.length}`, hash: "h", size: data.length };
    }),
    storeManifest: vi.fn().mockImplementation(async (m: StorableManifest): Promise<StorageRef> => {
      if (opts.fail) throw new Error(`${type} storeManifest failed`);
      return { type, uri: `${type}://manifest-${m.sessionId}`, hash: m.manifestHash ?? "h", size: 1 };
    }),
    fetch: vi.fn(),
    fetchManifest: vi.fn(),
    verify: vi.fn().mockResolvedValue(!opts.fail),
  };
  if (opts.isWorm) (adapter as { isWorm?: boolean }).isWorm = true;
  return adapter;
}

const manifest: StorableManifest = {
  formatVersion: "1.0",
  sessionId: "run-1",
  manifestHash: "deadbeef",
};

const noRetry = { maxAttempts: 1, delayMs: 0, backoffMultiplier: 1 };
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

describe("pinTraceFor requires the WORM backend for the durability guarantee (#61)", () => {
  it("FAILS under 'any' when the WORM backend is the one that failed", async () => {
    const ipfs = mockAdapter("ipfs"); // succeeds
    const worm = mockAdapter("s3", { fail: true, isWorm: true }); // WORM fails
    await expect(
      pinTraceFor(manifest, {
        adapters: [ipfs, worm],
        redundancy: "any",
        retry: noRetry,
      })
    ).rejects.toThrow(/worm|object.?lock|durab/i);
  });

  it("succeeds under 'any' when the WORM backend succeeds (a non-WORM backend may fail)", async () => {
    const worm = mockAdapter("s3", { isWorm: true }); // WORM succeeds
    const ipfs = mockAdapter("ipfs", { fail: true }); // non-WORM fails
    const result = await pinTraceFor(manifest, {
      adapters: [worm, ipfs],
      redundancy: "any",
      retry: noRetry,
    });
    expect(result.manifestRefs.some((r) => r.type === "s3")).toBe(true);
  });

  it("still succeeds when no WORM backend is configured (guarantee not advertised)", async () => {
    const ipfs = mockAdapter("ipfs");
    const arweave = mockAdapter("arweave", { fail: true });
    const result = await pinTraceFor(manifest, {
      adapters: [ipfs, arweave],
      redundancy: "any",
      retry: noRetry,
    });
    expect(result.manifestRefs).toHaveLength(1);
  });
});

describe("computeObjectLockRetainUntil validates retention (#61)", () => {
  it("throws on retentionYears = 0 (no protection)", () => {
    expect(() => computeObjectLockRetainUntil({ mode: "COMPLIANCE", retentionYears: 0 })).toThrow(
      /retentionYears/i
    );
  });

  it("throws on negative retentionYears", () => {
    expect(() =>
      computeObjectLockRetainUntil({ mode: "COMPLIANCE", retentionYears: -3 })
    ).toThrow(/retentionYears/i);
  });

  it("throws on a retainUntilDate in the past", () => {
    const past = new Date("2000-01-01T00:00:00.000Z");
    expect(() =>
      computeObjectLockRetainUntil({ mode: "GOVERNANCE", retainUntilDate: past })
    ).toThrow(/future|past|retainUntil/i);
  });

  it("still computes a valid future date from retentionYears > 0", () => {
    const now = 1_900_000_000_000;
    const date = computeObjectLockRetainUntil({ mode: "COMPLIANCE", retentionYears: 7 }, now);
    expect(date!.getTime()).toBeCloseTo(now + 7 * MS_PER_YEAR, -3);
  });
});
