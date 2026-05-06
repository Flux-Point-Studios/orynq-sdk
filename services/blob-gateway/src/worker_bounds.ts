/**
 * SQLite-backed registry of per-worker hardware bounds for
 * `compute_metering_v1`. Used by the gateway-side validator to check that
 * reported resource usage doesn't exceed the worker's known capacity.
 *
 * Why a separate db handle and not quota.db?
 *   - Compute metering is its own product line (#108 — Compute Portal).
 *     Keeping the schema independent means we don't entangle billing-pipeline
 *     migrations with the upload-quota schema, which is already busy.
 *   - Tests can swap in an in-memory handle via `setWorkerBoundsDbForTests()`
 *     without touching the real /data/blobs/quota.db file.
 *
 * Also tracks `last_period_start` per worker so the validator can enforce
 * monotonic non-decreasing `period_start` across submissions for the same
 * worker_id (replay/rewind protection).
 *
 * The registry CONSUMES no secrets; bounds are operator-declared and apply
 * the same way as docker `--cpus` / `--memory` flags do. Sensible defaults
 * mean a worker that hasn't been registered still gets validated against
 * `DEFAULT_BOUNDS` (128 cores / 2 TB RAM / 16 TB disk / 8 GPUs) — generous
 * enough to admit any production hardware while still rejecting absurd
 * fabrications.
 */

import Database from "better-sqlite3";
import { join } from "path";
import { config } from "./config.js";
import { DEFAULT_BOUNDS, type WorkerBounds } from "./schemas/compute_metering_v1.js";

let db: Database.Database | null = null;

/**
 * Test hook: inject an in-memory handle. Must be called after the schema
 * has been initialised on that handle (use `initWorkerBoundsDb(handle)` for
 * that). Production code path uses initWorkerBoundsDb() with no arg.
 */
export function setWorkerBoundsDbForTests(injected: Database.Database): void {
  db = injected;
}

/**
 * Initialise the worker_bounds + worker_state tables on a SQLite handle.
 * If `database` is omitted, opens (or creates) `worker_bounds.db` at the
 * canonical storage path.
 *
 * Safe to call repeatedly (idempotent CREATE IF NOT EXISTS). Returns the
 * handle so callers may share it.
 */
export function initWorkerBoundsDb(
  database?: Database.Database,
): Database.Database {
  const handle =
    database ?? new Database(join(config.storagePath, "worker_bounds.db"));
  handle.pragma("journal_mode = WAL");
  handle.pragma("busy_timeout = 5000");
  handle.exec(`
    CREATE TABLE IF NOT EXISTS worker_bounds (
      worker_id TEXT PRIMARY KEY,
      max_cpu_cores INTEGER NOT NULL,
      max_ram_gb INTEGER NOT NULL,
      max_disk_gb INTEGER NOT NULL,
      max_gpu_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS worker_state (
      worker_id TEXT PRIMARY KEY,
      last_period_start INTEGER NOT NULL DEFAULT 0,
      last_content_hash TEXT,
      last_seen_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_worker_state_last_period
      ON worker_state(worker_id, last_period_start);

    -- Per-record submission log used by the billing-query endpoint
    -- (#112). Each row is the per-period snapshot produced by a worker's
    -- compute_metering_v1 submission. content_hash is PRIMARY KEY so
    -- replays/idempotent retries are silently absorbed (an INSERT OR IGNORE
    -- is a no-op when the same record is re-submitted byte-for-byte).
    --
    -- We persist all six metric fields verbatim — billing queries aggregate
    -- across these directly without re-reading manifest.json off disk.
    -- submitted_at_ms is wall-clock ingest time at the gateway (not the
    -- worker's claimed period_*); useful for "fresh-vs-stale" accounting.
    CREATE TABLE IF NOT EXISTS metering_submissions (
      content_hash TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      period_start_ms INTEGER NOT NULL,
      period_end_ms INTEGER NOT NULL,
      cpu_seconds REAL NOT NULL,
      ram_gb_hours REAL NOT NULL,
      disk_gb_hours REAL NOT NULL,
      net_bytes_in INTEGER NOT NULL,
      net_bytes_out INTEGER NOT NULL,
      gpu_seconds REAL NOT NULL,
      submitted_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_metering_tenant_period
      ON metering_submissions(tenant_id, period_start_ms);
    CREATE INDEX IF NOT EXISTS idx_metering_worker
      ON metering_submissions(worker_id);
  `);
  if (!db) db = handle;
  return handle;
}

/**
 * Look up bounds for a worker_id. Returns `DEFAULT_BOUNDS` if the worker is
 * not registered (registration is operator-driven; missing entry means
 * "first time we've seen this worker" and we fall back to defaults).
 */
