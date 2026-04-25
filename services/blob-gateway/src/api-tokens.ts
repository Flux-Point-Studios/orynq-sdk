/**
 * Opaque Bearer tokens for blob-gateway authentication.
 *
 * Replaces the legacy "SS58-as-API-key" pattern in which operators sent
 * their on-chain address (public info) as the secret. Tokens here are
 * cryptographically random, prefixed with `matra_`, displayed ONCE at mint,
 * and stored only as sha256(token_hash) in the `api_tokens` table.
 *
 * Storage lives in the same SQLite file as operators.db — these tokens
 * are identity-scoped (one token authorizes as one SS58 account), and the
 * registration pipeline already writes to operators.db.
 */

import Database from "better-sqlite3";
import { createHash, randomBytes } from "crypto";
import { join } from "path";
import { config } from "./config.js";

export const TOKEN_PREFIX = "matra_";
/** Random bytes per token before base62-encoding. 32 = 256 bits of entropy. */
export const TOKEN_RANDOM_BYTES = 32;

/** Shared DB handle, set by initApiTokensDb() at boot (or by tests). */
let db: Database.Database | null = null;

export function setApiTokensDb(database: Database.Database): void {
  db = database;
}

export function getApiTokensDb(): Database.Database {
  if (!db) throw new Error("api-tokens db not initialised — call initApiTokensDb() first");
  return db;
}

/**
 * Initialise the api_tokens table on the supplied SQLite handle.
 * Safe to call repeatedly (CREATE IF NOT EXISTS).
 *
 * When called with no arg, opens (or creates) operators.db at the canonical
 * path and stores the handle as the module default. Tests pass an in-memory
 * handle instead.
 */
