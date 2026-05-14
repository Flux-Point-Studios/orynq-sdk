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
  migrateSigAlgoColumn(handle);
  if (!db) db = handle;
  return handle;
}

/** Signature algorithms the gateway will accept on POST /v2/attestation_evidence. */
export const SIG_ALGOS = ["sr25519", "ed25519"] as const;
export type SigAlgo = (typeof SIG_ALGOS)[number];
const SIG_ALGO_SET: ReadonlySet<string> = new Set<string>(SIG_ALGOS);

/**
 * Add `sig_algo` column to existing tables. Older rows default to "sr25519"
 * so the existing SEV-SNP / TDX / cert-daemon attestors keep working without
 * a re-register pass. New rows (Acurast phones, etc.) declare their algo
 * explicitly via the admin POST.
 */
export function migrateSigAlgoColumn(handle: Database.Database): void {
  const cols = handle
    .prepare(`PRAGMA table_info(attestation_evidence_attestors)`)
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "sig_algo")) {
    handle.exec(`
      ALTER TABLE attestation_evidence_attestors
      ADD COLUMN sig_algo TEXT NOT NULL DEFAULT 'sr25519'
    `);
  }
}

export interface AttestationEvidenceAttestorRow {
  id: number;
  pubkey_hex: string;
  label: string | null;
  registered_at: number;
  revoked_at: number | null;
  notes: string | null;
  sig_algo: SigAlgo;
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
  /**
   * Signature algorithm the attestor will use on POST /v2/attestation_evidence.
   * Defaults to "sr25519" so existing call sites and back-compat ALTER TABLE
   * defaults agree. Acurast Android phones MUST pass "ed25519" — the only
   * TEE primitive the Acurast `_STD_.signers` API exposes.
   */
  sig_algo?: SigAlgo;
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
  const sigAlgo: SigAlgo = input.sig_algo ?? "sr25519";
  if (!SIG_ALGO_SET.has(sigAlgo)) {
    throw new TypeError(
      `registerAttestationEvidenceAttestor: sig_algo must be one of [${SIG_ALGOS.join(", ")}], got "${sigAlgo}"`,
    );
  }
  const registeredAt = input.now ?? Math.floor(Date.now() / 1000);

  const info = db
    .prepare(
      `INSERT INTO attestation_evidence_attestors (pubkey_hex, label, registered_at, notes, sig_algo)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(normalized, label, registeredAt, notes, sigAlgo);

  return {
    id: Number(info.lastInsertRowid),
    pubkey_hex: normalized,
    label,
    registered_at: registeredAt,
    revoked_at: null,
    notes,
    sig_algo: sigAlgo,
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
      `SELECT id, pubkey_hex, label, registered_at, revoked_at, notes, sig_algo
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

/**
 * Hot-path lookup used by the v2/attestation_evidence route to decide which
 * signature primitive to verify against. Returns the registered algo when
 * the attestor is active, null when revoked or unregistered. Rows that
 * pre-date the sig_algo migration default to "sr25519" via the ALTER TABLE
 * column default, so this never returns an unrecognised string.
 */
export function getActiveAttestorSigAlgo(pubkey: string): SigAlgo | null {
  if (!db) return null;
  const normalized = normalizePubkey(pubkey);
  const row = db
    .prepare(
      `SELECT sig_algo AS algo FROM attestation_evidence_attestors
       WHERE pubkey_hex = ? AND revoked_at IS NULL`,
    )
    .get(normalized) as { algo: string } | undefined;
  if (!row) return null;
  if (!SIG_ALGO_SET.has(row.algo)) return null;
  return row.algo as SigAlgo;
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
      `SELECT id, pubkey_hex, label, registered_at, revoked_at, notes, sig_algo
       FROM attestation_evidence_attestors
       ${where}
       ORDER BY registered_at DESC, id DESC`,
    )
    .all() as AttestationEvidenceAttestorRow[];
  return rows;
}
