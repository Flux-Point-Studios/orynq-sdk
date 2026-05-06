/**
 * SQLite-backed registry of OBSERVERS — independent third parties that may
 * co-sign a `compute_metering_v2` record over the same pre-image as the
 * worker.
 *
 * The observer signature is OPTIONAL on v2 records. When present, the
 * gateway enforces:
 *   - observer_pubkey must exist in this registry AND not be revoked
 *   - observer_signature must verify against the same canonical CBOR pre-image
 *     as worker_signature
 *
 * Schema and shape are intentionally identical to fleet_operators.ts — same
 * columns, same function signatures, same admin endpoints — to keep cognitive
 * overhead low. The only difference is the backing file (`observers.db`)
 * and the table name (`observers`).
 *
 * Why not share a generic `attestor_keys` table?
 *   - Different revocation policies in the future (operators may want to
 *     globally revoke a fleet operator while still trusting them as an
 *     observer for some workloads, or vice versa).
 *   - Different audit/discovery surface for ops tooling. Operators ask
 *     "who can claim hardware for me?" (fleet operators) and
 *     "who can co-sign my work?" (observers) as separate questions.
 *   - Migrations stay isolated.
 */

import Database from "better-sqlite3";
import { join } from "path";
import { config } from "./config.js";

let db: Database.Database | null = null;

export function setObserversDbForTests(injected: Database.Database): void {
  db = injected;
}

export function getObserversDb(): Database.Database {
  if (!db) {
    throw new Error("observers db not initialised — call initObserversDb() first");
  }
  return db;
}

/**
 * Initialise the observers table on a SQLite handle. Idempotent.
 *
 * If `database` is omitted, opens (or creates) `observers.db` at the canonical
 * storage path. Tests should pass an in-memory handle.
 */
export function initObserversDb(
  database?: Database.Database,
): Database.Database {
  const handle =
    database ?? new Database(join(config.storagePath, "observers.db"));
  handle.pragma("journal_mode = WAL");
  handle.pragma("busy_timeout = 5000");
  handle.exec(`
    CREATE TABLE IF NOT EXISTS observers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pubkey_hex TEXT UNIQUE NOT NULL,
      label TEXT,
      registered_at INTEGER NOT NULL,
      revoked_at INTEGER,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_observers_pubkey
      ON observers(pubkey_hex);
    CREATE INDEX IF NOT EXISTS idx_observers_active
      ON observers(pubkey_hex) WHERE revoked_at IS NULL;
  `);
  if (!db) db = handle;
  return handle;
}

export interface ObserverRow {
  id: number;
  pubkey_hex: string;
  label: string | null;
  registered_at: number;
  revoked_at: number | null;
  notes: string | null;
}

const HEX64 = /^[0-9a-f]{64}$/;

function normalizePubkey(input: string): string {
  const stripped = input.startsWith("0x") || input.startsWith("0X")
    ? input.slice(2)
    : input;
  return stripped.toLowerCase();
}

export interface RegisterObserverInput {
  pubkey: string;
  label?: string | null;
  notes?: string | null;
  now?: number;
}

export function registerObserver(
  input: RegisterObserverInput,
): ObserverRow {
  if (!db) throw new Error("observers db not initialised");
  const normalized = normalizePubkey(input.pubkey);
  if (!HEX64.test(normalized)) {
    throw new TypeError(
      `registerObserver: pubkey must be 32 bytes hex (64 chars), got "${input.pubkey}"`,
    );
  }
  const label = input.label ? String(input.label).slice(0, 256) : null;
  const notes = input.notes ? String(input.notes).slice(0, 1024) : null;
  const registeredAt = input.now ?? Math.floor(Date.now() / 1000);

  const info = db
    .prepare(
      `INSERT INTO observers (pubkey_hex, label, registered_at, notes)
       VALUES (?, ?, ?, ?)`,
    )
    .run(normalized, label, registeredAt, notes);

  return {
    id: Number(info.lastInsertRowid),
    pubkey_hex: normalized,
    label,
    registered_at: registeredAt,
    revoked_at: null,
    notes,
  };
}

export function revokeObserver(
  pubkey: string,
  opts: { now?: number } = {},
): boolean {
  if (!db) throw new Error("observers db not initialised");
  const normalized = normalizePubkey(pubkey);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const info = db
    .prepare(
      `UPDATE observers SET revoked_at = ?
       WHERE pubkey_hex = ? AND revoked_at IS NULL`,
    )
    .run(now, normalized);
  return info.changes > 0;
}

export function getObserver(pubkey: string): ObserverRow | null {
  if (!db) return null;
  const normalized = normalizePubkey(pubkey);
  const row = db
    .prepare(
      `SELECT id, pubkey_hex, label, registered_at, revoked_at, notes
       FROM observers WHERE pubkey_hex = ?`,
    )
    .get(normalized) as ObserverRow | undefined;
  return row ?? null;
}

export function isObserverActive(pubkey: string): boolean {
  if (!db) return false;
  const normalized = normalizePubkey(pubkey);
  const row = db
    .prepare(
      `SELECT 1 AS one FROM observers
       WHERE pubkey_hex = ? AND revoked_at IS NULL`,
    )
    .get(normalized) as { one: number } | undefined;
  return row !== undefined;
}

export interface ListObserversOpts {
  active?: boolean;
}

export function listObservers(
  opts: ListObserversOpts = {},
): ObserverRow[] {
  if (!db) return [];
  const where = opts.active ? "WHERE revoked_at IS NULL" : "";
  const rows = db
    .prepare(
      `SELECT id, pubkey_hex, label, registered_at, revoked_at, notes
       FROM observers
       ${where}
       ORDER BY registered_at DESC, id DESC`,
    )
    .all() as ObserverRow[];
  return rows;
}
