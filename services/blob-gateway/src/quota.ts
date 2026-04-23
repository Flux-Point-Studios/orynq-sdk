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

  loadKeys();
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
      }>;

      const upsert = db.prepare(`
        INSERT INTO api_keys (key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads, validator_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key_hash) DO UPDATE SET
          name = excluded.name,
          enabled = excluded.enabled,
          max_receipts_per_day = excluded.max_receipts_per_day,
          max_bytes_per_day = excluded.max_bytes_per_day,
          max_concurrent_uploads = excluded.max_concurrent_uploads,
          validator_id = excluded.validator_id
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
    "SELECT key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads, validator_id FROM api_keys WHERE key_hash = ?",
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
    `SELECT key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads, validator_id
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
  };
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
