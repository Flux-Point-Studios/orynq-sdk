/**
 * SQLite-backed store of attestation_evidence ENTRIES per receipt.
 *
 * Each row is one evidence entry submitted by an attestor for a specific
 * `receipt_id` (computed from the v2 record's `content_hash` per
 * `storage.computeReceiptId`). The schema mirrors the wire shape of one
 * entry plus bookkeeping fields:
 *
 *   - receipt_id (hex, no 0x prefix)         — keys the evidence vector
 *   - evidence_type (text)                    — discriminator (per Wave 3 spec)
 *   - nonce_hex (hex)                          — content_hash binding nonce
 *   - payload_json (TEXT)                      — opaque per-evidence-type body
 *   - attestor_pubkey_hex (hex)                — who submitted this evidence
 *   - signature_hex (hex)                      — sig over canonical(payload)
 *   - submitted_at_ms                          — wall-clock at gateway
 *
 * UNIQUE constraint on `(receipt_id, attestor_pubkey_hex, evidence_type)`
 * enforces the route's idempotency rule: re-POSTing the same body returns
 * status:replay without storing twice. (Per the spec: same `receipt_id +
 * attestor_pubkey + evidence_type` triple → replay.)
 *
 * The evidence vector for a receipt is reconstructed on demand by
 * `getEvidenceVecForReceipt`, sorted by EvidenceType discriminant, and fed
 * through `attestationEvidenceHash` to compute the receipt's
 * `attestation_evidence_hash`.
 *
 * On-chain coupling: this PR does NOT modify the on-chain receipt. A
 * separate cert-daemon PR will eventually carry this hash up to a
 * pallet-tee-attestation extrinsic. The hash IS computed and returned to
 * the caller of POST /v2/attestation_evidence so off-chain consumers can
 * already use it (e.g. flux1 explorer, billing aggregations).
 */

import Database from "better-sqlite3";
import { join } from "path";
import { config } from "./config.js";
import {
  attestationEvidenceHash,
  EVIDENCE_TYPE_DISCRIMINANT,
  type AttestationEvidenceEntry,
  type EvidenceType,
} from "./schemas/compute_metering_v2.js";

let db: Database.Database | null = null;

export function setReceiptAttestationEvidenceDbForTests(
  injected: Database.Database,
): void {
  db = injected;
}

export function getReceiptAttestationEvidenceDb(): Database.Database {
  if (!db) {
    throw new Error(
      "receipt_attestation_evidence db not initialised — call init...() first",
    );
  }
  return db;
}

export function initReceiptAttestationEvidenceDb(
  database?: Database.Database,
): Database.Database {
  const handle =
    database ??
    new Database(join(config.storagePath, "receipt_attestation_evidence.db"));
  handle.pragma("journal_mode = WAL");
  handle.pragma("busy_timeout = 5000");
  handle.exec(`
    CREATE TABLE IF NOT EXISTS receipt_attestation_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id TEXT NOT NULL,
      evidence_type TEXT NOT NULL,
      nonce_hex TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attestor_pubkey_hex TEXT NOT NULL,
      signature_hex TEXT NOT NULL,
      submitted_at_ms INTEGER NOT NULL,
      UNIQUE (receipt_id, attestor_pubkey_hex, evidence_type)
    );
    CREATE INDEX IF NOT EXISTS idx_rae_receipt
      ON receipt_attestation_evidence(receipt_id);
    CREATE INDEX IF NOT EXISTS idx_rae_attestor
      ON receipt_attestation_evidence(attestor_pubkey_hex);
  `);
  // Additive migration (task #143): track which rows the cert-daemon has
  // already lifted to chain via TeeAttestation.submit_evidence. Two new
  // columns, both nullable + default-NULL so existing rows + the original
  // `INSERT` paths continue to work unchanged. The cert-daemon polls
  // `submitted_to_chain_at IS NULL` rows and records the extrinsic hash
  // here once the on-chain dispatch succeeds.
  migrateChainSubmissionColumns(handle);
  if (!db) db = handle;
  return handle;
}

/**
 * Add `submitted_to_chain_at` (INTEGER, NULL = pending) and
 * `chain_extrinsic_hash` (TEXT, NULL = pending). Idempotent — safe to call
 * on every startup. Mirrors the migrate*Columns pattern already used in
 * `quota.ts`.
 */
