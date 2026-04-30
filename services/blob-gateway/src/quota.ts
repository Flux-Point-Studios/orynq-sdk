/**
 * SQLite-backed API key authentication and rate limiting.
 *
 * Database lives on PVC at /data/blobs/quota.db — survives restarts,
 * atomic writes, single-writer (fine for 1 replica).
 */

import Database from "better-sqlite3";
import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { config } from "./config.js";

let db: Database.Database;

/**
 * Test hook: allow a test to inject its own (in-memory) handle without
 * needing a real /data/blobs/quota.db on disk. Never used in production.
 */
export function setQuotaDbForTests(injected: Database.Database): void {
  db = injected;
}

export interface KeyInfo {
  keyHash: string;
  name: string;
  enabled: boolean;
  maxReceiptsPerDay: number;
  maxBytesPerDay: number;
  maxConcurrentUploads: number;
  validatorId: string | null;
  /**
   * Task #94: SS58 of the validator authoring (aura) key this api_keys row
   * is bound to, when the operator is running cert-daemon and validator on
   * SEPARATE keys (security best practice). NULL = no binding, in which case
   * the explorer falls back to looking up heartbeats by aura SS58 directly.
   */
  boundValidatorAura: string | null;
}

export interface QuotaCheckResult {
  allowed: boolean;
  keyInfo?: KeyInfo;
  error?: string;
  limit?: number;
  current?: number;
}

/**
 * Initialize SQLite database and load keys.
 */
