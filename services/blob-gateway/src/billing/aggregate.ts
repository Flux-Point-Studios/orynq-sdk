/**
 * Aggregation logic for the billing-query endpoint (#112).
 *
 * Pure functions only — no IO, no globals. The route handler in
 * `routes/billing.ts` reads rows from sqlite + chain-status from substrate +
 * anchor-tx from the cert-daemon checkpoint history, then hands the
 * compiled per-record list here.
 *
 * Design notes:
 *   - Aggregates are computed in a single pass; we don't iterate per metric.
 *   - record_count, certified_count, anchored_count are mutually-exclusive
 *     UPSTREAM concepts but mutually-INCLUSIVE here:
 *         certified_count <= record_count
 *         anchored_count  <= certified_count
 *     i.e. "anchored" implies "certified" implies "submitted". The route
 *     enforces that constraint by ONLY setting `cardano_anchor_tx` when
 *     `attestation_status === 'certified'`.
 *   - Sums are done in number-space. JS doubles are exact for integers
 *     <= 2^53; for floats (cpu_seconds etc.) we accept the standard FP
 *     drift — billing reports already round to a sensible decimal, and
 *     the schema validator caps cpu_seconds at periodSec*max_cpu_cores
 *     which is well under the precision budget.
 *   - first_record_ms / last_record_ms are computed over period_start_ms
 *     (worker-claimed window start), matching the time semantics of
 *     `getMeteringSubmissions()` (see `worker_bounds.ts`).
 */

/**
 * One row from the gateway's `metering_submissions` table joined with
 * its chain-status + anchor-resolution result. The aggregate function
 * does not care WHERE these fields came from — it only cares about their
 * values. Decoupling lets us exercise aggregation with synthetic fixtures
 * in unit tests with zero IO.
 */
export interface AggregatableRecord {
  worker_id: string;
  tenant_id: string;
  period_start_ms: number;
  period_end_ms: number;
  cpu_seconds: number;
  ram_gb_hours: number;
  disk_gb_hours: number;
  net_bytes_in: number;
  net_bytes_out: number;
  gpu_seconds: number;
  /** "certified" | "pending" | "unknown" — set by `chain_query.ts`. */
  attestation_status: AttestationStatus;
  /** Non-null cardano tx hash when anchor_resolver matched a checkpoint. */
  cardano_anchor_tx: string | null;
  /**
   * Composite trust score from `pallet-tee-attestation::CompositeTrustScores`
   * (task #142). Range 0..=4:
   *   0 = COMMITTEE_ATTESTED_BASELINE — no TEE evidence on chain yet.
   *   1 = SINGLE_VENDOR
   *   2 = MULTI_VENDOR
   *   3 = MULTI_VENDOR_PLUS_BUILD
   *   4 = FULL_QUORUM
   *
   * `null` means the chain query failed (RPC unreachable / pallet not
   * present on a pre-spec-213 runtime) — semantically distinct from `0`,
   * which means "chain reachable, no evidence yet". Downstream consumers
   * (e.g. the Path C harness `_wait_for_anchor`) MUST NOT collapse the two.
   */
  composite_trust_score: number | null;
}

export type AttestationStatus = "certified" | "pending" | "unknown";

/** Aggregate counters returned in the billing response. */
export interface BillingAggregate {
  record_count: number;
  certified_count: number;
  anchored_count: number;
  /**
   * Count of records with `composite_trust_score >= 1` — i.e. at least
   * one TEE evidence record accepted on chain. Records with
   * `composite_trust_score === 0` (committee-attested baseline) and
   * `composite_trust_score === null` (chain query failed) do NOT count
   * here. See `AggregatableRecord.composite_trust_score` for the level
   * semantics.
   */
  tee_attested_count: number;
  cpu_seconds_total: number;
  ram_gb_hours_total: number;
  disk_gb_hours_total: number;
  net_bytes_in_total: number;
  net_bytes_out_total: number;
  gpu_seconds_total: number;
  /** ms since epoch of the EARLIEST period_start in the result, or null. */
  first_record_ms: number | null;
  /** ms since epoch of the LATEST period_start in the result, or null. */
  last_record_ms: number | null;
  unique_workers: number;
}