function migrateChainSubmissionColumns(handle: Database.Database): void {
  const cols = handle
    .prepare(`PRAGMA table_info(receipt_attestation_evidence)`)
    .all() as Array<{ name: string }>;
  const colSet = new Set(cols.map((c) => c.name));
  if (!colSet.has("submitted_to_chain_at")) {
    handle.exec(
      `ALTER TABLE receipt_attestation_evidence ADD COLUMN submitted_to_chain_at INTEGER`,
    );
  }
  if (!colSet.has("chain_extrinsic_hash")) {
    handle.exec(
      `ALTER TABLE receipt_attestation_evidence ADD COLUMN chain_extrinsic_hash TEXT`,
    );
  }
  // Partial index on the daemon's hot read path: newest-first scan of rows
  // with NULL submitted_to_chain_at. Speeds up the per-poll
  // `listReceiptEvidencePendingChainSubmission` query for big DBs.
  handle.exec(
    `CREATE INDEX IF NOT EXISTS idx_rae_pending_chain
       ON receipt_attestation_evidence(id)
     WHERE submitted_to_chain_at IS NULL`,
  );
}

export interface ReceiptEvidenceRow {
  id: number;
  receipt_id: string;
  evidence_type: EvidenceType;
  nonce_hex: string;
  payload_json: string;
  attestor_pubkey_hex: string;
  signature_hex: string;
  submitted_at_ms: number;
  /** Wall-clock ms when cert-daemon successfully submitted to chain.
   *  NULL = not yet submitted. (Task #143 chain-submission tracking.) */
  submitted_to_chain_at?: number | null;
  /** Materios extrinsic hash from the successful TeeAttestation.submit_evidence
   *  dispatch. NULL when `submitted_to_chain_at IS NULL`. */
  chain_extrinsic_hash?: string | null;
}

function normalizeReceiptId(input: string): string {
  return (input.startsWith("0x") || input.startsWith("0X")
    ? input.slice(2)
    : input
  ).toLowerCase();
}

function normalizeHex(input: string): string {
  return (input.startsWith("0x") || input.startsWith("0X")
    ? input.slice(2)
    : input
  ).toLowerCase();
}

export interface InsertReceiptEvidenceInput {
  receipt_id: string;
  evidence_type: EvidenceType;
  nonce_hex: string;
  payload: Record<string, unknown>;
  attestor_pubkey_hex: string;
  signature_hex: string;
  submitted_at_ms?: number;
}

/** Outcome of `insertReceiptEvidence`. */
export type InsertReceiptEvidenceOutcome =
  | { status: "inserted"; row: ReceiptEvidenceRow }
  | { status: "replay"; row: ReceiptEvidenceRow };

/**
 * Insert one evidence entry. If the (receipt_id, attestor_pubkey, evidence_type)
 * triple already exists, returns `status:replay` and the existing row. Caller
 * decides whether to surface as 200 or 409.
 */