export function initQuotaDb(): void {
  const dbPath = join(config.storagePath, "quota.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      key_hash TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      max_receipts_per_day INTEGER NOT NULL DEFAULT 100,
      max_bytes_per_day INTEGER NOT NULL DEFAULT 1073741824,
      max_concurrent_uploads INTEGER NOT NULL DEFAULT 5,
      validator_id TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS quota_daily (
      key_hash TEXT NOT NULL,
      day TEXT NOT NULL,
      receipts INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (key_hash, day)
    );

    CREATE TABLE IF NOT EXISTS uploads_inflight (
      upload_id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL,
      started_at TEXT NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS account_quotas_daily (
      address TEXT NOT NULL,
      day TEXT NOT NULL,
      receipts INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (address, day)
    );

    CREATE TABLE IF NOT EXISTS account_uploads_inflight (
      upload_id TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      started_at TEXT NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active'
    );
  `);

  // Migration: add validator_id column if missing (existing databases)
  const cols = db.prepare("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "validator_id")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN validator_id TEXT DEFAULT NULL");
  }

  // Phase 1 billing: additive usage-metering columns. All defaults are 0 /
  // NULL so existing rows migrate transparently. The ALTER statements are
  // each wrapped in their own try/catch via migrateUsageColumns() so repeated
  // startup is a no-op on already-migrated DBs (SQLite's ADD COLUMN lacks
  // IF NOT EXISTS on the versions we target; catch "duplicate column name").
  migrateUsageColumns(db);

  // Task #94: aura → cert-daemon-signer binding column. Lets the explorer's
  // Validators tab join from a committee aura SS58 to the heartbeat-store
  // entry of the operator's cert-daemon when the operator is using SEPARATE
  // keys (security best practice). Defaulted NULL so old rows migrate
  // transparently. See bindValidatorAura() / getBindingForAura() below.
  migrateBindingColumn(db);

  loadKeys();
}

/**
 * Task #94 — Idempotent migration: add `bound_validator_aura` column to
 * `api_keys`. Records the SS58 of a validator's authoring aura key when the
 * api_keys row belongs to a SEPARATE cert-daemon signer (security-correct
 * setup: validator aura ≠ cert-daemon signer to keep the authoring key out
 * of the cert-daemon container's blast radius).
 *
 * The explorer joins on this column to render heartbeat status for the
 * underlying cert-daemon under the validator's aura SS58.
 *
 * Exported so tests can exercise the "run twice against the same DB" case
 * without spinning up full initQuotaDb(). PRAGMA-checked first; ALTER is
 * still wrapped in try/catch belt-and-suspenders for parallel-startup races.
 */
export function migrateBindingColumn(database: Database.Database): void {
  const cols = database.prepare("PRAGMA table_info(api_keys)").all() as Array<{
    name: string;
  }>;
  if (cols.some((c) => c.name === "bound_validator_aura")) return;
  try {
    database.exec(
      "ALTER TABLE api_keys ADD COLUMN bound_validator_aura TEXT DEFAULT NULL",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) {
      throw err;
    }
  }
}

/**
 * Idempotent migration: add Phase 1 usage-metering columns to `api_keys`.
 *
 * Exported so tests can exercise the "run twice against the same DB" case
 * without spinning up full initQuotaDb(). Safe to call on a freshly-created
 * table too — each column is checked via PRAGMA first, and we still wrap
 * the ALTERs in try/catch as belt-and-suspenders for concurrent startup.
 */
export function migrateUsageColumns(database: Database.Database): void {
  const cols = database.prepare("PRAGMA table_info(api_keys)").all() as Array<{
    name: string;
  }>;
  const have = new Set(cols.map((c) => c.name));
  const adds: Array<[string, string]> = [
    ["lifetime_receipts", "INTEGER NOT NULL DEFAULT 0"],
    ["lifetime_bytes", "INTEGER NOT NULL DEFAULT 0"],
    ["lifetime_matra_debited", "INTEGER NOT NULL DEFAULT 0"],
    ["last_used_at", "TEXT"],
  ];
  for (const [name, type] of adds) {
    if (have.has(name)) continue;
    try {
      database.exec(`ALTER TABLE api_keys ADD COLUMN ${name} ${type}`);
    } catch (err) {
      // SQLite surfaces a "duplicate column name" when a parallel startup
      // beat us to it. Anything else is a real error.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name/i.test(msg)) {
        throw err;
      }
    }
  }
}

function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Load keys from keys.json (K8s Secret mount or PVC fallback).
 * Falls back to legacy single config.apiKey if no keys.json exists.
 */
function loadKeys(): void {
  const keysPath = config.keysFilePath;
  if (existsSync(keysPath)) {
    try {
      const raw = readFileSync(keysPath, "utf-8");
      const keys = JSON.parse(raw) as Array<{
        keyHash: string;
        name: string;
        enabled?: boolean;
        maxReceiptsPerDay?: number;
        maxBytesPerDay?: number;
        maxConcurrentUploads?: number;
        validatorId?: string;
        boundValidatorAura?: string;
      }>;

      // Task #94: ON CONFLICT preserves bound_validator_aura on existing rows
      // even when keys.json doesn't carry the field (most rows won't).
      // Operators who *do* declare a binding via keys.json get it written
      // through; everyone else's existing binding survives a restart.
      const upsert = db.prepare(`
        INSERT INTO api_keys (key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads, validator_id, bound_validator_aura)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key_hash) DO UPDATE SET
          name = excluded.name,
          enabled = excluded.enabled,
          max_receipts_per_day = excluded.max_receipts_per_day,
          max_bytes_per_day = excluded.max_bytes_per_day,
          max_concurrent_uploads = excluded.max_concurrent_uploads,
          validator_id = excluded.validator_id,
          bound_validator_aura = COALESCE(excluded.bound_validator_aura, api_keys.bound_validator_aura)
      `);

      const upsertMany = db.transaction((items: typeof keys) => {
        for (const k of items) {
          upsert.run(
            k.keyHash,
            k.name,
            k.enabled !== false ? 1 : 0,
            k.maxReceiptsPerDay ?? 100,
            k.maxBytesPerDay ?? 1073741824,
            k.maxConcurrentUploads ?? 5,
            k.validatorId ?? null,
            k.boundValidatorAura ?? null,
          );
        }
      });
      upsertMany(keys);
      console.log(`[blob-gateway] Loaded ${keys.length} API keys from ${keysPath}`);
    } catch (err) {
      console.error(`[blob-gateway] Failed to load keys.json: ${err}`);
    }
  } else if (config.apiKey) {
    // Legacy single-key fallback
    const kh = hashKey(config.apiKey);
    const upsert = db.prepare(`
      INSERT INTO api_keys (key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads)
      VALUES (?, ?, 1, 100, 1073741824, 5)
      ON CONFLICT(key_hash) DO NOTHING
    `);
    upsert.run(kh, "legacy-default");
    console.log("[blob-gateway] Using legacy single API key");
  }
}

/**
 * Resolve a plaintext API key to key info.
 */
export function resolveKey(apiKeyPlaintext: string): KeyInfo | null {
  const kh = hashKey(apiKeyPlaintext);
  const row = db.prepare(
    "SELECT key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads, validator_id, bound_validator_aura FROM api_keys WHERE key_hash = ?",
  ).get(kh) as Record<string, unknown> | undefined;

  if (!row || !row.enabled) return null;

  return {
    keyHash: row.key_hash as string,
    name: row.name as string,
    enabled: !!row.enabled,
    maxReceiptsPerDay: row.max_receipts_per_day as number,
    maxBytesPerDay: row.max_bytes_per_day as number,
    maxConcurrentUploads: row.max_concurrent_uploads as number,
    validatorId: (row.validator_id as string) ?? null,
    boundValidatorAura: (row.bound_validator_aura as string) ?? null,
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Clean up stale inflight uploads (older than 10 minutes).
 */
function cleanStaleInflight(keyHash: string): void {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  db.prepare(
    "DELETE FROM uploads_inflight WHERE key_hash = ? AND started_at < ? AND status = 'active'",
  ).run(keyHash, cutoff);
}

/**
 * Check and record upload start (POST manifest).
 * Returns 429 info if concurrent upload limit exceeded.
 */
export function startUpload(keyInfo: KeyInfo, contentHash: string): QuotaCheckResult {
  const txn = db.transaction(() => {
    cleanStaleInflight(keyInfo.keyHash);

    const inflight = db.prepare(
      "SELECT COUNT(*) as cnt FROM uploads_inflight WHERE key_hash = ? AND status = 'active'",
    ).get(keyInfo.keyHash) as { cnt: number };

    if (inflight.cnt >= keyInfo.maxConcurrentUploads) {
      return {
        allowed: false,
        error: "Concurrent upload limit exceeded",
        limit: keyInfo.maxConcurrentUploads,
        current: inflight.cnt,
      } as QuotaCheckResult;
    }

    db.prepare(
      "INSERT OR REPLACE INTO uploads_inflight (upload_id, key_hash, started_at, bytes, status) VALUES (?, ?, ?, 0, 'active')",
    ).run(contentHash, keyInfo.keyHash, new Date().toISOString());

    return { allowed: true, keyInfo } as QuotaCheckResult;
  });

  return txn();
}

/**
 * Check and record chunk bytes (PUT chunk).
 * Returns 429 info if daily byte limit exceeded.
 */
export function recordChunkBytes(keyInfo: KeyInfo, contentHash: string, chunkBytes: number): QuotaCheckResult {
  const d = today();
  const txn = db.transaction(() => {
    // Ensure daily row exists
    db.prepare(
      "INSERT OR IGNORE INTO quota_daily (key_hash, day, receipts, bytes) VALUES (?, ?, 0, 0)",
    ).run(keyInfo.keyHash, d);

    const daily = db.prepare(
      "SELECT bytes FROM quota_daily WHERE key_hash = ? AND day = ?",
    ).get(keyInfo.keyHash, d) as { bytes: number };

    if (daily.bytes + chunkBytes > keyInfo.maxBytesPerDay) {
      return {
        allowed: false,
        error: "Daily byte quota exceeded",
        limit: keyInfo.maxBytesPerDay,
        current: daily.bytes,
      } as QuotaCheckResult;
    }

    db.prepare(
      "UPDATE quota_daily SET bytes = bytes + ? WHERE key_hash = ? AND day = ?",
    ).run(chunkBytes, keyInfo.keyHash, d);

    // Update inflight tracking
    db.prepare(
      "UPDATE uploads_inflight SET bytes = bytes + ?, started_at = ? WHERE upload_id = ? AND key_hash = ?",
    ).run(chunkBytes, new Date().toISOString(), contentHash, keyInfo.keyHash);

    return { allowed: true, keyInfo } as QuotaCheckResult;
  });

  return txn();
}

/**
 * Finalize upload (all chunks uploaded). Increments daily receipt count.
 * Returns 429 info if daily receipt limit exceeded.
 */
/**
 * Look up a validator by SS58 address in the registry.
 * Returns { name } if the validator is registered and enabled, null otherwise.
 */
export function lookupValidatorInfo(validatorId: string): { name: string } | null {
  const row = db.prepare(
    "SELECT name FROM api_keys WHERE validator_id = ? AND enabled = 1 LIMIT 1",
  ).get(validatorId) as { name: string } | undefined;
  return row ?? null;
}

/**
 * Resolve full KeyInfo by SS58 validator_id. Used by the Bearer-token path in
 * resolveAuth() — a bearer token identifies the account, and we need to find
 * the operator's registered api_keys row so upload quotas apply to the same
 * pool whether the caller used Bearer or x-api-key.
 *
 * Returns the first enabled key row bound to this validator_id, or null if
 * the account hasn't registered as an operator (in which case callers should
 * fall back to account-based quotas).
 */
export function resolveKeyByAccount(ss58: string): KeyInfo | null {
  const row = db.prepare(
    `SELECT key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads, validator_id, bound_validator_aura
     FROM api_keys WHERE validator_id = ? AND enabled = 1 LIMIT 1`,
  ).get(ss58) as Record<string, unknown> | undefined;
  if (!row || !row.enabled) return null;
  return {
    keyHash: row.key_hash as string,
    name: row.name as string,
    enabled: !!row.enabled,
    maxReceiptsPerDay: row.max_receipts_per_day as number,
    maxBytesPerDay: row.max_bytes_per_day as number,
    maxConcurrentUploads: row.max_concurrent_uploads as number,
    validatorId: (row.validator_id as string) ?? null,
    boundValidatorAura: (row.bound_validator_aura as string) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Task #94 — aura → cert-daemon-signer binding
// ---------------------------------------------------------------------------
//
// Off-chain cache version (option 2 from task #94): registers the binding
// without a runtime upgrade. The on-chain authoritative version is a
// separate later task — when it ships, the explorer can fall back to the
// chain query and these helpers retire.

export interface ApiKeyRecord {
  keyHash: string;
  name: string;
  enabled: boolean;
  maxReceiptsPerDay: number;
  maxBytesPerDay: number;
  maxConcurrentUploads: number;
  validatorId: string | null;
  boundValidatorAura: string | null;
}

function rowToApiKeyRecord(
  row: Record<string, unknown> | undefined,
): ApiKeyRecord | null {
  if (!row) return null;
  return {
    keyHash: row.key_hash as string,
    name: row.name as string,
    enabled: !!row.enabled,
    maxReceiptsPerDay: row.max_receipts_per_day as number,
    maxBytesPerDay: row.max_bytes_per_day as number,
    maxConcurrentUploads: row.max_concurrent_uploads as number,
    validatorId: (row.validator_id as string) ?? null,
    boundValidatorAura: (row.bound_validator_aura as string) ?? null,
  };
}

/**
 * Look up an api_keys row by its key_hash. Returns null if no row exists.
 * Used by the admin GET /admin/api-keys/:keyHash introspection endpoint.
 *
 * Unlike resolveKey()/resolveKeyByAccount(), this DOES return rows where
 * enabled = 0 — admin needs visibility into disabled keys for binding ops.
 */
export function getApiKeyByHash(keyHash: string): ApiKeyRecord | null {
  const row = db
    .prepare(
      `SELECT key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day,
              max_concurrent_uploads, validator_id, bound_validator_aura
       FROM api_keys WHERE key_hash = ?`,
    )
    .get(keyHash) as Record<string, unknown> | undefined;
  return rowToApiKeyRecord(row);
}

/**
 * Set the binding from a cert-daemon api_keys row to its operator's
 * validator authoring (aura) SS58. Returns true if the row was updated,
 * false if no row exists for the given keyHash.
 *
 * The aura SS58 is stored verbatim — callers must validate the format
 * (checkAddress round-trip) before calling. Same aura can be bound to
 * multiple cert-daemon rows (degenerate fallback / multi-daemon setups).
 */
export function bindValidatorAura(keyHash: string, validatorAura: string): boolean {
  const result = db
    .prepare("UPDATE api_keys SET bound_validator_aura = ? WHERE key_hash = ?")
    .run(validatorAura, keyHash);
  return result.changes > 0;
}

/**
 * Clear the binding for a cert-daemon api_keys row. Returns true if a row
 * existed (regardless of whether it had a binding). Idempotent: safe to
 * call on rows that already have NULL.
 */
export function clearValidatorAuraBinding(keyHash: string): boolean {
  const result = db
    .prepare("UPDATE api_keys SET bound_validator_aura = NULL WHERE key_hash = ?")
    .run(keyHash);
  return result.changes > 0;
}

export interface AuraBindingLookup {
  /** keyHash of the cert-daemon api_keys row bound to this aura. */
  keyHash: string;
  /** Operator-friendly label from the bound api_keys row. */
  name: string;
  /** SS58 of the cert-daemon signer (= the api_keys row's validator_id). */
  certDaemonSs58: string | null;
}

/**
 * Reverse lookup: given a validator's authoring (aura) SS58, find the
 * cert-daemon api_keys row(s) bound to it. Returns the *first* enabled
 * binding — explorer rendering needs a single answer.
 *
 * NOTE: prod almost always has 1:1, but the schema allows N:1 (an operator
 * could rotate cert-daemon keys without removing the old binding). We
 * silently take the first to keep the explorer deterministic. Admin tooling
 * should clean up stale bindings.
 */
export function getBindingForAura(validatorAura: string): AuraBindingLookup | null {
  const row = db
    .prepare(
      `SELECT key_hash, name, validator_id
       FROM api_keys
       WHERE bound_validator_aura = ? AND enabled = 1
       ORDER BY key_hash ASC
       LIMIT 1`,
    )
    .get(validatorAura) as
    | { key_hash: string; name: string; validator_id: string | null }
    | undefined;
  if (!row) return null;
  return {
    keyHash: row.key_hash,
    name: row.name,
    certDaemonSs58: row.validator_id ?? null,
  };
}

/**
 * List all enabled aura→cert-daemon bindings as a map keyed by aura SS58.
 * Used by the /heartbeats/status endpoint to expose the bindings inline so
 * the explorer doesn't need a separate round-trip per row.
 *
 * Skips rows where validator_id is NULL (no cert-daemon SS58 to point at)
 * or where multiple cert-daemons claim the same aura — we keep the row
 * with the lowest key_hash (deterministic via SQL ORDER BY) so explorer
 * rendering stays stable across requests.
 */
export function listAllAuraBindings(): Record<
  string,
  { certDaemonSs58: string; label: string }
> {
  const rows = db
    .prepare(
      `SELECT bound_validator_aura, validator_id, name
       FROM api_keys
       WHERE bound_validator_aura IS NOT NULL
         AND validator_id IS NOT NULL
         AND enabled = 1
       ORDER BY key_hash ASC`,
    )
    .all() as Array<{
      bound_validator_aura: string;
      validator_id: string;
      name: string;
    }>;
  const out: Record<string, { certDaemonSs58: string; label: string }> = {};
  for (const r of rows) {
    if (out[r.bound_validator_aura]) continue;
    out[r.bound_validator_aura] = {
      certDaemonSs58: r.validator_id,
      label: r.name,
    };
  }
  return out;
}

export function finalizeUpload(keyInfo: KeyInfo, contentHash: string): QuotaCheckResult {
  const d = today();
  const txn = db.transaction(() => {
    db.prepare(
      "INSERT OR IGNORE INTO quota_daily (key_hash, day, receipts, bytes) VALUES (?, ?, 0, 0)",
    ).run(keyInfo.keyHash, d);

    const daily = db.prepare(
      "SELECT receipts FROM quota_daily WHERE key_hash = ? AND day = ?",
    ).get(keyInfo.keyHash, d) as { receipts: number };

    if (daily.receipts >= keyInfo.maxReceiptsPerDay) {
      return {
        allowed: false,
        error: "Daily receipt quota exceeded",
        limit: keyInfo.maxReceiptsPerDay,
        current: daily.receipts,
      } as QuotaCheckResult;
    }

    db.prepare(
      "UPDATE quota_daily SET receipts = receipts + 1 WHERE key_hash = ? AND day = ?",
    ).run(keyInfo.keyHash, d);

    db.prepare(
      "UPDATE uploads_inflight SET status = 'complete' WHERE upload_id = ? AND key_hash = ?",
    ).run(contentHash, keyInfo.keyHash);

    return { allowed: true, keyInfo } as QuotaCheckResult;
  });

  return txn();
}

// ---------------------------------------------------------------------------
// Account-based quotas (sig-only uploaders — keyed by SS58 address)
// ---------------------------------------------------------------------------

function cleanStaleAccountInflight(address: string): void {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  db.prepare(
    "DELETE FROM account_uploads_inflight WHERE address = ? AND started_at < ? AND status = 'active'",
  ).run(address, cutoff);
}

/**
 * Check and record upload start for sig-only uploader.
 */
export function startAccountUpload(address: string, contentHash: string): QuotaCheckResult {
  const txn = db.transaction(() => {
    cleanStaleAccountInflight(address);

    const inflight = db.prepare(
      "SELECT COUNT(*) as cnt FROM account_uploads_inflight WHERE address = ? AND status = 'active'",
    ).get(address) as { cnt: number };

    if (inflight.cnt >= config.sigOnlyMaxConcurrentUploads) {
      return {
        allowed: false,
        error: "Concurrent upload limit exceeded",
        limit: config.sigOnlyMaxConcurrentUploads,
        current: inflight.cnt,
      } as QuotaCheckResult;
    }

    db.prepare(
      "INSERT OR REPLACE INTO account_uploads_inflight (upload_id, address, started_at, bytes, status) VALUES (?, ?, ?, 0, 'active')",
    ).run(contentHash, address, new Date().toISOString());

    return { allowed: true } as QuotaCheckResult;
  });

  return txn();
}

/**
 * Record chunk bytes for sig-only uploader.
 */
export function recordAccountChunkBytes(address: string, contentHash: string, chunkBytes: number): QuotaCheckResult {
  const d = today();
  const txn = db.transaction(() => {
    db.prepare(
      "INSERT OR IGNORE INTO account_quotas_daily (address, day, receipts, bytes) VALUES (?, ?, 0, 0)",
    ).run(address, d);

    const daily = db.prepare(
      "SELECT bytes FROM account_quotas_daily WHERE address = ? AND day = ?",
    ).get(address, d) as { bytes: number };

    if (daily.bytes + chunkBytes > config.sigOnlyMaxBytesPerDay) {
      return {
        allowed: false,
        error: "Daily byte quota exceeded",
        limit: config.sigOnlyMaxBytesPerDay,
        current: daily.bytes,
      } as QuotaCheckResult;
    }

    db.prepare(
      "UPDATE account_quotas_daily SET bytes = bytes + ? WHERE address = ? AND day = ?",
    ).run(chunkBytes, address, d);

    db.prepare(
      "UPDATE account_uploads_inflight SET bytes = bytes + ?, started_at = ? WHERE upload_id = ? AND address = ?",
    ).run(chunkBytes, new Date().toISOString(), contentHash, address);

    return { allowed: true } as QuotaCheckResult;
  });

  return txn();
}

// ---------------------------------------------------------------------------
// Phase 1 billing: lifetime usage metering (per-keyHash, non-enforced).
// ---------------------------------------------------------------------------
//
// Intent: observe what each Bearer/API-key actually consumes so Phase 2 can
// price against real data. No debits, no enforcement, no 402s. The existing
// daily-quota enforcement path is untouched.
//
// Split metering from enforcement so we can keep these counters at the
// bottom of a successful upload path without making them part of the check
// transaction. If a chunk PUT gets admitted and then we crash, the counter
// lags by one call — acceptable for metering, not for billing (Phase 2 will
// promote this to a transactional debit).

export interface UsageSnapshot {
  /** Cumulative receipts (each completed manifest POST counts 1). */
  lifetime_receipts: number;
  /** Cumulative bytes (sum of chunk PUT body lengths). */
  lifetime_bytes: number;
  /** Reserved for Phase 2; always 0 until billing enforcement ships. */
  lifetime_matra_debited: number;
  /** ISO-8601 timestamp of the last recordUsage() call. */
  last_used_at: string | null;
  /** Daily cap snapshot so consumers can compute remaining budget. */
  max_receipts_per_day: number;
  max_bytes_per_day: number;
}

/**
 * Atomically increment the lifetime counters for a keyHash.
 *
 * @param keyHash       sha256-hex of the API key (matches api_keys.key_hash).
 * @param bytes         Byte-count to add to lifetime_bytes (>= 0).
 * @param receiptCount  0 or 1. Pass 1 exactly once per completed manifest
 *                      POST; pass 0 on every chunk PUT. Any other value is
 *                      coerced to {0,1} to keep the counter monotonic.
 *
 * No-op (silent) if the keyHash doesn't exist in api_keys. Phase 2 may
 * flip that to a strict error; for now missing rows indicate an in-flight
 * registration race and we'd rather keep uploads succeeding.
 */
export function recordUsage(
  keyHash: string,
  bytes: number,
  receiptCount: 0 | 1,
): void {
  const safeBytes = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
  const safeReceipts = receiptCount === 1 ? 1 : 0;
  const nowIso = new Date().toISOString();
  const txn = db.transaction(() => {
    db.prepare(
      `UPDATE api_keys
       SET lifetime_receipts = lifetime_receipts + ?,
           lifetime_bytes = lifetime_bytes + ?,
           last_used_at = ?
       WHERE key_hash = ?`,
    ).run(safeReceipts, safeBytes, nowIso, keyHash);
  });
  txn();
}

/**
 * Read the current lifetime counters + daily caps for a keyHash.
 *
 * Returns null if the key is not in api_keys — consumers should treat null
 * as "unknown key" (e.g. HTTP 404 on the admin introspection endpoint).
 */
export function getUsage(keyHash: string): UsageSnapshot | null {
  const row = db
    .prepare(
      `SELECT
         COALESCE(lifetime_receipts, 0) AS lifetime_receipts,
         COALESCE(lifetime_bytes, 0) AS lifetime_bytes,
         COALESCE(lifetime_matra_debited, 0) AS lifetime_matra_debited,
         last_used_at,
         max_receipts_per_day,
         max_bytes_per_day
       FROM api_keys WHERE key_hash = ?`,
    )
    .get(keyHash) as
    | {
        lifetime_receipts: number;
        lifetime_bytes: number;
        lifetime_matra_debited: number;
        last_used_at: string | null;
        max_receipts_per_day: number;
        max_bytes_per_day: number;
      }
    | undefined;
  if (!row) return null;
  return {
    lifetime_receipts: row.lifetime_receipts,
    lifetime_bytes: row.lifetime_bytes,
    lifetime_matra_debited: row.lifetime_matra_debited,
    last_used_at: row.last_used_at,
    max_receipts_per_day: row.max_receipts_per_day,
    max_bytes_per_day: row.max_bytes_per_day,
  };
}

/**
 * Read today's per-key counters from quota_daily (the existing enforcement
 * table — we reuse it rather than inventing a parallel aggregation).
 * Missing row = 0 bytes / 0 receipts today, which matches what the
 * enforcement path would treat as "fresh day".
 */
export function getDailyUsage(
  keyHash: string,
  isoDay: string = today(),
): { receipts_today: number; bytes_today: number } {
  const row = db
    .prepare(
      "SELECT receipts, bytes FROM quota_daily WHERE key_hash = ? AND day = ?",
    )
    .get(keyHash, isoDay) as { receipts: number; bytes: number } | undefined;
  return {
    receipts_today: row?.receipts ?? 0,
    bytes_today: row?.bytes ?? 0,
  };
}

/**
 * Finalize upload for sig-only uploader. Increments daily receipt count.
 */
export function finalizeAccountUpload(address: string, contentHash: string): QuotaCheckResult {
  const d = today();
  const txn = db.transaction(() => {
    db.prepare(
      "INSERT OR IGNORE INTO account_quotas_daily (address, day, receipts, bytes) VALUES (?, ?, 0, 0)",
    ).run(address, d);

    const daily = db.prepare(
      "SELECT receipts FROM account_quotas_daily WHERE address = ? AND day = ?",
    ).get(address, d) as { receipts: number };

    if (daily.receipts >= config.sigOnlyMaxReceiptsPerDay) {
      return {
        allowed: false,
        error: "Daily receipt quota exceeded",
        limit: config.sigOnlyMaxReceiptsPerDay,
        current: daily.receipts,
      } as QuotaCheckResult;
    }

    db.prepare(
      "UPDATE account_quotas_daily SET receipts = receipts + 1 WHERE address = ? AND day = ?",
    ).run(address, d);

    db.prepare(
      "UPDATE account_uploads_inflight SET status = 'complete' WHERE upload_id = ? AND address = ?",
    ).run(contentHash, address);

    return { allowed: true } as QuotaCheckResult;
  });

  return txn();
}