/**
 * Aggregate a list of records into the response shape. Returns the
 * zero-aggregate (record_count=0, all sums=0, both *_record_ms=null) on an
 * empty input — this is the explicit "no records found" path used by the
 * route handler.
 */
export function aggregateRecords(
  records: AggregatableRecord[],
): BillingAggregate {
  const result: BillingAggregate = {
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
  };

  const workers = new Set<string>();
  for (const r of records) {
    result.record_count += 1;
    if (r.attestation_status === "certified") result.certified_count += 1;
    if (r.cardano_anchor_tx !== null) result.anchored_count += 1;
    // `composite_trust_score` is null when the chain query failed; only
    // count records that POSITIVELY have at least one accepted TEE
    // evidence record (>= 1). Baseline (=0) and unknown (null) are
    // explicitly NOT counted.
    if (
      typeof r.composite_trust_score === "number" &&
      r.composite_trust_score >= 1
    ) {
      result.tee_attested_count += 1;
    }
    result.cpu_seconds_total += r.cpu_seconds;
    result.ram_gb_hours_total += r.ram_gb_hours;
    result.disk_gb_hours_total += r.disk_gb_hours;
    // `net_bytes_*` are integer fields — keep them in integer space by
    // adding through `+` (JS does the right thing as long as both sides
    // are <= 2^53). The schema validator already caps each input at
    // JS_SAFE_INT, so a single record can't push us over the edge in one
    // step. Aggregate-level overflow is an open follow-up (BigInt).
    result.net_bytes_in_total += r.net_bytes_in;
    result.net_bytes_out_total += r.net_bytes_out;
    result.gpu_seconds_total += r.gpu_seconds;
    if (
      result.first_record_ms === null ||
      r.period_start_ms < result.first_record_ms
    ) {
      result.first_record_ms = r.period_start_ms;
    }
    if (
      result.last_record_ms === null ||
      r.period_start_ms > result.last_record_ms
    ) {
      result.last_record_ms = r.period_start_ms;
    }
    workers.add(r.worker_id);
  }
  result.unique_workers = workers.size;
  return result;
}

/**
 * Build the opaque `next_cursor` for pagination. Encodes the last row's
 * (period_start_ms, content_hash) as base64url-encoded JSON. The format is
 * intentionally opaque to the client — they pass it back unchanged.
 *
 * Returns null when the page is the LAST page (records.length < page_size).
 * Callers that ALREADY know the page is final (e.g. count == 0) should
 * pass `is_final: true` to short-circuit cursor generation.
 */
export function buildNextCursor(
  records: Array<{ period_start_ms: number; content_hash: string }>,
  pageSize: number,
  is_final = false,
): string | null {
  if (is_final || records.length < pageSize) return null;
  const last = records[records.length - 1];
  if (!last) return null;
  const payload = JSON.stringify({
    p: last.period_start_ms,
    h: last.content_hash,
  });
  // base64url, no padding. Same encoding the chain-side helpers use.
  return Buffer.from(payload, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Decode a `next_cursor` produced by `buildNextCursor()` into the typed
 * (period_start_ms, content_hash) tuple `getMeteringSubmissions()` accepts
 * as `after`.
 *
 * Returns null on any malformed input — the route should treat that as
 * "no cursor" and start from the beginning. We do NOT throw on bad input
 * because a stale-or-tampered cursor must NOT 500 the customer.
 */
export function decodeCursor(
  cursor: string,
): { period_start_ms: number; content_hash: string } | null {
  try {
    // Restore padding so atob/Buffer round-trips. Add up to 3 `=`s.
    const pad = cursor.length % 4;
    const restored = cursor + (pad ? "=".repeat(4 - pad) : "");
    const standard = restored.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(standard, "base64").toString("utf-8");
    const obj = JSON.parse(json) as { p?: unknown; h?: unknown };
    if (
      typeof obj.p !== "number" ||
      !Number.isInteger(obj.p) ||
      typeof obj.h !== "string" ||
      !/^[0-9a-f]{64}$/.test(obj.h)
    ) {
      return null;
    }
    return { period_start_ms: obj.p, content_hash: obj.h };
  } catch {
    return null;
  }
}
