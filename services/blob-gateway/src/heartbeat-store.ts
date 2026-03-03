/**
 * SQLite-backed heartbeat storage for validator liveness reporting.
 *
 * Database lives on PVC at /data/blobs/heartbeat.db — survives restarts,
 * atomic writes, single-writer (fine for 1 replica).
 */

import Database from "better-sqlite3";
import { join } from "path";
import { config } from "./config.js";

let db: Database.Database;

/* ---------- Lazy prepared statements ---------- */

let _upsertStmt: Database.Statement | null = null;
let _getLastSeqStmt: Database.Statement | null = null;
let _getAllLatestStmt: Database.Statement | null = null;
let _logRejectStmt: Database.Statement | null = null;
let _pruneRejectLogStmt: Database.Statement | null = null;
let _appendLogStmt: Database.Statement | null = null;
let _cleanupLogStmt: Database.Statement | null = null;

function upsertStmt(): Database.Statement {
  if (!_upsertStmt) {
    _upsertStmt = db.prepare(`
      INSERT INTO heartbeat_latest (
        validator_id, label, seq, payload, signature, received_at,
        best_block, finalized_block, finality_gap, pending_receipts,
        certs_submitted, substrate_connected, version, uptime_seconds, clock_skew_secs
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(validator_id) DO UPDATE SET
        label = excluded.label,
        seq = excluded.seq,
        payload = excluded.payload,
        signature = excluded.signature,
        received_at = excluded.received_at,
        best_block = excluded.best_block,
        finalized_block = excluded.finalized_block,
        finality_gap = excluded.finality_gap,
        pending_receipts = excluded.pending_receipts,
        certs_submitted = excluded.certs_submitted,
        substrate_connected = excluded.substrate_connected,
        version = excluded.version,
        uptime_seconds = excluded.uptime_seconds,
        clock_skew_secs = excluded.clock_skew_secs
    `);
  }
  return _upsertStmt;
}

function getLastSeqStmt(): Database.Statement {
  if (!_getLastSeqStmt) {
    _getLastSeqStmt = db.prepare(
      "SELECT seq FROM heartbeat_latest WHERE validator_id = ?",
    );
  }
  return _getLastSeqStmt;
}

function getAllLatestStmt(): Database.Statement {
  if (!_getAllLatestStmt) {
    _getAllLatestStmt = db.prepare("SELECT * FROM heartbeat_latest");
  }
  return _getAllLatestStmt;
}

function logRejectStmt(): Database.Statement {
  if (!_logRejectStmt) {
    _logRejectStmt = db.prepare(
      "INSERT INTO heartbeat_reject_log (validator_id, received_at, reason, ip) VALUES (?, ?, ?, ?)",
    );
  }
  return _logRejectStmt;
}

function pruneRejectLogStmt(): Database.Statement {
  if (!_pruneRejectLogStmt) {
    _pruneRejectLogStmt = db.prepare(`
      DELETE FROM heartbeat_reject_log WHERE id NOT IN (
        SELECT id FROM heartbeat_reject_log ORDER BY id DESC LIMIT 1000
      )
    `);
  }
  return _pruneRejectLogStmt;
}

function appendLogStmt(): Database.Statement {
  if (!_appendLogStmt) {
    _appendLogStmt = db.prepare(
      "INSERT INTO heartbeat_log (validator_id, received_at, best_block) VALUES (?, ?, ?)",
    );
  }
  return _appendLogStmt;
}

function cleanupLogStmt(): Database.Statement {
  if (!_cleanupLogStmt) {
    _cleanupLogStmt = db.prepare(
      "DELETE FROM heartbeat_log WHERE received_at < ?",
    );
  }
  return _cleanupLogStmt;
}

/* ---------- Public API ---------- */

/**
 * Initialize heartbeat SQLite database and create tables.
 */
export function initHeartbeatDb(): void {
  const dbPath = join(config.storagePath, "heartbeat.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS heartbeat_latest (
      validator_id TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      seq INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL,
      signature TEXT NOT NULL,
      received_at TEXT NOT NULL,
      best_block INTEGER NOT NULL DEFAULT 0,
      finalized_block INTEGER NOT NULL DEFAULT 0,
      finality_gap INTEGER NOT NULL DEFAULT 0,
      pending_receipts INTEGER NOT NULL DEFAULT 0,
      certs_submitted INTEGER NOT NULL DEFAULT 0,
      substrate_connected INTEGER NOT NULL DEFAULT 1,
      version TEXT NOT NULL DEFAULT '',
      uptime_seconds REAL NOT NULL DEFAULT 0,
      clock_skew_secs REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS heartbeat_reject_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      validator_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      ip TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS heartbeat_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      validator_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      best_block INTEGER NOT NULL
    );
  `);
}

/**
 * Upsert a heartbeat into heartbeat_latest.
 */
export function upsertHeartbeat(
  validatorId: string,
  label: string,
  seq: number,
  payload: string,
  signature: string,
  bestBlock: number,
  finalizedBlock: number,
  finalityGap: number,
  pendingReceipts: number,
  certsSubmitted: number,
  substrateConnected: number,
  version: string,
  uptimeSeconds: number,
  clockSkewSecs: number,
): void {
  upsertStmt().run(
    validatorId,
    label,
    seq,
    payload,
    signature,
    new Date().toISOString(),
    bestBlock,
    finalizedBlock,
    finalityGap,
    pendingReceipts,
    certsSubmitted,
    substrateConnected,
    version,
    uptimeSeconds,
    clockSkewSecs,
  );
}

/**
 * Get the last sequence number for a validator.
 * Returns undefined if no heartbeat has been received.
 */
export function getLastSeq(validatorId: string): number | undefined {
  const row = getLastSeqStmt().get(validatorId) as { seq: number } | undefined;
  return row?.seq;
}

export interface HeartbeatRow {
  validator_id: string;
  label: string;
  seq: number;
  payload: string;
  signature: string;
  received_at: string;
  best_block: number;
  finalized_block: number;
  finality_gap: number;
  pending_receipts: number;
  certs_submitted: number;
  substrate_connected: number;
  version: string;
  uptime_seconds: number;
  clock_skew_secs: number;
}

/**
 * Get all rows from heartbeat_latest.
 */
export function getAllLatest(): HeartbeatRow[] {
  return getAllLatestStmt().all() as HeartbeatRow[];
}

/**
 * Log a rejected heartbeat. Enforces 1000-row cap on reject log.
 */
export function logReject(validatorId: string, reason: string, ip: string): void {
  logRejectStmt().run(validatorId, new Date().toISOString(), reason, ip);
  pruneRejectLogStmt().run();
}

/**
 * Append a row to heartbeat_log (recent history).
 */
export function appendHeartbeatLog(validatorId: string, bestBlock: number): void {
  appendLogStmt().run(validatorId, new Date().toISOString(), bestBlock);
}

/**
 * Start periodic cleanup of heartbeat_log rows older than 5 minutes.
 * Runs every 60 seconds.
 */
export function startHeartbeatCleanup(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try {
      const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      cleanupLogStmt().run(cutoff);
    } catch (err) {
      console.error("[blob-gateway] Heartbeat log cleanup error:", err);
    }
  }, 60_000);
}