export function getWorkerBounds(workerId: string): WorkerBounds {
  if (!db) {
    // Defensive: not initialised. This shouldn't happen in production
    // because index.ts calls initWorkerBoundsDb() at boot, but tests that
    // forgot to call setWorkerBoundsDbForTests() also hit this. Default to
    // bounds (don't throw) so the schema validator is still callable in
    // contexts that haven't wired the db (e.g. pure unit tests of the
    // validator below the route layer).
    return DEFAULT_BOUNDS;
  }
  const row = db
    .prepare(
      `SELECT max_cpu_cores, max_ram_gb, max_disk_gb, max_gpu_count
       FROM worker_bounds WHERE worker_id = ?`,
    )
    .get(workerId) as
    | {
        max_cpu_cores: number;
        max_ram_gb: number;
        max_disk_gb: number;
        max_gpu_count: number;
      }
    | undefined;
  if (!row) return DEFAULT_BOUNDS;
  return {
    max_cpu_cores: row.max_cpu_cores,
    max_ram_gb: row.max_ram_gb,
    max_disk_gb: row.max_disk_gb,
    max_gpu_count: row.max_gpu_count,
  };
}

/**
 * Upsert a worker's bounds. Used by ops tooling (and tests) to register
 * realistic hardware caps for a specific worker. Validates that values
 * are positive integers — silent acceptance of zero/negative would defeat
 * the bound check.
 */
export function upsertWorkerBounds(
  workerId: string,
  bounds: WorkerBounds,
): void {
  if (!db) throw new Error("worker_bounds db not initialised");
  for (const [k, v] of Object.entries(bounds)) {
    if (!Number.isInteger(v) || v <= 0) {
      throw new TypeError(`upsertWorkerBounds: ${k} must be a positive integer, got ${v}`);
    }
  }
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO worker_bounds (worker_id, max_cpu_cores, max_ram_gb, max_disk_gb, max_gpu_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(worker_id) DO UPDATE SET
       max_cpu_cores = excluded.max_cpu_cores,
       max_ram_gb = excluded.max_ram_gb,
       max_disk_gb = excluded.max_disk_gb,
       max_gpu_count = excluded.max_gpu_count,
       updated_at = excluded.updated_at`,
  ).run(
    workerId,
    bounds.max_cpu_cores,
    bounds.max_ram_gb,
    bounds.max_disk_gb,
    bounds.max_gpu_count,
    now,
    now,
  );
}

/**
 * Read the last-observed period_start for a worker. Returns 0 if no record
 * has ever been admitted (first-time worker — any positive period_start
 * passes the monotonic check).
 */
export function getLastPeriodStart(workerId: string): number {
  if (!db) return 0;
  const row = db
    .prepare(
      `SELECT last_period_start FROM worker_state WHERE worker_id = ?`,
    )
    .get(workerId) as { last_period_start: number } | undefined;
  return row?.last_period_start ?? 0;
}

/**
 * Update the worker_state row for a worker after a successful submission.
 * Called by the route handler ONLY after every other check has passed
 * (signature, bounds, monotonic). Sets `last_period_start` to the new
 * period_start (guaranteed >= old), records the content_hash for idempotency
 * checks, and stamps last_seen_at.
 *
 * Idempotent on `last_content_hash`: callers should check this BEFORE
 * forwarding to the upstream sponsored-receipt pipeline so a retry of the
 * same record doesn't double-debit the customer. See `isReplayedContent()`.
 */
export function recordWorkerSubmission(
  workerId: string,
  periodStart: number,
  contentHash: string,
): void {
  if (!db) throw new Error("worker_bounds db not initialised");
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO worker_state (worker_id, last_period_start, last_content_hash, last_seen_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(worker_id) DO UPDATE SET
       last_period_start = excluded.last_period_start,
       last_content_hash = excluded.last_content_hash,
       last_seen_at = excluded.last_seen_at`,
  ).run(workerId, periodStart, contentHash, now);
}

/**
 * Returns true iff the supplied content_hash matches the LAST recorded
 * content_hash for this worker — used as a cheap dedup against immediate
 * retries of the exact same record. NOT a full replay-protection store
 * (the chain is the canonical anti-replay via content_hash uniqueness),
 * but it short-circuits a common retry pattern at the gateway edge.
 */
export function isReplayedContent(
  workerId: string,
  contentHash: string,
): boolean {
  if (!db) return false;
  const row = db
    .prepare(
      `SELECT last_content_hash FROM worker_state WHERE worker_id = ?`,
    )
    .get(workerId) as { last_content_hash: string | null } | undefined;
  return row?.last_content_hash === contentHash;
}

/**
 * Per-record billing snapshot. Mirrors the columns of
 * `metering_submissions`. Returned by `getMeteringSubmissions()` for the
 * billing-query endpoint (#112).
 */
