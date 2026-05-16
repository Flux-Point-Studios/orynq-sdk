/**
 * Ephemeral bulletin-board for M-of-N committee signatures over the
 * `pallet-intent-settlement` STCA (settle_claim) + EXPP (expire_policy)
 * canonical digests.
 *
 * Each cert-daemon computes the canonical digest from chain state,
 * signs it with its committee key, POSTs the (pubkey, sig, digest)
 * triple here, GETs the union of peer sigs, and submits ONE M-sig
 * envelope via `attest_settle` / `attest_expire_policy`. The pallet's
 * `ensure_threshold_signatures` requires all sigs in one envelope — no
 * cross-call accumulation — so this gateway-side aggregator closes the
 * autopilot coordination gap (task #286 / settle-sig-aggregation-design.md).
 *
 * Trust model:
 *   - Each row is self-authenticating: gateway verifies sr25519(pubkey,
 *     sig) over the claimed `digest` before storing. Forged rows can't
 *     pass that check.
 *   - Gateway does NOT verify pubkey is a current committee member; the
 *     pallet does that at submit-time. This keeps the gateway chain-
 *     degraded-friendly (cleanup keeps running even if the RPC is down).
 *   - 24h hard TTL via periodic cleanup. On-chain SettlementRequestTtl
 *     is ~4h so this gives ample post-mortem window.
 *
 * Schema is intentionally narrow — one table, composite PK keyed by
 * (kind, key_hex, digest_hex, pubkey_hex). Two daemons publishing the
 * SAME digest for the same key dedupe by pubkey; two daemons publishing
 * DIFFERENT digests (chain-state mismatch) live side-by-side so a GET
 * caller can pick the set matching its local computation.
 */

import Database from "better-sqlite3";
import { join } from "path";
import { config } from "./config.js";

/**
 * The M-of-N flows that share this storage:
 *  - `settle` — STCA attestation sigs over a `settle_claim`-bound digest
 *    (cert-daemon's settle_claim_attestor path, spec-220).
 *  - `expire` — EXPP attestation sigs over an `expire_policy_mirror`-bound
 *    digest (cert-daemon's expire_policy_attestor path, spec-221).
 *  - `slash` — FRAU attestation sigs over a `slash_bad_settlement_evidence`-
 *    bound digest (cert-daemon's slash_watcher path, spec-225 / task #84).
 * Each channel uses byte-distinct domain tags (STCA/EXPP/FRAU) so per-
 * channel sigs cannot replay across channels — the gateway only namespaces
 * the storage; payload-level domain separation is the on-chain pallet's
 * job.
 */
export const MULTISIG_KINDS = ["settle", "expire", "slash"] as const;
export type MultisigKind = (typeof MULTISIG_KINDS)[number];

/** Stored sig entry. All hex fields lowercase, no `0x` prefix. */
export interface MultisigSigRow {
  kind: MultisigKind;
  key_hex: string;        // 64 hex (claim_id for settle/slash, intent_id for expire)
  digest_hex: string;     // 64 hex (the 32 bytes that were signed)
  pubkey_hex: string;     // 64 hex
  sig_hex: string;        // 128 hex
  created_at: number;     // unix seconds
}

let db: Database.Database | null = null;

/** Test hook — inject a handle (typically `:memory:` for unit tests). */
export function setMultisigSigsDbForTests(injected: Database.Database): void {
  db = injected;
}

/** Test/debug helper — returns the current handle or throws if unset. */
export function getMultisigSigsDb(): Database.Database {
  if (!db) {
    throw new Error(
      "multisig_sigs db not initialised — call initMultisigSigsDb() first",
    );
  }
  return db;
}

/**
 * Initialise the `multisig_sigs` table. Idempotent; safe to call repeatedly.
 * If `database` is omitted, opens (or creates) `multisig_sigs.db` at the
 * canonical storage path.
 */
export function initMultisigSigsDb(database?: Database.Database): void {
  const handle =
    database ?? new Database(join(config.storagePath, "multisig_sigs.db"));
  handle.exec(`
    CREATE TABLE IF NOT EXISTS multisig_sigs (
      kind        TEXT NOT NULL,
      key_hex     TEXT NOT NULL,
      digest_hex  TEXT NOT NULL,
      pubkey_hex  TEXT NOT NULL,
      sig_hex     TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (kind, key_hex, digest_hex, pubkey_hex)
    );
    CREATE INDEX IF NOT EXISTS idx_multisig_sigs_created
      ON multisig_sigs(created_at);
  `);
  db = handle;
}

/** Lower + strip a `0x` prefix. Returns `null` if not pure hex of given byte length. */
function normalizeHex(input: unknown, expectedBytes: number): string | null {
  if (typeof input !== "string") return null;
  const raw = input.startsWith("0x") ? input.slice(2) : input;
  if (raw.length !== expectedBytes * 2) return null;
  if (!/^[0-9a-fA-F]+$/.test(raw)) return null;
  return raw.toLowerCase();
}

/** Type guard for the wire-form `kind` parameter. */
export function isMultisigKind(s: string): s is MultisigKind {
  return (MULTISIG_KINDS as readonly string[]).includes(s);
}

