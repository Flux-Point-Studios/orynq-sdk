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
    // Default to null — "we didn't ask the chain" is the safest no-op
    // value for fixtures. Tests that pin the trust-score path override.
    composite_trust_score: null,
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
      tee_attested_count: 0,
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

  test("tee_attested_count counts only records with composite_trust_score >= 1 (task #142)", () => {
    // Pin the rule:
    //   - >= 1: counted (single-vendor, multi-vendor, +build, +ZK)
    //   - 0:    NOT counted (committee-attested baseline)
    //   - null: NOT counted (chain query failed; we couldn't ask)
    // The Path C harness `_wait_for_anchor` reads `composite_trust_score`
    // and waits for it to become >= 1 — this aggregate counter mirrors
    // that contract at the bulk level so customers can see "how many of
    // my records have hardware-backed attestation" at a glance.
    const records: AggregatableRecord[] = [
      rec({ composite_trust_score: 0 }), // baseline — NOT counted
      rec({ composite_trust_score: 1 }), // single-vendor — counted
      rec({ composite_trust_score: 2 }), // multi-vendor — counted
      rec({ composite_trust_score: 3 }), // multi+build — counted
      rec({ composite_trust_score: 4 }), // full quorum — counted
      rec({ composite_trust_score: null }), // chain failed — NOT counted
      rec({ composite_trust_score: null }), // ditto
    ];
    const out = aggregateRecords(records);
    expect(out.record_count).toBe(7);
    expect(out.tee_attested_count).toBe(4);
  });

  test("tee_attested_count is zero when every record has score 0 or null", () => {
    // The "production until task #143 ships" case: chain reachable but no
    // submit_evidence calls yet → every score is 0. Aggregate must not
    // claim any records are TEE-attested.
    const allZero: AggregatableRecord[] = [
      rec({ composite_trust_score: 0 }),
      rec({ composite_trust_score: 0 }),
      rec({ composite_trust_score: 0 }),
    ];
    expect(aggregateRecords(allZero).tee_attested_count).toBe(0);

    const allNull: AggregatableRecord[] = [
      rec({ composite_trust_score: null }),
      rec({ composite_trust_score: null }),
    ];
    expect(aggregateRecords(allNull).tee_attested_count).toBe(0);
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
