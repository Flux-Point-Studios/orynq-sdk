/**
 * @summary Round-3 hardening regression tests for storage-adapters (#61).
 *
 *  1. computeObjectLockRetainUntil must reject an Invalid Date (getTime()===NaN)
 *     — `NaN <= nowMs` is false, so an Invalid retainUntilDate slipped past the
 *     past-date guard and produced a bogus (NaN) retention.
 *  2. `isWorm` is a producer-attested config assertion, NOT proof of real
 *     Object-Lock enforcement. `verifyWormEnabled()` performs the actual bucket
 *     check; `objectLockConfigEnabled()` interprets the S3 response.
 */

import { describe, it, expect, vi } from "vitest";
import {
  computeObjectLockRetainUntil,
  createS3WormAdapter,
  createS3Adapter,
  objectLockConfigEnabled,
  S3Adapter,
} from "../index.js";

describe("computeObjectLockRetainUntil rejects an Invalid retainUntilDate (#61 round-3)", () => {
  it("throws on an Invalid Date (getTime() is NaN)", () => {
    const invalid = new Date("not-a-date");
    expect(Number.isNaN(invalid.getTime())).toBe(true);
    expect(() =>
      computeObjectLockRetainUntil({ mode: "COMPLIANCE", retainUntilDate: invalid })
    ).toThrow(/invalid|finite|future|retainUntil/i);
  });

  it("still accepts a valid future retainUntilDate", () => {
    const now = 1_900_000_000_000;
    const future = new Date(now + 60_000);
    const out = computeObjectLockRetainUntil({ mode: "GOVERNANCE", retainUntilDate: future }, now);
    expect(out!.getTime()).toBe(future.getTime());
  });
});

describe("objectLockConfigEnabled interprets the S3 Object-Lock response (#61 round-3)", () => {
  it("true only when ObjectLockConfiguration.ObjectLockEnabled === 'Enabled'", () => {
    expect(objectLockConfigEnabled({ ObjectLockConfiguration: { ObjectLockEnabled: "Enabled" } })).toBe(true);
    expect(objectLockConfigEnabled({ ObjectLockConfiguration: { ObjectLockEnabled: "Disabled" } })).toBe(false);
    expect(objectLockConfigEnabled({ ObjectLockConfiguration: {} })).toBe(false);
    expect(objectLockConfigEnabled({})).toBe(false);
    expect(objectLockConfigEnabled(undefined)).toBe(false);
    expect(objectLockConfigEnabled(null)).toBe(false);
  });
});

describe("isWorm is a config assertion; verifyWormEnabled checks the bucket (#61 round-3)", () => {
  it("isWorm reflects only the config, not real enforcement", () => {
    const worm = createS3WormAdapter({ bucket: "audit", region: "us-east-1", retentionYears: 7 });
    expect(worm.isWorm).toBe(true);
    const plain = createS3Adapter({ bucket: "b", region: "us-east-1" });
    expect(plain.isWorm).toBe(false);
  });

  it("verifyWormEnabled returns true when the bucket has Object Lock enabled", async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ ObjectLockConfiguration: { ObjectLockEnabled: "Enabled" } });
    const adapter = new S3Adapter({
      bucket: "audit",
      region: "us-east-1",
      objectLock: { mode: "COMPLIANCE", retentionYears: 7 },
      s3Client: { send },
    });
    await expect(adapter.verifyWormEnabled()).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("verifyWormEnabled returns false when Object Lock is not enabled on the bucket", async () => {
    const send = vi.fn().mockResolvedValue({});
    const adapter = new S3Adapter({
      bucket: "audit",
      region: "us-east-1",
      objectLock: { mode: "COMPLIANCE", retentionYears: 7 },
      s3Client: { send },
    });
    await expect(adapter.verifyWormEnabled()).resolves.toBe(false);
  });

  it("verifyWormEnabled returns false when the bucket has no lock config (send throws)", async () => {
    const send = vi.fn().mockRejectedValue(
      Object.assign(new Error("no lock"), { name: "ObjectLockConfigurationNotFoundError" })
    );
    const adapter = new S3Adapter({
      bucket: "audit",
      region: "us-east-1",
      objectLock: { mode: "COMPLIANCE", retentionYears: 7 },
      s3Client: { send },
    });
    await expect(adapter.verifyWormEnabled()).resolves.toBe(false);
  });
});
