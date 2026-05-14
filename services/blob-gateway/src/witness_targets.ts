/**
 * SQLite-backed registry of WITNESS TARGETS — URLs that the Materios
 * Witness Network APK probes on a periodic schedule.
 *
 * Each row is a URL the APK fleet should GET, hash the body of, and sign
 * inside its TEE-backed KeyMint identity. The signed result lands on the
 * gateway, gets attested by the M-of-N committee, and is anchored to
 * Cardano L1. From a buyer's standpoint: their site's uptime claims
 * become cryptographically falsifiable instead of asserted.
 *
 * Schema shape intentionally mirrors `observers.ts` and `fleet_operators.ts`
 * — same column conventions (registered_at / revoked_at / notes), separate
 * SQLite file (`witness_targets.db`), separate revocation policy.
 *
 * Why not store inside the existing api_tokens.db?
 *   - Distinct admin surface — operators ask "who can sign?" (attestors)
 *     vs "what should we probe?" (targets) as separate questions.
 *   - The targets table is fundamentally PUBLIC read (the APK polls it
 *     unauthenticated), unlike api_tokens which is bearer-secret.
 *   - Schema migrations stay isolated.
 *
 * Auth model:
 *   - `GET /witness/targets` is PUBLIC (the witness APK fetches it on every
 *     WorkManager tick — there's no per-device secret to share).
 *   - `POST /admin/witness/targets` is admin-token gated for now. A future
 *     `POST /witness/targets` with bearer-auth + tenant binding will let
 *     site owners self-register; that's deferred until we have a signup
 *     form that mints the bearer.
 */

import Database from "better-sqlite3";
import { join } from "path";
import { config } from "./config.js";

let db: Database.Database | null = null;

export function setWitnessTargetsDbForTests(injected: Database.Database): void {
  db = injected;
}

export function getWitnessTargetsDb(): Database.Database {
  if (!db) {
    throw new Error(
      "witness_targets db not initialised — call initWitnessTargetsDb() first",
    );
  }
  return db;
}

/**
 * Initialise the witness_targets table on a SQLite handle. Idempotent.
 *
 * If `database` is omitted, opens (or creates) `witness_targets.db` at the
 * canonical storage path. Tests should pass an in-memory handle.
 */
export function initWitnessTargetsDb(
  database?: Database.Database,
): Database.Database {
  const handle =
    database ?? new Database(join(config.storagePath, "witness_targets.db"));
  handle.pragma("journal_mode = WAL");
  handle.pragma("busy_timeout = 5000");
  handle.exec(`
    CREATE TABLE IF NOT EXISTS witness_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      label TEXT,
      owner_token_id INTEGER,
      registered_at INTEGER NOT NULL,
      revoked_at INTEGER,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_witness_targets_url
      ON witness_targets(url);
    CREATE INDEX IF NOT EXISTS idx_witness_targets_active
      ON witness_targets(url) WHERE revoked_at IS NULL;
  `);
  if (!db) db = handle;
  return handle;
}

export interface WitnessTargetRow {
  id: number;
  url: string;
  label: string | null;
  owner_token_id: number | null;
  registered_at: number;
  revoked_at: number | null;
  notes: string | null;
}

/**
 * Validate a probe-target URL. Strict on purpose — these URLs go onto a
 * shared roster fetched by phones that we don't directly control, so the
 * blast radius of a malicious value is the entire witness fleet. Reject:
 *   - Anything that doesn't parse as a URL
 *   - Schemes other than http: or https:
 *   - URLs over 1024 chars (gateway has its own caps and the APK has a
 *     reasonable size assumption per probe slot)
 *   - URLs with userinfo (foo:bar@example.com) — no credentials in probes
 *   - Hosts that look like RFC1918 / loopback when running in production
 *     (skipped: hard to enforce here without a request-time DNS check;
 *     leaving as a follow-up SSRF mitigation)
 */
export function validateProbeUrl(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new TypeError("url is required");
  }
  if (input.length > 1024) {
    throw new TypeError("url too long (max 1024 chars)");
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new TypeError("url is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(
      `url must use http or https scheme, got "${parsed.protocol}"`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new TypeError("url must not contain userinfo (credentials)");
  }
  // Normalise: lowercase the host, keep the rest verbatim. This means
  // `HTTPS://Example.com/path` and `https://example.com/path` collide
  // on the UNIQUE index.
  parsed.hostname = parsed.hostname.toLowerCase();
  return parsed.toString();
}

export interface RegisterWitnessTargetInput {
  url: string;
  label?: string | null;
  notes?: string | null;
  ownerTokenId?: number | null;
  now?: number;
}

export function registerWitnessTarget(
  input: RegisterWitnessTargetInput,
): WitnessTargetRow {
  if (!db) throw new Error("witness_targets db not initialised");
  const url = validateProbeUrl(input.url);
  const label = input.label ? String(input.label).slice(0, 256) : null;
  const notes = input.notes ? String(input.notes).slice(0, 1024) : null;
  const ownerTokenId = input.ownerTokenId ?? null;
  const registeredAt = input.now ?? Math.floor(Date.now() / 1000);

  const info = db
    .prepare(
      `INSERT INTO witness_targets (url, label, owner_token_id, registered_at, notes)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(url, label, ownerTokenId, registeredAt, notes);

  return {
    id: Number(info.lastInsertRowid),
    url,
    label,
    owner_token_id: ownerTokenId,
    registered_at: registeredAt,
    revoked_at: null,
    notes,
  };
}

export function revokeWitnessTarget(
  url: string,
  opts: { now?: number } = {},
): boolean {
  if (!db) throw new Error("witness_targets db not initialised");
  const normalized = validateProbeUrl(url);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const info = db
    .prepare(
      `UPDATE witness_targets SET revoked_at = ?
       WHERE url = ? AND revoked_at IS NULL`,
    )
    .run(now, normalized);
  return info.changes > 0;
}

export function getWitnessTarget(url: string): WitnessTargetRow | null {
  if (!db) return null;
  let normalized: string;
  try {
    normalized = validateProbeUrl(url);
  } catch {
    return null;
  }
  const row = db
    .prepare(
      `SELECT id, url, label, owner_token_id, registered_at, revoked_at, notes
       FROM witness_targets WHERE url = ?`,
    )
    .get(normalized) as WitnessTargetRow | undefined;
  return row ?? null;
}

export interface ListWitnessTargetsOpts {
  active?: boolean;
}

export function listWitnessTargets(
  opts: ListWitnessTargetsOpts = {},
): WitnessTargetRow[] {
  if (!db) return [];
  const where = opts.active ? "WHERE revoked_at IS NULL" : "";
  const rows = db
    .prepare(
      `SELECT id, url, label, owner_token_id, registered_at, revoked_at, notes
       FROM witness_targets
       ${where}
       ORDER BY registered_at DESC, id DESC`,
    )
    .all() as WitnessTargetRow[];
  return rows;
}