export function insertReceiptEvidence(
  input: InsertReceiptEvidenceInput,
): InsertReceiptEvidenceOutcome {
  if (!db) throw new Error("receipt_attestation_evidence db not initialised");
  const receipt_id = normalizeReceiptId(input.receipt_id);
  const attestor_pubkey_hex = normalizeHex(input.attestor_pubkey_hex);
  const nonce_hex = normalizeHex(input.nonce_hex);
  const signature_hex = normalizeHex(input.signature_hex);
  const submitted_at_ms = input.submitted_at_ms ?? Date.now();
  const payload_json = JSON.stringify(input.payload);

  // Pre-check for replay so we can surface the existing row to the caller.
  const existing = db
    .prepare(
      `SELECT id, receipt_id, evidence_type, nonce_hex, payload_json,
              attestor_pubkey_hex, signature_hex, submitted_at_ms
         FROM receipt_attestation_evidence
        WHERE receipt_id = ? AND attestor_pubkey_hex = ? AND evidence_type = ?`,
    )
    .get(receipt_id, attestor_pubkey_hex, input.evidence_type) as
    | ReceiptEvidenceRow
    | undefined;
  if (existing) {
    return { status: "replay", row: existing };
  }

  const info = db
    .prepare(
      `INSERT INTO receipt_attestation_evidence
         (receipt_id, evidence_type, nonce_hex, payload_json,
          attestor_pubkey_hex, signature_hex, submitted_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      receipt_id,
      input.evidence_type,
      nonce_hex,
      payload_json,
      attestor_pubkey_hex,
      signature_hex,
      submitted_at_ms,
    );
  return {
    status: "inserted",
    row: {
      id: Number(info.lastInsertRowid),
      receipt_id,
      evidence_type: input.evidence_type,
      nonce_hex,
      payload_json,
      attestor_pubkey_hex,
      signature_hex,
      submitted_at_ms,
    },
  };
}

/**
 * Read all evidence rows for a receipt, sorted by
 *   (1) EvidenceType discriminant ASC (the canonical primary order), and
 *   (2) attestor_pubkey_hex ASC byte-lex (the deterministic tiebreaker for
 *       same-discriminant entries).
 *
 * Sort happens in JS (not solely in SQL) because the discriminant ordering is
 * pinned in `EVIDENCE_TYPE_DISCRIMINANT` rather than the alphabetical order
 * SQL would give. The pinned-discriminant rule + lower-pubkey tiebreak
 * together guarantee the evidence vector hash matches across TS encoders +
 * the Python encoder + the pallet-side Rust decoder, AND across replicas
 * regardless of physical row order (rowid drifts after vacuum / restore).
 *
 * The SQL `ORDER BY ... attestor_pubkey_hex ASC` is added so any consumer
 * that bypasses this JS sort (or runs SQL directly for inspection) still
 * sees the deterministic order. PR #34 M-2.
 */
export function listReceiptEvidence(receipt_id: string): ReceiptEvidenceRow[] {
  if (!db) return [];
  const id = normalizeReceiptId(receipt_id);
  const rows = db
    .prepare(
      `SELECT id, receipt_id, evidence_type, nonce_hex, payload_json,
              attestor_pubkey_hex, signature_hex, submitted_at_ms
         FROM receipt_attestation_evidence
        WHERE receipt_id = ?
        ORDER BY evidence_type ASC, attestor_pubkey_hex ASC`,
    )
    .all(id) as ReceiptEvidenceRow[];
  // JS-side primary sort by discriminant (SQL ORDER BY evidence_type sorts
  // alphabetically, which is NOT the canonical order — e.g. amd_sev_snp(0)
  // alphabetises BEFORE arm_trustzone(2) by accident, but intel_tdx(1)
  // alphabetises AFTER arm_trustzone(2)). Then byte-lex tiebreak on
  // attestor_pubkey_hex (already lowercase from insert). Direct `< / >`
  // comparison on lowercase hex strings is locale-independent.
  rows.sort((a, b) => {
    const d =
      EVIDENCE_TYPE_DISCRIMINANT[a.evidence_type] -
      EVIDENCE_TYPE_DISCRIMINANT[b.evidence_type];
    if (d !== 0) return d;
    if (a.attestor_pubkey_hex < b.attestor_pubkey_hex) return -1;
    if (a.attestor_pubkey_hex > b.attestor_pubkey_hex) return 1;
    return 0;
  });
  return rows;
}

/**
 * Reconstruct the canonical evidence vector for a receipt and hash it.
 *
 * Returned tuple:
 *   - hash: SHA-256 hex of canonical-CBOR(evidence_array)
 *   - count: number of stored entries
 *   - types: list of evidence_type strings, in discriminant-ascending order
 *
 * Empty vec returns the canonical empty-vec hash
 * (`76be8b528d0075f7aae98d6fa57a6d3c83ae480a8469e668d7b0af968995ac71`)
 * — NOT zeros.
 */
export function recomputeReceiptEvidenceHash(receipt_id: string): {
  hash: string;
  count: number;
  types: EvidenceType[];
} {
  const rows = listReceiptEvidence(receipt_id);
  const entries: AttestationEvidenceEntry[] = rows.map((r) => ({
    evidence_type: r.evidence_type,
    nonce: r.nonce_hex,
    payload: JSON.parse(r.payload_json) as Record<string, unknown>,
  }));
  const hash = attestationEvidenceHash(entries);
  return { hash, count: rows.length, types: rows.map((r) => r.evidence_type) };
}

// ---------------------------------------------------------------------------
// Chain-submission tracking helpers (task #143)
//
// The cert-daemon's `evidence_submitter` polls `listReceiptEvidencePending
// ChainSubmission()` over HTTP, dispatches `TeeAttestation.submit_evidence`
// for each row, and acks via `markReceiptEvidenceSubmittedToChain()`. The
// helpers live here so the SQL stays close to the schema migration.
// ---------------------------------------------------------------------------

export interface PendingChainSubmissionFilter {
  /** rowid floor — caller's last-seen cursor. Returns rows with id > since. */
  since?: number;
  /** Hard cap on rows returned per call. Default 100, max 1000. */
  limit?: number;
}

/**
 * Read evidence rows that the cert-daemon has NOT yet submitted to chain.
 * Sorted by `id ASC` so the daemon's cursor advances monotonically.
 *
 * The route exposes this as `GET /v2/attestation_evidence/pending` (auth via
 * EVIDENCE_SUBMITTER_TOKEN with day-one fallback to
 * SPONSORED_RECEIPT_SUBMITTER_TOKEN — see routes/attestation_evidence_submission.ts).
 * Rows already marked (`submitted_to_chain_at IS NOT NULL`) are excluded.
 */
export function listReceiptEvidencePendingChainSubmission(
  filter: PendingChainSubmissionFilter = {},
): ReceiptEvidenceRow[] {
  if (!db) return [];
  const since = Math.max(0, Math.floor(filter.since ?? 0));
  const limitRaw = filter.limit ?? 100;
  const limit = Math.max(1, Math.min(1000, Math.floor(limitRaw)));
  const rows = db
    .prepare(
      `SELECT id, receipt_id, evidence_type, nonce_hex, payload_json,
              attestor_pubkey_hex, signature_hex, submitted_at_ms,
              submitted_to_chain_at, chain_extrinsic_hash
         FROM receipt_attestation_evidence
        WHERE id > ? AND submitted_to_chain_at IS NULL
        ORDER BY id ASC
        LIMIT ?`,
    )
    .all(since, limit) as ReceiptEvidenceRow[];
  return rows;
}

/**
 * Mark a row as successfully submitted to chain. Idempotent — re-marking is
 * a no-op (the daemon ALREADY-SUBMITTED branch returns 200 with the existing
 * timestamp + extrinsic hash so retries on a flaky network don't 500).
 *
 * Returns `{ status: "marked", row }` on first ack, or
 * `{ status: "already-marked", row }` on retry. Returns `null` if the row id
 * doesn't exist.
 */
export type MarkSubmittedOutcome =
  | { status: "marked"; row: ReceiptEvidenceRow }
  | { status: "already-marked"; row: ReceiptEvidenceRow };

export function markReceiptEvidenceSubmittedToChain(input: {
  row_id: number;
  chain_extrinsic_hash: string;
  submitted_at_ms?: number;
}): MarkSubmittedOutcome | null {
  if (!db) return null;
  const submittedAt = input.submitted_at_ms ?? Date.now();
  const txHash = normalizeHex(input.chain_extrinsic_hash);

  const existing = db
    .prepare(
      `SELECT id, receipt_id, evidence_type, nonce_hex, payload_json,
              attestor_pubkey_hex, signature_hex, submitted_at_ms,
              submitted_to_chain_at, chain_extrinsic_hash
         FROM receipt_attestation_evidence
        WHERE id = ?`,
    )
    .get(input.row_id) as ReceiptEvidenceRow | undefined;
  if (!existing) return null;

  if (existing.submitted_to_chain_at != null) {
    return { status: "already-marked", row: existing };
  }

  db.prepare(
    `UPDATE receipt_attestation_evidence
        SET submitted_to_chain_at = ?, chain_extrinsic_hash = ?
      WHERE id = ? AND submitted_to_chain_at IS NULL`,
  ).run(submittedAt, txHash, input.row_id);

  const updated = db
    .prepare(
      `SELECT id, receipt_id, evidence_type, nonce_hex, payload_json,
              attestor_pubkey_hex, signature_hex, submitted_at_ms,
              submitted_to_chain_at, chain_extrinsic_hash
         FROM receipt_attestation_evidence
        WHERE id = ?`,
    )
    .get(input.row_id) as ReceiptEvidenceRow;
  return { status: "marked", row: updated };
}
