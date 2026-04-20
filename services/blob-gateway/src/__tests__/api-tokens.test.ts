/**
 * Unit tests for api-tokens.ts (Bearer-token auth for blob-gateway).
 *
 * Uses an in-memory SQLite database so tests are isolated and run without
 * touching any real /data/blobs/*.db file.
 */

import { describe, test, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "crypto";
import {
  initApiTokensDb,
  issueToken,
  verifyToken,
  revokeToken,
  listTokens,
  hashToken,
  TOKEN_PREFIX,
} from "../api-tokens.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  initApiTokensDb(db);
  return db;
}

describe("api-tokens: token generation", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  test("token_generation_returns_prefixed_base62_of_correct_length", () => {
    const { token } = issueToken(db, {
      accountSs58: "5EXAMPLE1111111111111111111111111111111111111",
      label: "unit-test",
    });
    // Format: matra_<base62 43 chars> — total ≈ 49 chars
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(token.length).toBe(TOKEN_PREFIX.length + 43);
    expect(token.slice(TOKEN_PREFIX.length)).toMatch(/^[0-9A-Za-z]+$/);
  });

  test("token_stored_as_sha256_hash_not_raw", () => {
    const { token } = issueToken(db, {
      accountSs58: "5EXAMPLE1111111111111111111111111111111111111",
      label: "unit-test-hash",
    });
    // The raw token must NOT be anywhere in the DB.
    const rows = db.prepare("SELECT * FROM api_tokens").all() as Array<{
      token_hash: string;
    }>;
    expect(rows.length).toBe(1);
    const expectedHash = createHash("sha256").update(token).digest("hex");
    expect(rows[0]!.token_hash).toBe(expectedHash);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(token);
  });

  test("issuing_two_tokens_for_same_account_produces_distinct_tokens", () => {
    const a = issueToken(db, {
      accountSs58: "5EXAMPLE1111111111111111111111111111111111111",
      label: "one",
    });
    const b = issueToken(db, {
      accountSs58: "5EXAMPLE1111111111111111111111111111111111111",
      label: "two",
    });
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});

describe("api-tokens: verifyToken", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  test("bearer_token_auth_success_sets_account_from_db", () => {
    const { token } = issueToken(db, {
      accountSs58: "5OperatorAddress123456789012345678901234567",
      label: "happy-path",
    });
    const result = verifyToken(db, token);
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("unreachable");
    expect(result.accountSs58).toBe("5OperatorAddress123456789012345678901234567");
    expect(result.label).toBe("happy-path");
  });

  test("bearer_token_auth_fails_on_unknown_hash", () => {
    const bogus = `${TOKEN_PREFIX}zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz`;
    const result = verifyToken(db, bogus);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.reason).toBe("unknown");
  });

  test("bearer_token_auth_fails_on_revoked_token", () => {
    const { token, tokenHash } = issueToken(db, {
      accountSs58: "5Revoked1111111111111111111111111111111111111",
      label: "to-be-revoked",
    });
    const ok = verifyToken(db, token);
    expect(ok.valid).toBe(true);

    revokeToken(db, { tokenHash, reason: "test-revoke" });

    const after = verifyToken(db, token);
    expect(after.valid).toBe(false);
    if (after.valid) throw new Error("unreachable");
    expect(after.reason).toBe("revoked");
  });

  test("bearer_token_auth_updates_last_used_at", async () => {
    const { token, tokenHash } = issueToken(db, {
      accountSs58: "5UsageTracking1111111111111111111111111111111",
      label: "usage",
    });

    // Freshly issued: last_used_at is NULL
    const before = db
      .prepare("SELECT last_used_at FROM api_tokens WHERE token_hash = ?")
      .get(tokenHash) as { last_used_at: number | null };
    expect(before.last_used_at).toBeNull();

    const fixedNow = 1_700_000_000;
    const result = verifyToken(db, token, { now: fixedNow });
    expect(result.valid).toBe(true);

    const after = db
      .prepare("SELECT last_used_at FROM api_tokens WHERE token_hash = ?")
      .get(tokenHash) as { last_used_at: number | null };
    expect(after.last_used_at).toBe(fixedNow);
  });

  test("verifyToken_rejects_token_without_prefix", () => {
    const result = verifyToken(db, "not-a-matra-token");
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.reason).toBe("malformed");
  });
});

describe("api-tokens: revoke + list", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  test("admin_revoke_marks_token_inactive", () => {
    const { tokenHash } = issueToken(db, {
      accountSs58: "5Revoke222222222222222222222222222222222222222",
      label: "admin-revoke",
    });
    const res = revokeToken(db, { tokenHash, reason: "lost-laptop" });
    expect(res.revoked).toBe(true);

    const row = db
      .prepare(
        "SELECT revoked_at, revoked_reason FROM api_tokens WHERE token_hash = ?",
      )
      .get(tokenHash) as { revoked_at: number | null; revoked_reason: string | null };
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_reason).toBe("lost-laptop");
  });

  test("revokeToken_returns_false_for_unknown_hash", () => {
    const res = revokeToken(db, { tokenHash: "deadbeef", reason: "nope" });
    expect(res.revoked).toBe(false);
  });

  test("revoking_twice_is_idempotent_and_preserves_first_reason", () => {
    const { tokenHash } = issueToken(db, {
      accountSs58: "5Idempotent11111111111111111111111111111111111",
      label: "double-revoke",
    });
    revokeToken(db, { tokenHash, reason: "first" });
    const res2 = revokeToken(db, { tokenHash, reason: "second" });
    // second revoke is a no-op (token already revoked)
    expect(res2.revoked).toBe(false);

    const row = db
      .prepare("SELECT revoked_reason FROM api_tokens WHERE token_hash = ?")
      .get(tokenHash) as { revoked_reason: string };
    expect(row.revoked_reason).toBe("first");
  });

  test("listTokens_returns_hashes_and_metadata_never_the_raw", () => {
    const a = issueToken(db, {
      accountSs58: "5ListOneaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      label: "a",
    });
    const b = issueToken(db, {
      accountSs58: "5ListTwobbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      label: "b",
    });

    const list = listTokens(db);
    expect(list.length).toBe(2);
    for (const row of list) {
      expect(row).toHaveProperty("tokenHash");
      expect(row).toHaveProperty("accountSs58");
      expect(row).toHaveProperty("label");
      expect(row).toHaveProperty("createdAt");
      // The listing MUST NEVER include raw tokens
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain(a.token);
      expect(serialized).not.toContain(b.token);
    }
  });

  test("hashToken_matches_issueToken_storage", () => {
    const { token, tokenHash } = issueToken(db, {
      accountSs58: "5HashMatch11111111111111111111111111111111111",
      label: "hash-match",
    });
    expect(hashToken(token)).toBe(tokenHash);
  });
});
