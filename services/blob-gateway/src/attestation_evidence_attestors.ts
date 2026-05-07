/**
 * SQLite-backed registry of ATTESTATION-EVIDENCE ATTESTORS — the third
 * parties (Acurast Android phones for Wave 3 Phase 2; SEV-SNP / TDX hosts
 * for Phase 3.x) whose TEE-protected keys sign POST /v2/attestation_evidence
 * payloads.
 *
 * Mirrors `fleet_operators.ts` / `observers.ts` — same shape, same lifecycle,
 * same admin endpoints. Backed by a separate file (`attestors.db`) so its
 * schema migrations stay isolated from the older registries.
 *
 * Trust framing: this registry is the off-chain analogue of the on-chain
 * `enrolled_chip_id_hashes` set described in § 4 of the Wave 3 design doc
 * (`/home/deci/wave-3-polychain-attestation-pallet-design.md`). The on-chain
 * pallet (built in parallel) keeps the canonical chip-ID set; this gateway
 * registry is the operator-managed set of "attestor pubkeys we'll accept
 * evidence from at the gateway." Both can be reconciled by ops tooling
 * (planned follow-up — out of scope for this PR).
 */

import Database from "better-sqlite3";
import { join } from "path";
import { config } from "./config.js";

let db: Database.Database | null = null;

/** Test hook: inject a handle (typically `:memory:` for unit tests). */
export function setAttestationEvidenceAttestorsDbForTests(
  injected: Database.Database,
): void {
  db = injected;
}

/** Test/debug helper — returns the current handle or throws if uninitialised. */
export function getAttestationEvidenceAttestorsDb(): Database.Database {
  if (!db) {
    throw new Error(
      "attestation_evidence_attestors db not initialised — call init...() first",
    );
  }
  return db;
}

/**
 * Initialise the attestation_evidence_attestors table on a SQLite handle.
 *
 * Idempotent: safe to call repeatedly. CREATE IF NOT EXISTS is the workhorse;
 * column additions go through migrate*Columns() helpers later.
 *
 * If `database` is omitted, opens (or creates) `attestation_evidence_attestors.db`
 * at the canonical storage path. Tests should pass an in-memory handle.
 */
export function initAttestationEvidenceAttestorsDb(
  database?: Database.Database,
): Database.Database {
  const handle =
    database ??
    new Database(join(config.storagePath, "attestation_evidence_attestors.db"));
  handle.pragma("journal_mode = WAL");
  handle.pragma("busy_timeout = 5000");
  handle.exec(`
    CREATE TABLE IF NOT EXISTS attestation_evidence_attestors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pubkey_hex TEXT UNIQUE NOT NULL,
      label TEXT,
      registered_at INTEGER NOT NULL,
      revoked_at INTEGER,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_aea_pubkey
      ON attestation_evidence_attestors(pubkey_hex);
    CREATE INDEX IF NOT EXISTS idx_aea_active
      ON attestation_evidence_attestors(pubkey_hex) WHERE revoked_at IS NULL;
  `);
  if (!db) db = handle;
  return handle;
}

export interface AttestationEvidenceAttestorRow {
  id: number;
  pubkey_hex: string;
  label: string | null;
  registered_at: number;
  revoked_at: number | null;
  notes: string | null;
}

const HEX64 = /^[0-9a-f]{64}$/;

function normalizePubkey(input: string): string {
  const stripped =
    input.startsWith("0x") || input.startsWith("0X") ? input.slice(2) : input;
  return stripped.toLowerCase();
}

export interface RegisterAttestorInput {
  pubkey: string;
  label?: string | null;
  notes?: string | null;
  /** Unix seconds override; used in tests for determinism. */
  now?: number;
}

export function registerAttestationEvidenceAttestor(
  input: RegisterAttestorInput,
): AttestationEvidenceAttestorRow {
  if (!db) throw new Error("attestation_evidence_attestors db not initialised");
  const normalized = normalizePubkey(input.pubkey);
  if (!HEX64.test(normalized)) {
    throw new TypeError(
      `registerAttestationEvidenceAttestor: pubkey must be 32 bytes hex (64 chars), got "${input.pubkey}"`,
    );
  }
  const label = input.label ? String(input.label).slice(0, 256) : null;
  const notes = input.notes ? String(input.notes).slice(0, 1024) : null;
  const registeredAt = input.now ?? Math.floor(Date.now() / 1000);

  const info = db
    .prepare(
      `INSERT INTO attestation_evidence_attestors (pubkey_hex, label, registered_at, notes)
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

export function revokeAttestationEvidenceAttestor(
  pubkey: string,
  opts: { now?: number } = {},
): boolean {
  if (!db) throw new Error("attestation_evidence_attestors db not initialised");
  const normalized = normalizePubkey(pubkey);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const info = db
    .prepare(
      `UPDATE attestation_evidence_attestors SET revoked_at = ?
       WHERE pubkey_hex = ? AND revoked_at IS NULL`,
    )
    .run(now, normalized);
  return info.changes > 0;
}

export function getAttestationEvidenceAttestor(
  pubkey: string,
): AttestationEvidenceAttestorRow | null {
  if (!db) return null;
  const normalized = normalizePubkey(pubkey);
  const row = db
    .prepare(
      `SELECT id, pubkey_hex, label, registered_at, revoked_at, notes
       FROM attestation_evidence_attestors WHERE pubkey_hex = ?`,
    )
    .get(normalized) as AttestationEvidenceAttestorRow | undefined;
  return row ?? null;
}

/**
 * Hot-path check used by the v2/attestation_evidence route: returns true iff
 * the pubkey is registered AND not revoked. Defensively returns false when
 * the registry isn't initialised.
 */
export function isAttestationEvidenceAttestorActive(pubkey: string): boolean {
  if (!db) return false;
  const normalized = normalizePubkey(pubkey);
  const row = db
    .prepare(
      `SELECT 1 AS one FROM attestation_evidence_attestors
       WHERE pubkey_hex = ? AND revoked_at IS NULL`,
    )
    .get(normalized) as { one: number } | undefined;
  return row !== undefined;
}

export interface ListAttestorsOpts {
  active?: boolean;
}

export function listAttestationEvidenceAttestors(
  opts: ListAttestorsOpts = {},
): AttestationEvidenceAttestorRow[] {
  if (!db) return [];
  const where = opts.active ? "WHERE revoked_at IS NULL" : "";
  const rows = db
    .prepare(
      `SELECT id, pubkey_hex, label, registered_at, revoked_at, notes
       FROM attestation_evidence_attestors
       ${where}
       ORDER BY registered_at DESC, id DESC`,
    )
    .all() as AttestationEvidenceAttestorRow[];
  return rows;
}
