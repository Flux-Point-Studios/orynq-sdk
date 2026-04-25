/**
 * Integration tests for the unified Bearer / x-api-key / SS58-as-API-key auth path.
 *
 * Builds a minimal Express app around resolveKey() + the Bearer middleware,
 * with an in-memory SQLite DB, so we can exercise header parsing and
 * deprecated-SS58 warn-logging end-to-end.
 */

import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import express from "express";
import Database from "better-sqlite3";
import { createHash, randomBytes } from "crypto";
import { initApiTokensDb, issueToken, setApiTokensDb, TOKEN_PREFIX } from "../api-tokens.js";
import { setQuotaDbForTests, resolveKey } from "../quota.js";
import { mintAdminTokenForTests, registerTokenRoutes, setOperatorsDbForTests } from "../routes/tokens.js";
import { bearerAuth } from "../bearer-auth.js";

type MountedApp = {
  app: express.Express;
  ss58: string;
  /** Raw API key derived directly from an SS58 (legacy behaviour). */
  legacyApiKey: string;
  /** Plaintext Bearer token for the same SS58. */
  bearerToken: string;
  adminToken: string;
  tokensDb: Database.Database;
  quotaDb: Database.Database;
  operatorsDb: Database.Database;
};

function setupApp(): MountedApp {
  // Unique per-test DBs
  const quotaDb = new Database(":memory:");
  quotaDb.pragma("journal_mode = WAL");
  quotaDb.exec(`
    CREATE TABLE api_keys (
      key_hash TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      max_receipts_per_day INTEGER NOT NULL DEFAULT 100,
      max_bytes_per_day INTEGER NOT NULL DEFAULT 1073741824,
      max_concurrent_uploads INTEGER NOT NULL DEFAULT 5,
      validator_id TEXT DEFAULT NULL
    );
  `);
  setQuotaDbForTests(quotaDb);

  const tokensDb = new Database(":memory:");
  tokensDb.pragma("journal_mode = WAL");
  initApiTokensDb(tokensDb);
  setApiTokensDb(tokensDb);

  const operatorsDb = new Database(":memory:");
  operatorsDb.pragma("journal_mode = WAL");
  operatorsDb.exec(`
    CREATE TABLE registrations (
      ss58_address TEXT PRIMARY KEY,
      public_key TEXT,
      label TEXT NOT NULL,
      api_key_hash TEXT NOT NULL,
      invite_token_hash TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      approved_at TEXT,
      status TEXT NOT NULL DEFAULT 'registered',
      session_keys TEXT,
      peer_id TEXT
    );
  `);
  setOperatorsDbForTests(operatorsDb);

  // Create a known operator with a known API key derived from SS58
  // (legacy path: `x-api-key: <ss58>` works). SS58 shape: ^[15][a-zA-Z0-9]{45,47}$
  const ss58 = "5OperatorTestaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";
  const legacyKeyHash = createHash("sha256").update(ss58).digest("hex");
  quotaDb
    .prepare(
      `INSERT INTO api_keys (key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads, validator_id)
       VALUES (?, ?, 1, 100, 1073741824, 5, ?)`,
    )
    .run(legacyKeyHash, "operator-legacy", ss58);

  // Mint a Bearer token for the same account.
  const { token: bearerToken } = issueToken(tokensDb, {
    accountSs58: ss58,
    label: "bearer-token",
  });

  const adminToken = `admin-${randomBytes(16).toString("hex")}`;

  const app = express();
  app.use(express.json());

  // Protected probe: mirrors the pattern upload routes will use.
  app.post("/echo", bearerAuth({ required: true }), (req, res) => {
    res.json({
      account: (req as unknown as { account?: string }).account ?? null,
      tier: (req as unknown as { authTier?: string }).authTier ?? null,
    });
  });

  registerTokenRoutes(app, { adminToken });

  return {
    app,
    ss58,
    legacyApiKey: ss58,
    bearerToken,
    adminToken,
    tokensDb,
    quotaDb,
    operatorsDb,
  };
}