/**
 * Idempotent upsert. On conflict (same kind/key/digest/pubkey) replaces
 * the sig but PRESERVES the original `created_at` so the TTL anchor
 * stays put — a daemon re-POSTing won't reset its expiry.
 *
 * All hex inputs MUST already be normalized (lowercased, no `0x`,
 * correct length). The route layer does that before calling this.
 */
export function upsertMultisigSig(
  row: Omit<MultisigSigRow, "created_at">,
): { stored: boolean; created_at: number } {
  const now = Math.floor(Date.now() / 1000);
  const h = getMultisigSigsDb();
  // Two-step so we can preserve created_at on update.
  const existing = h
    .prepare(
      `SELECT created_at FROM multisig_sigs
        WHERE kind = ? AND key_hex = ? AND digest_hex = ? AND pubkey_hex = ?`,
    )
    .get(row.kind, row.key_hex, row.digest_hex, row.pubkey_hex) as
    | { created_at: number }
    | undefined;
  if (existing) {
    h.prepare(
      `UPDATE multisig_sigs SET sig_hex = ?
        WHERE kind = ? AND key_hex = ? AND digest_hex = ? AND pubkey_hex = ?`,
    ).run(
      row.sig_hex,
      row.kind,
      row.key_hex,
      row.digest_hex,
      row.pubkey_hex,
    );
    return { stored: true, created_at: existing.created_at };
  }
  h.prepare(
    `INSERT INTO multisig_sigs
      (kind, key_hex, digest_hex, pubkey_hex, sig_hex, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.kind, row.key_hex, row.digest_hex, row.pubkey_hex, row.sig_hex, now);
  return { stored: true, created_at: now };
}

/**
 * List sigs for a given (kind, key). When `digest_hex` is provided, restricts
 * to rows matching that digest — the daemon use case (only pull peer sigs
 * over the digest we just computed locally).
 */
export function listMultisigSigs(
  kind: MultisigKind,
  key_hex: string,
  digest_hex?: string,
): MultisigSigRow[] {
  const h = getMultisigSigsDb();
  if (digest_hex !== undefined) {
    return h
      .prepare(
        `SELECT kind, key_hex, digest_hex, pubkey_hex, sig_hex, created_at
           FROM multisig_sigs
          WHERE kind = ? AND key_hex = ? AND digest_hex = ?
          ORDER BY pubkey_hex ASC`,
      )
      .all(kind, key_hex, digest_hex) as MultisigSigRow[];
  }
  return h
    .prepare(
      `SELECT kind, key_hex, digest_hex, pubkey_hex, sig_hex, created_at
         FROM multisig_sigs
        WHERE kind = ? AND key_hex = ?
        ORDER BY digest_hex ASC, pubkey_hex ASC`,
    )
    .all(kind, key_hex) as MultisigSigRow[];
}

/**
 * Delete rows older than `maxAgeSeconds` (default 24h). Returns the
 * number of rows removed.
 */
export function cleanupMultisigSigs(maxAgeSeconds = 86400): number {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
  const h = getMultisigSigsDb();
  const res = h
    .prepare(`DELETE FROM multisig_sigs WHERE created_at < ?`)
    .run(cutoff);
  return res.changes;
}

/** Periodic cleanup loop. Returns a stop function (mainly for tests). */
export function startMultisigSigsCleanup(
  intervalMs = 5 * 60 * 1000,
): () => void {
  const tick = (): void => {
    try {
      const removed = cleanupMultisigSigs();
      if (removed > 0) {
        console.log(`[multisig_sigs] cleanup: removed ${removed} expired rows`);
      }
    } catch (err) {
      console.warn(`[multisig_sigs] cleanup error: ${err}`);
    }
  };
  // Run once at start, then on a timer.
  tick();
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}

/** Helper for the route — exported for tests too. */
export function parseAndValidatePayload(
  body: unknown,
): { pubkey_hex: string; sig_hex: string; digest_hex: string } | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "body_must_be_object" };
  }
  const b = body as Record<string, unknown>;
  const pubkey_hex = normalizeHex(b.pubkey, 32);
  const sig_hex = normalizeHex(b.sig, 64);
  const digest_hex = normalizeHex(b.digest, 32);
  if (!pubkey_hex) return { error: "pubkey_must_be_32_byte_hex" };
  if (!sig_hex) return { error: "sig_must_be_64_byte_hex" };
  if (!digest_hex) return { error: "digest_must_be_32_byte_hex" };
  return { pubkey_hex, sig_hex, digest_hex };
}

/** Helper for the route — validates the {kind}/{key} path segments. */
export function parsePathSegments(
  kindRaw: string,
  keyRaw: string,
): { kind: MultisigKind; key_hex: string } | { error: string } {
  if (!isMultisigKind(kindRaw)) {
    return { error: "kind_must_be_settle_or_expire" };
  }
  const key_hex = normalizeHex(keyRaw, 32);
  if (!key_hex) return { error: "key_must_be_32_byte_hex" };
  return { kind: kindRaw, key_hex };
}