export interface MeteringSubmissionRow {
  content_hash: string;
  tenant_id: string;
  worker_id: string;
  period_start_ms: number;
  period_end_ms: number;
  cpu_seconds: number;
  ram_gb_hours: number;
  disk_gb_hours: number;
  net_bytes_in: number;
  net_bytes_out: number;
  gpu_seconds: number;
  submitted_at_ms: number;
}

/**
 * Append a billing-purpose row for a successful metering submission.
 *
 * Uses INSERT OR IGNORE so an idempotent retry (same content_hash) is a
 * silent no-op — we never double-count usage. The route already
 * short-circuits replays before reaching here via `isReplayedContent()`,
 * but the OR IGNORE is belt-and-suspenders against a race where two
 * threads both pass the replay check and both call recordSubmission().
 */
export function recordMeteringSubmission(
  row: MeteringSubmissionRow,
): void {
  if (!db) throw new Error("worker_bounds db not initialised");
  db.prepare(
    `INSERT OR IGNORE INTO metering_submissions (
       content_hash, tenant_id, worker_id,
       period_start_ms, period_end_ms,
       cpu_seconds, ram_gb_hours, disk_gb_hours,
       net_bytes_in, net_bytes_out, gpu_seconds,
       submitted_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.content_hash,
    row.tenant_id,
    row.worker_id,
    row.period_start_ms,
    row.period_end_ms,
    row.cpu_seconds,
    row.ram_gb_hours,
    row.disk_gb_hours,
    row.net_bytes_in,
    row.net_bytes_out,
    row.gpu_seconds,
    row.submitted_at_ms,
  );
}

/**
 * Filter for `getMeteringSubmissions()`.
 *
 * Time-window semantics: `[start_ms, end_ms)` — INCLUSIVE start, EXCLUSIVE
 * end. A record with `period_start_ms === start_ms` IS included; a record
 * with `period_start_ms === end_ms` is NOT. We filter by `period_start_ms`
 * (worker-claimed window start) — NOT by `submitted_at_ms` (gateway ingest
 * time) — because customers care about the period the work was done, not
 * when it landed at the gateway.
 *
 * Pagination: order by (period_start_ms ASC, content_hash ASC) — stable
 * across calls. The caller passes the last (period_start_ms, content_hash)
 * tuple as `cursor` to fetch the next page.
 */
export interface MeteringQuery {
  tenant_id: string;
  start_ms: number;
  end_ms: number;
  /** Maximum rows to return. */
  limit: number;
  /**
   * Opaque pagination cursor. When provided, the query continues strictly
   * after the (period_start_ms, content_hash) encoded here.
   */
  after?: { period_start_ms: number; content_hash: string };
}

/**
 * Read metering rows for a tenant in a time window. Pure read — no side
 * effects, no order-by-magic. Always returns at most `limit` rows.
 */
export function getMeteringSubmissions(
  q: MeteringQuery,
): MeteringSubmissionRow[] {
  if (!db) return [];
  // Two SQL paths so we don't bind unused parameters; SQLite handles each
  // form fine but the prepared-statement cache is keyed on the SQL string
  // and we'd rather not churn it on every page.
  if (q.after) {
    const stmt = db.prepare(
      `SELECT content_hash, tenant_id, worker_id,
              period_start_ms, period_end_ms,
              cpu_seconds, ram_gb_hours, disk_gb_hours,
              net_bytes_in, net_bytes_out, gpu_seconds,
              submitted_at_ms
         FROM metering_submissions
        WHERE tenant_id = ?
          AND period_start_ms >= ?
          AND period_start_ms < ?
          AND (period_start_ms > ?
                OR (period_start_ms = ? AND content_hash > ?))
        ORDER BY period_start_ms ASC, content_hash ASC
        LIMIT ?`,
    );
    return stmt.all(
      q.tenant_id,
      q.start_ms,
      q.end_ms,
      q.after.period_start_ms,
      q.after.period_start_ms,
      q.after.content_hash,
      q.limit,
    ) as MeteringSubmissionRow[];
  }
  const stmt = db.prepare(
    `SELECT content_hash, tenant_id, worker_id,
            period_start_ms, period_end_ms,
            cpu_seconds, ram_gb_hours, disk_gb_hours,
            net_bytes_in, net_bytes_out, gpu_seconds,
            submitted_at_ms
       FROM metering_submissions
      WHERE tenant_id = ?
        AND period_start_ms >= ?
        AND period_start_ms < ?
      ORDER BY period_start_ms ASC, content_hash ASC
      LIMIT ?`,
  );
  return stmt.all(
    q.tenant_id,
    q.start_ms,
    q.end_ms,
    q.limit,
  ) as MeteringSubmissionRow[];
}