async function fetchJson(
  app: express.Express,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  return await new Promise((resolve, reject) => {
    const port = 0; // ephemeral
    const server = app.listen(port, () => {
      const addr = server.address();
      if (typeof addr === "string" || addr === null) {
        reject(new Error("no address"));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      const init: RequestInit = {
        method,
        headers: { "content-type": "application/json", ...(opts.headers || {}) },
      };
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
      fetch(url, init)
        .then(async (res) => {
          const text = await res.text();
          let body: unknown;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = text;
          }
          server.close();
          resolve({ status: res.status, body });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

describe("bearer auth middleware", () => {
  let ctx: MountedApp;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let warnSpy: any;
  beforeEach(() => {
    ctx = setupApp();
    warnSpy = vi.spyOn(console, "warn").mockImplementation((() => {}) as (...args: unknown[]) => void);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  test("bearer_token_auth_success_sets_account_from_db", async () => {
    const res = await fetchJson(ctx.app, "POST", "/echo", {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
      body: {},
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ account: ctx.ss58, tier: "bearer" });
  });

  test("bearer_token_auth_fails_on_unknown_hash", async () => {
    const bogus = `${TOKEN_PREFIX}aAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa`;
    const res = await fetchJson(ctx.app, "POST", "/echo", {
      headers: { authorization: `Bearer ${bogus}` },
      body: {},
    });
    expect(res.status).toBe(401);
  });

  test("bearer_token_auth_fails_on_revoked_token", async () => {
    // Revoke via the admin route
    const list = await fetchJson(ctx.app, "GET", "/auth/tokens", {
      headers: { "x-admin-token": ctx.adminToken },
    });
    expect(list.status).toBe(200);
    const tokens = (list.body as { tokens: Array<{ tokenHash: string }> }).tokens;
    const th = tokens[0]!.tokenHash;

    const rev = await fetchJson(ctx.app, "DELETE", `/auth/token/${th}`, {
      headers: { "x-admin-token": ctx.adminToken },
      body: { reason: "testing" },
    });
    expect(rev.status).toBe(200);

    const after = await fetchJson(ctx.app, "POST", "/echo", {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
      body: {},
    });
    expect(after.status).toBe(401);
  });

  test("ss58_legacy_auth_still_works_but_emits_warn_log", async () => {
    // Legacy pattern: send SS58 as the x-api-key
    const res = await fetchJson(ctx.app, "POST", "/echo", {
      headers: { "x-api-key": ctx.legacyApiKey },
      body: {},
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ account: ctx.ss58, tier: "api-key-legacy-ss58" });

    // warn-log must have fired
    const calls = (warnSpy.mock.calls as unknown[][]).map((c) => c.join(" "));
    const deprecationLog = calls.find((m: string) => m.includes("deprecated-ss58-auth"));
    expect(deprecationLog, `warn log not emitted: ${JSON.stringify(calls)}`).toBeTruthy();
    expect(deprecationLog).toContain(ctx.ss58);
  });

  test("invalid_auth_returns_401", async () => {
    const res = await fetchJson(ctx.app, "POST", "/echo", { body: {} });
    expect(res.status).toBe(401);
  });

  test("admin_mint_requires_elevated_auth", async () => {
    // No admin token → 401
    const unauth = await fetchJson(ctx.app, "POST", "/auth/token", {
      body: { account: "5NewOperator111111111111111111111111111111111", label: "x" },
    });
    expect(unauth.status).toBe(401);

    // With admin token → 200 + returned token is prefixed
    const good = await fetchJson(ctx.app, "POST", "/auth/token", {
      headers: { "x-admin-token": ctx.adminToken },
      body: { account: "5NewOperator1111111111111111111111111111111111", label: "x" },
    });
    expect(good.status).toBe(200);
    const body = good.body as { token: string; tokenHash: string };
    expect(body.token.startsWith(TOKEN_PREFIX)).toBe(true);
  });

  test("admin_guard_rejects_wrong_length_admin_token_without_leaking_length", async () => {
    // A candidate shorter than the real admin token used to short-circuit
    // on `!==`, which leaks length via timing. With constant-time compare
    // all rejections take the same code path; we only assert on the
    // observable behaviour (401 + no side effect).
    const tooShort = await fetchJson(ctx.app, "POST", "/auth/token", {
      headers: { "x-admin-token": "a" },
      body: { account: "5ShouldNotBeCreated11111111111111111111111111", label: "x" },
    });
    expect(tooShort.status).toBe(401);

    const tooLong = await fetchJson(ctx.app, "POST", "/auth/token", {
      headers: {
        "x-admin-token": ctx.adminToken + "extra-suffix-that-should-fail",
      },
      body: { account: "5ShouldNotBeCreated11111111111111111111111112", label: "x" },
    });
    expect(tooLong.status).toBe(401);

    // And an empty header too.
    const empty = await fetchJson(ctx.app, "POST", "/auth/token", {
      headers: { "x-admin-token": "" },
      body: { account: "5ShouldNotBeCreated11111111111111111111111113", label: "x" },
    });
    expect(empty.status).toBe(401);
  });

  test("admin_revoke_marks_token_inactive", async () => {
    const mintRes = await fetchJson(ctx.app, "POST", "/auth/token", {
      headers: { "x-admin-token": ctx.adminToken },
      body: { account: "5RevokeViaApi1111111111111111111111111111111111", label: "revoke-me" },
    });
    expect(mintRes.status).toBe(200);
    const { token, tokenHash } = mintRes.body as { token: string; tokenHash: string };

    // Works pre-revoke
    const pre = await fetchJson(ctx.app, "POST", "/echo", {
      headers: { authorization: `Bearer ${token}` },
      body: {},
    });
    expect(pre.status).toBe(200);

    const rev = await fetchJson(ctx.app, "DELETE", `/auth/token/${tokenHash}`, {
      headers: { "x-admin-token": ctx.adminToken },
      body: { reason: "testing" },
    });
    expect(rev.status).toBe(200);

    const post = await fetchJson(ctx.app, "POST", "/echo", {
      headers: { authorization: `Bearer ${token}` },
      body: {},
    });
    expect(post.status).toBe(401);
  });

  test("bearer_beats_legacy_when_both_headers_present", async () => {
    // Bearer (new) must take priority: good Bearer + bogus SS58 → 200 on Bearer
    const { token } = issueToken(ctx.tokensDb, {
      accountSs58: "5Priority1111111111111111111111111111111111111",
      label: "priority",
    });
    const res = await fetchJson(ctx.app, "POST", "/echo", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-api-key": "5BogusSs58222222222222222222222222222222222",
      },
      body: {},
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ account: "5Priority1111111111111111111111111111111111111", tier: "bearer" });
  });
});

describe("admin CLI helper", () => {
  test("mintAdminTokenForTests_issues_a_token_and_inserts_a_row", () => {
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    initApiTokensDb(db);

    const { token, tokenHash } = mintAdminTokenForTests(db, {
      account: "5CliTest11111111111111111111111111111111111111",
      label: "cli-test",
    });
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    const row = db
      .prepare("SELECT token_hash, account_ss58 FROM api_tokens WHERE token_hash = ?")
      .get(tokenHash) as { token_hash: string; account_ss58: string };
    expect(row.account_ss58).toBe("5CliTest11111111111111111111111111111111111111");
  });
});

describe("PATCH /auth/token/label (self-service rename)", () => {
  let m: MountedApp;
  beforeEach(() => {
    m = setupApp();
  });

  test("bearer_can_rename_own_token", async () => {
    const r = await fetchJson(m.app, "PATCH", "/auth/token/label", {
      headers: { Authorization: `Bearer ${m.bearerToken}` },
      body: { label: "self-renamed" },
    });
    expect(r.status).toBe(200);
    const body = r.body as { status: string; label: string; accountSs58: string };
    expect(body.status).toBe("updated");
    expect(body.label).toBe("self-renamed");
    expect(body.accountSs58).toBe(m.ss58);

    // The label MUST be persisted in the row used by heartbeat label-resolution.
    const row = m.tokensDb
      .prepare("SELECT label FROM api_tokens WHERE account_ss58 = ?")
      .get(m.ss58) as { label: string };
    expect(row.label).toBe("self-renamed");
  });

  test("rename_to_null_clears_label", async () => {
    const r = await fetchJson(m.app, "PATCH", "/auth/token/label", {
      headers: { Authorization: `Bearer ${m.bearerToken}` },
      body: { label: null },
    });
    expect(r.status).toBe(200);
    expect((r.body as { label: string | null }).label).toBeNull();
  });

  test("trims_and_caps_at_128_chars", async () => {
    const long = "A".repeat(200);
    const r = await fetchJson(m.app, "PATCH", "/auth/token/label", {
      headers: { Authorization: `Bearer ${m.bearerToken}` },
      body: { label: `   ${long}   ` },
    });
    expect(r.status).toBe(200);
    const body = r.body as { label: string };
    expect(body.label).toBe("A".repeat(128));
  });

  test("rejects_non_string_label", async () => {
    const r = await fetchJson(m.app, "PATCH", "/auth/token/label", {
      headers: { Authorization: `Bearer ${m.bearerToken}` },
      body: { label: 42 },
    });
    expect(r.status).toBe(400);
  });

  test("rejects_unauthenticated_request", async () => {
    const r = await fetchJson(m.app, "PATCH", "/auth/token/label", {
      body: { label: "ghost" },
    });
    expect(r.status).toBe(401);
  });

  test("rejects_legacy_api_key_tier", async () => {
    // Legacy x-api-key path doesn't carry a token_hash to mutate, so
    // self-service rename must refuse it (and tell the caller why).
    const r = await fetchJson(m.app, "PATCH", "/auth/token/label", {
      headers: { "x-api-key": m.legacyApiKey },
      body: { label: "from-legacy" },
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/Bearer/);
  });

  test("revoked_bearer_cannot_rename", async () => {
    // Revoke the token then try to use it.
    const tokenHash = createHash("sha256").update(m.bearerToken).digest("hex");
    m.tokensDb
      .prepare("UPDATE api_tokens SET revoked_at = ? WHERE token_hash = ?")
      .run(Math.floor(Date.now() / 1000), tokenHash);

    const r = await fetchJson(m.app, "PATCH", "/auth/token/label", {
      headers: { Authorization: `Bearer ${m.bearerToken}` },
      body: { label: "after-revoke" },
    });
    // bearerAuth catches revoked first — surfaces 401 from middleware.
    expect(r.status).toBe(401);
  });
});

describe("PATCH /auth/token/:hash/label (admin override)", () => {
  let m: MountedApp;
  beforeEach(() => {
    m = setupApp();
  });

  test("admin_can_rename_any_token", async () => {
    const tokenHash = createHash("sha256").update(m.bearerToken).digest("hex");
    const r = await fetchJson(m.app, "PATCH", `/auth/token/${tokenHash}/label`, {
      headers: { "x-admin-token": m.adminToken },
      body: { label: "admin-renamed" },
    });
    expect(r.status).toBe(200);
    expect((r.body as { label: string }).label).toBe("admin-renamed");
  });

  test("rejects_unknown_hash_with_404", async () => {
    const r = await fetchJson(
      m.app,
      "PATCH",
      `/auth/token/${"deadbeef".repeat(8)}/label`,
      {
        headers: { "x-admin-token": m.adminToken },
        body: { label: "ghost" },
      },
    );
    expect(r.status).toBe(404);
  });

  test("rejects_revoked_hash_with_409", async () => {
    const tokenHash = createHash("sha256").update(m.bearerToken).digest("hex");
    m.tokensDb
      .prepare("UPDATE api_tokens SET revoked_at = ? WHERE token_hash = ?")
      .run(Math.floor(Date.now() / 1000), tokenHash);

    const r = await fetchJson(m.app, "PATCH", `/auth/token/${tokenHash}/label`, {
      headers: { "x-admin-token": m.adminToken },
      body: { label: "after-revoke" },
    });
    expect(r.status).toBe(409);
  });

  test("rejects_invalid_hash_shape_with_400", async () => {
    const r = await fetchJson(m.app, "PATCH", "/auth/token/notahash/label", {
      headers: { "x-admin-token": m.adminToken },
      body: { label: "x" },
    });
    expect(r.status).toBe(400);
  });

  test("rejects_missing_admin_token_with_401_or_403", async () => {
    const tokenHash = createHash("sha256").update(m.bearerToken).digest("hex");
    const r = await fetchJson(m.app, "PATCH", `/auth/token/${tokenHash}/label`, {
      body: { label: "no-admin" },
    });
    expect([401, 403]).toContain(r.status);
  });
});

// Smoke-test the quota db injection so other tests don't rot silently
describe("quota db test hook", () => {
  test("resolveKey_returns_null_for_unknown", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE api_keys (
        key_hash TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        max_receipts_per_day INTEGER NOT NULL DEFAULT 100,
        max_bytes_per_day INTEGER NOT NULL DEFAULT 1073741824,
        max_concurrent_uploads INTEGER NOT NULL DEFAULT 5,
        validator_id TEXT DEFAULT NULL
      );
    `);
    setQuotaDbForTests(db);
    expect(resolveKey("no-such-key")).toBeNull();
  });
});
