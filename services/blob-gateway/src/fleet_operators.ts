/**
 * SQLite-backed registry of FLEET OPERATORS — third parties that attest to
 * the hardware specification of compute workers.
 *
 * In `compute_metering_v2`, every record carries a `hardware_spec` sub-object
 * with a `fleet_operator_pubkey` + `fleet_operator_signature`. The fleet
 * operator is the only party allowed to declare what hardware a worker is
 * running on (so a worker can't unilaterally inflate its own capacity in
 * order to over-bill). Only fleet operators in this registry — and not
 * revoked — pass the gateway's check.
 *
 * Trust framing: this registry implements rule (8) in the v2 validator,
 * "fleet_operator_pubkey exists in fleet_operators table AND is not revoked."
 * Mutation is admin-only (see routes/fleet_operators.ts).
 *
 * Why a separate db/file from operators/api_tokens?
 *   - Different access pattern (admin-only writes; gateway-frequent reads).
 *   - Different lifecycle (operators are validators that join/leave the chain;
 *     fleet operators are organizations that vouch for hardware fleets).
 *   - Different on-disk file means a fleet-operators schema migration can
 *     never collide with an api-tokens migration (per
 *     `feedback_orynq_gateway_migration_gaps.md`'s "audit every wire-up"
 *     lesson).
 */

import Database from "better-sqlite3";
import { join } from "path";
import { config } from "./config.js";

let db: Database.Database | null = null;

/** Test hook: inject a handle (typically `:memory:` for unit tests). */
export function setFleetOperatorsDbForTests(injected: Database.Database): void {
  db = injected;
}

/** Test/debug helper — returns the current handle or throws if uninitialised. */
export function getFleetOperatorsDb(): Database.Database {
  if (!db) {
    throw new Error(
      "fleet_operators db not initialised — call initFleetOperatorsDb() first",
    );
  }
  return db;
}

/**
 * Initialise the fleet_operators table on a SQLite handle.
 *
 * Idempotent: safe to call repeatedly. CREATE IF NOT EXISTS is the workhorse;
 * column additions (when we add them) go through migrate*Columns() helpers
 * with the same try/swallow-duplicate-name pattern api-tokens.ts uses for
 * parallel-startup races.
 *
 * If `database` is omitted, opens (or creates) `fleet_operators.db` at the
 * canonical storage path. Tests should pass an in-memory handle.
 */
export function initFleetOperatorsDb(
  database?: Database.Database,
): Database.Database {
  const handle =
    database ?? new Database(join(config.storagePath, "fleet_operators.db"));
  handle.pragma("journal_mode = WAL");
  handle.pragma("busy_timeout = 5000");
  handle.exec(`
    CREATE TABLE IF NOT EXISTS fleet_operators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pubkey_hex TEXT UNIQUE NOT NULL,
      label TEXT,
      registered_at INTEGER NOT NULL,
      revoked_at INTEGER,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fleet_operators_pubkey
      ON fleet_operators(pubkey_hex);
    CREATE INDEX IF NOT EXISTS idx_fleet_operators_active
      ON fleet_operators(pubkey_hex) WHERE revoked_at IS NULL;
  `);
  if (!db) db = handle;
  return handle;
}

export interface FleetOperatorRow {
  id: number;
  pubkey_hex: string;
  label: string | null;
  registered_at: number;
  revoked_at: number | null;
  notes: string | null;
}

/** Hex regex for 32-byte sr25519 pubkey (64 lowercase hex chars). */
const HEX64 = /^[0-9a-f]{64}$/;

function normalizePubkey(input: string): string {
  // Accept inputs with or without 0x prefix; canonicalise to lowercase no-prefix.
  const stripped = input.startsWith("0x") || input.startsWith("0X")
    ? input.slice(2)
    : input;
  return stripped.toLowerCase();
}

export interface RegisterFleetOperatorInput {
  pubkey: string;
  label?: string | null;
  notes?: string | null;
  /** Unix seconds override; used in tests for determinism. */
  now?: number;
}

/**
 * Insert a new fleet operator row. Returns the freshly-inserted row.
 *
 * Throws if a row with that pubkey already exists (UNIQUE constraint). Caller
 * (route layer) should catch and translate to 409. We intentionally DO NOT
 * silently re-register a revoked operator — the admin must explicitly revive
 * one (a separate, future endpoint), keeping the audit trail intact.
 */
export function registerFleetOperator(
  input: RegisterFleetOperatorInput,
): FleetOperatorRow {
  if (!db) throw new Error("fleet_operators db not initialised");
  const normalized = normalizePubkey(input.pubkey);
  if (!HEX64.test(normalized)) {
    throw new TypeError(
      `registerFleetOperator: pubkey must be 32 bytes hex (64 chars), got "${input.pubkey}"`,
    );
  }
  const label = input.label ? String(input.label).slice(0, 256) : null;
  const notes = input.notes ? String(input.notes).slice(0, 1024) : null;
  const registeredAt = input.now ?? Math.floor(Date.now() / 1000);

  const info = db
    .prepare(
      `INSERT INTO fleet_operators (pubkey_hex, label, registered_at, notes)
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

/**
 * Mark a fleet operator as revoked. Idempotent: if already revoked, returns
 * `false`; if not found, returns `false`; otherwise `true`. Never re-stamps
 * the original revocation timestamp.
 */
export function revokeFleetOperator(
  pubkey: string,
  opts: { now?: number } = {},
): boolean {
  if (!db) throw new Error("fleet_operators db not initialised");
  const normalized = normalizePubkey(pubkey);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const info = db
    .prepare(
      `UPDATE fleet_operators SET revoked_at = ?
       WHERE pubkey_hex = ? AND revoked_at IS NULL`,
    )
    .run(now, normalized);
  return info.changes > 0;
}

/** Look up a single row by pubkey (active or revoked). */
export function getFleetOperator(pubkey: string): FleetOperatorRow | null {
  if (!db) return null;
  const normalized = normalizePubkey(pubkey);
  const row = db
    .prepare(
      `SELECT id, pubkey_hex, label, registered_at, revoked_at, notes
       FROM fleet_operators WHERE pubkey_hex = ?`,
    )
    .get(normalized) as FleetOperatorRow | undefined;
  return row ?? null;
}

/**
 * Hot-path check used by the v2 validator: returns true iff the pubkey is
 * registered AND not revoked. Defensively returns false when the registry
 * isn't initialised (so a misconfigured boot rejects all v2 records loudly
 * via 403 rather than silently accepting forged hardware claims).
 */
export function isFleetOperatorActive(pubkey: string): boolean {
  if (!db) return false;
  const normalized = normalizePubkey(pubkey);
  const row = db
    .prepare(
      `SELECT 1 AS one FROM fleet_operators
       WHERE pubkey_hex = ? AND revoked_at IS NULL`,
    )
    .get(normalized) as { one: number } | undefined;
  return row !== undefined;
}

export interface ListFleetOperatorsOpts {
  /** When true, return only active rows. Default false (return all). */
  active?: boolean;
}

/**
 * List rows. Order: registered_at DESC, id DESC (stable within same epoch).
 */
export function listFleetOperators(
  opts: ListFleetOperatorsOpts = {},
): FleetOperatorRow[] {
  if (!db) return [];
  const where = opts.active ? "WHERE revoked_at IS NULL" : "";
  const rows = db
    .prepare(
      `SELECT id, pubkey_hex, label, registered_at, revoked_at, notes
       FROM fleet_operators
       ${where}
       ORDER BY registered_at DESC, id DESC`,
    )
    .all() as FleetOperatorRow[];
  return rows;
}
