/**
 * Pure-function tests for `billing/aggregate.ts`. NO IO, NO chain, NO db.
 *
 * Synthetic fixtures here exercise the aggregate counters, the cursor
 * round-trip, and edge cases (empty input, mixed states). The route-level
 * test (`billing_route.test.ts`) covers the wiring; this file pins the
 * MATH so future refactors of the aggregator can't silently regress.
 */

import { describe, test, expect } from "vitest";
import {
  aggregateRecords,
  buildNextCursor,
  decodeCursor,
  type AggregatableRecord,
} from "../billing/aggregate.js";

function rec(over: Partial<AggregatableRecord> = {}): AggregatableRecord {
  return {
    worker_id: "worker-1",
    tenant_id: "ten-test-1",
    period_start_ms: 1_700_000_000_000,
    period_end_ms: 1_700_000_000_000 + 60_000,
    cpu_seconds: 10,
    ram_gb_hours: 1,
    disk_gb_hours: 0.5,
    net_bytes_in: 100,
    net_bytes_out: 50,
    gpu_seconds: 0,
    attestation_status: "pending",
    cardano_anchor_tx: null,
    ...over,
  };
}

describe("aggregateRecords", () => {
  test("empty input → zero-aggregate with null first/last", () => {
    const out = aggregateRecords([]);
    expect(out).toEqual({
      record_count: 0,
      certified_count: 0,
      anchored_count: 0,
      cpu_seconds_total: 0,
      ram_gb_hours_total: 0,
      disk_gb_hours_total: 0,
      net_bytes_in_total: 0,
      net_bytes_out_total: 0,
      gpu_seconds_total: 0,
      first_record_ms: null,
      last_record_ms: null,
      unique_workers: 0,
    });
  });

  test("single record → all sums match input, first==last", () => {
    const r = rec({ period_start_ms: 100, cpu_seconds: 7.5, gpu_seconds: 3 });
    const out = aggregateRecords([r]);
    expect(out.record_count).toBe(1);
    expect(out.cpu_seconds_total).toBeCloseTo(7.5, 6);
    expect(out.gpu_seconds_total).toBeCloseTo(3, 6);
    expect(out.first_record_ms).toBe(100);
    expect(out.last_record_ms).toBe(100);
    expect(out.unique_workers).toBe(1);
  });

  test("certified+anchored counts respect the inclusion order", () => {
    const records: AggregatableRecord[] = [
      // certified + anchored
      rec({
        attestation_status: "certified",
        cardano_anchor_tx: "0x" + "ab".repeat(32),
      }),
      // certified + not yet anchored
      rec({ attestation_status: "certified", cardano_anchor_tx: null }),
      // pending
      rec({ attestation_status: "pending", cardano_anchor_tx: null }),
      // unknown (chain RPC failed)
      rec({ attestation_status: "unknown", cardano_anchor_tx: null }),
    ];
    const out = aggregateRecords(records);
    expect(out.record_count).toBe(4);
    expect(out.certified_count).toBe(2);
    expect(out.anchored_count).toBe(1);
  });

  test("sums float fields with reasonable precision", () => {
    const out = aggregateRecords([
      rec({ ram_gb_hours: 0.1, disk_gb_hours: 0.2 }),
      rec({ ram_gb_hours: 0.2, disk_gb_hours: 0.3 }),
      rec({ ram_gb_hours: 0.3, disk_gb_hours: 0.5 }),
    ]);
    // Standard JS FP — accept tiny drift, hence toBeCloseTo.
    expect(out.ram_gb_hours_total).toBeCloseTo(0.6, 6);
    expect(out.disk_gb_hours_total).toBeCloseTo(1.0, 6);
  });

  test("net_bytes_* stays integer-exact at moderate scale", () => {
    const out = aggregateRecords([
      rec({ net_bytes_in: 1_000_000, net_bytes_out: 2_000_000 }),
      rec({ net_bytes_in: 3_000_000, net_bytes_out: 4_000_000 }),
    ]);
    expect(out.net_bytes_in_total).toBe(4_000_000);
    expect(out.net_bytes_out_total).toBe(6_000_000);
    expect(Number.isInteger(out.net_bytes_in_total)).toBe(true);
  });

  test("first/last record bookends across multiple", () => {
    const out = aggregateRecords([
      rec({ period_start_ms: 200 }),
      rec({ period_start_ms: 100 }),
      rec({ period_start_ms: 300 }),
    ]);
    expect(out.first_record_ms).toBe(100);
    expect(out.last_record_ms).toBe(300);
  });

  test("unique_workers counts distinct worker_id", () => {
    const out = aggregateRecords([
      rec({ worker_id: "a" }),
      rec({ worker_id: "b" }),
      rec({ worker_id: "a" }),
      rec({ worker_id: "c" }),
    ]);
    expect(out.unique_workers).toBe(3);
  });
});

describe("cursor round-trip", () => {
  test("buildNextCursor returns null when records < page_size (last page)", () => {
    const out = buildNextCursor(
      [{ period_start_ms: 1, content_hash: "a".repeat(64) }],
      10,
    );
    expect(out).toBeNull();
  });

  test("buildNextCursor returns null when is_final=true even on full page", () => {
    const out = buildNextCursor(
      [
        { period_start_ms: 1, content_hash: "a".repeat(64) },
        { period_start_ms: 2, content_hash: "b".repeat(64) },
      ],
      2,
      /* is_final = */ true,
    );
    expect(out).toBeNull();
  });

  test("buildNextCursor returns opaque base64url when records == page_size", () => {
    const out = buildNextCursor(
      [
        { period_start_ms: 1, content_hash: "a".repeat(64) },
        { period_start_ms: 2, content_hash: "b".repeat(64) },
      ],
      2,
    );
    expect(out).toBeTruthy();
    expect(typeof out).toBe("string");
    // base64url → no '+', '/', '='
    expect(out).not.toMatch(/[+/=]/);
  });

  test("decodeCursor round-trips a buildNextCursor output", () => {
    const last = { period_start_ms: 12345, content_hash: "f".repeat(64) };
    const cur = buildNextCursor([last], 1);
    expect(cur).toBeTruthy();
    const decoded = decodeCursor(cur as string);
    expect(decoded).toEqual(last);
  });

  test("decodeCursor returns null on malformed input", () => {
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("@@@@")).toBeNull();
    expect(decodeCursor("notbase64")).toBeNull();
    // Valid base64 but JSON is wrong shape:
    const bad = Buffer.from(JSON.stringify({ p: "x", h: "y" })).toString("base64");
    expect(decodeCursor(bad.replace(/=+$/, ""))).toBeNull();
  });

  test("decodeCursor rejects malformed content_hash", () => {
    const bad = Buffer.from(
      JSON.stringify({ p: 1, h: "not-hex" }),
    ).toString("base64");
    expect(decodeCursor(bad.replace(/=+$/, ""))).toBeNull();
  });
});