export function initApiTokensDb(database?: Database.Database): Database.Database {
  const handle = database ?? new Database(join(config.storagePath, "operators.db"));
  handle.pragma("journal_mode = WAL");
  handle.pragma("busy_timeout = 5000");
  handle.exec(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      token_hash TEXT PRIMARY KEY,
      account_ss58 TEXT NOT NULL,
      label TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER,
      revoked_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_tokens_account ON api_tokens(account_ss58);
  `);
  if (!db) db = handle;
  return handle;
}

/**
 * sha256-hex of a plaintext token. Stable, one-way, never reversed.
 */
export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Encode a Buffer as base62. 32 random bytes → 43 chars
 * (ceil(log62(2^256)) = 43). Keeps tokens ASCII-safe for any transport.
 */
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function toBase62(buf: Uint8Array): string {
  // Treat the input as a big-endian bignum. For 32 bytes this is a BigInt of
  // up to 256 bits; base62 encoding is log_62(2^256) ≈ 42.99 → always 43 chars
  // after left-padding.
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let out = "";
  if (n === 0n) out = "0";
  while (n > 0n) {
    const rem = Number(n % 62n);
    out = BASE62_ALPHABET[rem] + out;
    n = n / 62n;
  }
  return out.padStart(43, "0");
}

export interface IssueTokenInput {
  accountSs58: string;
  label?: string | undefined;
  /** Unix seconds override; used by tests for determinism. */
  now?: number;
}

export interface IssuedToken {
  /** Plaintext token — SHOWN ONCE, never persisted. */
  token: string;
  /** sha256(token) — what's actually in the DB. */
  tokenHash: string;
  accountSs58: string;
  label: string | null;
  createdAt: number;
}

/**
 * Generate a new random token and insert the hashed row.
 * Returns the plaintext token to the caller — caller MUST forward it to
 * the operator immediately; we will never be able to reconstruct it.
 */
export function issueToken(
  database: Database.Database,
  input: IssueTokenInput,
): IssuedToken {
  const raw = randomBytes(TOKEN_RANDOM_BYTES);
  const token = `${TOKEN_PREFIX}${toBase62(raw)}`;
  const tokenHash = hashToken(token);
  const label = input.label ?? null;
  const createdAt = input.now ?? Math.floor(Date.now() / 1000);

  database
    .prepare(
      `INSERT INTO api_tokens (token_hash, account_ss58, label, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(tokenHash, input.accountSs58, label, createdAt);

  return { token, tokenHash, accountSs58: input.accountSs58, label, createdAt };
}

export interface VerifyTokenOptions {
  /** Unix seconds override; used by tests. */
  now?: number;
}

export type VerifyResult =
  | { valid: true; accountSs58: string; label: string | null; tokenHash: string }
  | { valid: false; reason: "malformed" | "unknown" | "revoked" };

/**
 * Verify a plaintext Bearer token against the DB.
 * On success, bumps last_used_at atomically.
 */
export function verifyToken(
  database: Database.Database,
  plaintext: string,
  opts: VerifyTokenOptions = {},
): VerifyResult {
  if (typeof plaintext !== "string" || !plaintext.startsWith(TOKEN_PREFIX)) {
    return { valid: false, reason: "malformed" };
  }
  const tokenHash = hashToken(plaintext);
  const row = database
    .prepare(
      `SELECT account_ss58, label, revoked_at FROM api_tokens WHERE token_hash = ?`,
    )
    .get(tokenHash) as
    | { account_ss58: string; label: string | null; revoked_at: number | null }
    | undefined;

  if (!row) return { valid: false, reason: "unknown" };
  if (row.revoked_at !== null) return { valid: false, reason: "revoked" };

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  database
    .prepare(`UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?`)
    .run(now, tokenHash);

  return { valid: true, accountSs58: row.account_ss58, label: row.label, tokenHash };
}

export interface UpdateLabelInput {
  tokenHash: string;
  /** New label, or null to clear. Trimmed and capped at 128 chars by the caller. */
  label: string | null;
}

export interface UpdateLabelResult {
  /** true iff the row existed AND was active (non-revoked). */
  updated: boolean;
  /** The label as stored after the update — equals input.label on success. */
  label: string | null;
  /** SS58 of the token's owner; used by routes for audit logging + responses. */
  accountSs58: string | null;
}

/**
 * Rename an existing active token. Self-service path: caller authenticates
 * via Bearer, route resolves their own token_hash, then calls this. Admin
 * path: caller passes any token_hash via URL.
 *
 * Idempotent — calling twice with the same label is a successful no-op.
 * Refuses to update revoked tokens (returns updated=false).
 */
export function updateTokenLabel(
  database: Database.Database,
  input: UpdateLabelInput,
): UpdateLabelResult {
  const row = database
    .prepare(
      `SELECT account_ss58, revoked_at FROM api_tokens WHERE token_hash = ?`,
    )
    .get(input.tokenHash) as
    | { account_ss58: string; revoked_at: number | null }
    | undefined;
  if (!row) return { updated: false, label: null, accountSs58: null };
  if (row.revoked_at !== null)
    return { updated: false, label: null, accountSs58: row.account_ss58 };
  database
    .prepare(`UPDATE api_tokens SET label = ? WHERE token_hash = ?`)
    .run(input.label, input.tokenHash);
  return { updated: true, label: input.label, accountSs58: row.account_ss58 };
}

export interface RevokeTokenInput {
  tokenHash: string;
  reason?: string | undefined;
  /** Unix seconds override; used by tests. */
  now?: number;
}

export interface RevokeResult {
  /** true iff this call flipped an active token to revoked. */
  revoked: boolean;
}

/**
 * Mark a token as revoked. Idempotent: no-op if already revoked or unknown.
 */
export function revokeToken(
  database: Database.Database,
  input: RevokeTokenInput,
): RevokeResult {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const info = database
    .prepare(
      `UPDATE api_tokens SET revoked_at = ?, revoked_reason = ?
       WHERE token_hash = ? AND revoked_at IS NULL`,
    )
    .run(now, input.reason ?? null, input.tokenHash);
  return { revoked: info.changes > 0 };
}

export interface ListedToken {
  tokenHash: string;
  accountSs58: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  revokedReason: string | null;
}

/**
 * List tokens (hashes + metadata only). Filter by account or include revoked.
 */
export function listTokens(
  database: Database.Database,
  opts: { account?: string; includeRevoked?: boolean } = {},
): ListedToken[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.account) {
    where.push("account_ss58 = ?");
    params.push(opts.account);
  }
  if (!opts.includeRevoked) {
    where.push("revoked_at IS NULL");
  }
  const sql = `
    SELECT token_hash, account_ss58, label, created_at, last_used_at, revoked_at, revoked_reason
    FROM api_tokens
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY created_at DESC
  `;
  const rows = database.prepare(sql).all(...params) as Array<{
    token_hash: string;
    account_ss58: string;
    label: string | null;
    created_at: number;
    last_used_at: number | null;
    revoked_at: number | null;
    revoked_reason: string | null;
  }>;
  return rows.map((r) => ({
    tokenHash: r.token_hash,
    accountSs58: r.account_ss58,
    label: r.label,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
    revokedReason: r.revoked_reason,
  }));
}
