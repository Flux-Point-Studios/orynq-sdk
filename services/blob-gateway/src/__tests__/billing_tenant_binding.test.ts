/**
 * Task #119 — cross-tenant data-leak fix on /billing/usage.
 *
 * Test plan (matches the PR brief):
 *   1. issue token w/ tenant_id="ten-a" → query usage(tenant_id="ten-a") → 200
 *   2. issue token w/ tenant_id="ten-a" → query usage(tenant_id="ten-b") → 403
 *   3. issue token w/ NO tenant_id     → query usage(tenant_id="ten-Anything") → 200 (legacy)
 *   4. issue token w/ tenant_id="ten-a" → query usage with NO tenant_id param → 400
 *   5. migration against a fresh SQLite DB: a row inserted on the OLD schema
 *      (no tenant_id column) survives the ALTER, ends up with tenant_id NULL,
 *      and remains usable via /billing/usage as legacy/admin tier.
 *
 * Plus belt-and-suspenders coverage of:
 *   - bindTokenToTenant() helper (post-issuance binding + clearing).
 *   - migrate idempotency (running the migration twice on a fresh DB).
 *   - 401 on missing/malformed/revoked Bearer.
 *
 * The chain query is mocked (these tests focus on auth, not aggregation).
 * In-memory SQLite is used throughout — no /data/blobs file is touched.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";

// rpc-client + notify mocks mirror usage-tracking.test.ts so even the
// indirect imports don't reach for a live websocket.
vi.mock("../rpc-client.js", () => ({
  checkFunded: vi.fn(async () => true),
  checkReceiptStatus: vi.fn(async () => "not_found" as const),
  disconnectRpc: vi.fn(async () => {}),
}));
vi.mock("../notify.js", () => ({
  notifyDaemon: vi.fn(async () => {}),
}));

import express from "express";
import Database from "better-sqlite3";
import { createHash, randomBytes } from "crypto";

import {
  initApiTokensDb,
  setApiTokensDb,
  issueToken,
  bindTokenToTenant,
  verifyToken,
  migrateTenantBindingColumn,
  hashToken,
  TOKEN_PREFIX,
} from "../api-tokens.js";
import {
  setQuotaDbForTests,
  migrateUsageColumns,
  migrateBindingColumn,
  recordUsage,
} from "../quota.js";
import { billingRouter } from "../routes/billing.js";
import { registerTokenRoutes } from "../routes/tokens.js";
import { initWorkerBoundsDb, setWorkerBoundsDbForTests } from "../worker_bounds.js";

// Mock the chain-status + anchor-resolution modules so this suite stays
// focused on auth/tenant binding (no live RPC, no SSH).
vi.mock("../billing/chain_query.js", async () => {
  const actual = await vi.importActual<typeof import("../billing/chain_query.js")>(
    "../billing/chain_query.js",
  );
  return {
    ...actual,
    queryReceiptStatuses: vi.fn(async () => []),
    queryCompositeTrustScores: vi.fn(async () => []),
  };
});
vi.mock("../billing/anchor_resolver.js", async () => {
  const actual = await vi.importActual<typeof import("../billing/anchor_resolver.js")>(
    "../billing/anchor_resolver.js",
  );
  return {
    ...actual,
    resolveAnchorTxs: vi.fn(async () => []),
  };
});

// --------------------------------------------------------------------------
// DB fixtures + small HTTP helper
// --------------------------------------------------------------------------

/** Build the api_tokens DB shape we ship to prod (after task #119 migration). */
function makeTokensDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  initApiTokensDb(db);
  setApiTokensDb(db);
  return db;
}

/** Build a quota DB whose api_keys row carries the Phase 1 usage columns. */
function makeQuotaDb(): Database.Database {
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
    CREATE TABLE quota_daily (
      key_hash TEXT NOT NULL,
      day TEXT NOT NULL,
      receipts INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (key_hash, day)
    );
  `);
  migrateUsageColumns(quotaDb);
  migrateBindingColumn(quotaDb);
  setQuotaDbForTests(quotaDb);
  return quotaDb;
}

/** Insert a single api_keys row tied to an SS58. */
function seedApiKey(
  quotaDb: Database.Database,
  opts: { ss58: string; maxReceipts?: number; maxBytes?: number },
): { keyHash: string } {
  const plaintext = randomBytes(32).toString("hex");
  const keyHash = createHash("sha256").update(plaintext).digest("hex");
  quotaDb
    .prepare(
      `INSERT INTO api_keys
       (key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads, validator_id)
       VALUES (?, ?, 1, ?, ?, 5, ?)`,
    )
    .run(
      keyHash,
      "billing-test",
      opts.maxReceipts ?? 100,
      opts.maxBytes ?? 1073741824,
      opts.ss58,
    );
  return { keyHash };
}

/**
 * Stand up a fresh Express app with the billing routes mounted. Each call
 * builds isolated in-memory DBs so tests run in parallel without crosstalk.
 */
type Mounted = {
  app: express.Express;
  tokensDb: Database.Database;
  quotaDb: Database.Database;
  adminToken: string;
};

function setupApp(): Mounted {
  const tokensDb = makeTokensDb();
  const quotaDb = makeQuotaDb();
  const adminToken = `admin-${randomBytes(16).toString("hex")}`;

  // Worker-bounds DB hosts the metering_submissions table queried by
  // /billing/usage. Empty for this suite — we focus on auth, not aggregates.
  const wbDb = new Database(":memory:");
  wbDb.pragma("journal_mode = WAL");
  initWorkerBoundsDb(wbDb);
  setWorkerBoundsDbForTests(wbDb);

  const app = express();
  app.use(express.json());
  registerTokenRoutes(app, { adminToken });
  app.use(billingRouter);

  return { app, tokensDb, quotaDb, adminToken };
}

/** Helper: build a fully-qualified /billing/usage URL with sensible defaults. */
function billingUrl(tenantId?: string | null, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  if (tenantId !== null && tenantId !== undefined) {
    params.set("tenant_id", tenantId);
  }
  // Wide window so the tenant-binding suite never fails on time-window edge.
  params.set("start_ms", "0");
  params.set("end_ms", String(90 * 24 * 60 * 60 * 1000));
  for (const [k, v] of Object.entries(extra ?? {})) params.set(k, v);
  return `/billing/usage?${params.toString()}`;
}

async function fetchJson(
  app: express.Express,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr === "string" || addr === null) {
        server.close();
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

// --------------------------------------------------------------------------
// Suite 1 — schema migration (runs ALTER against fresh sqlite, real ALTER)
// --------------------------------------------------------------------------

describe("api_tokens migration: tenant_id column", () => {
  test("fresh DB has tenant_id after initApiTokensDb", () => {
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    initApiTokensDb(db);
    const cols = db
      .prepare("PRAGMA table_info(api_tokens)")
      .all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "tenant_id")).toBe(true);
  });

  test("existing pre-migration tokens survive the ALTER and read as NULL tenant_id", () => {
    // Recreate the OLD schema (no tenant_id column) and seed a row.
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE api_tokens (
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
    const legacyHash = "a".repeat(64);
    db.prepare(
      "INSERT INTO api_tokens (token_hash, account_ss58, label, created_at) VALUES (?, ?, ?, ?)",
    ).run(legacyHash, "5LegacyOperator11111111111111111111111111111", "pre-119", 1);

    // Apply the migration (idempotent helper exposed for direct test access).
    migrateTenantBindingColumn(db);

    const cols = db
      .prepare("PRAGMA table_info(api_tokens)")
      .all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "tenant_id")).toBe(true);

    // The legacy row must still be there, with tenant_id = NULL.
    const row = db
      .prepare("SELECT account_ss58, tenant_id FROM api_tokens WHERE token_hash = ?")
      .get(legacyHash) as { account_ss58: string; tenant_id: string | null };
    expect(row.account_ss58).toBe("5LegacyOperator11111111111111111111111111111");
    expect(row.tenant_id).toBeNull();
  });

  test("migration is idempotent (safe to call twice)", () => {
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE api_tokens (
        token_hash TEXT PRIMARY KEY,
        account_ss58 TEXT NOT NULL,
        label TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER,
        revoked_reason TEXT
      );
    `);
    migrateTenantBindingColumn(db);
    expect(() => migrateTenantBindingColumn(db)).not.toThrow();
    const cols = db
      .prepare("PRAGMA table_info(api_tokens)")
      .all() as Array<{ name: string }>;
    expect(cols.filter((c) => c.name === "tenant_id").length).toBe(1);
  });
});

// --------------------------------------------------------------------------
// Suite 2 — issueToken / bindTokenToTenant / verifyToken surface tenantId
// --------------------------------------------------------------------------

describe("api-tokens: tenant_id round-trip", () => {
  test("issueToken with tenantId persists and verifyToken returns it", () => {
    const db = makeTokensDb();
    const { token, tenantId } = issueToken(db, {
      accountSs58: "5RoundTripaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      label: "rt",
      tenantId: "ten-rt",
    });
    expect(tenantId).toBe("ten-rt");

    const v = verifyToken(db, token);
    expect(v.valid).toBe(true);
    if (!v.valid) throw new Error("unreachable");
    expect(v.tenantId).toBe("ten-rt");
  });

  test("issueToken without tenantId yields tenantId=null", () => {
    const db = makeTokensDb();
    const { token, tenantId } = issueToken(db, {
      accountSs58: "5NoTenantxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      label: "nt",
    });
    expect(tenantId).toBeNull();

    const v = verifyToken(db, token);
    expect(v.valid).toBe(true);
    if (!v.valid) throw new Error("unreachable");
    expect(v.tenantId).toBeNull();
  });

  test("bindTokenToTenant updates an existing token", () => {
    const db = makeTokensDb();
    const { token, tokenHash } = issueToken(db, {
      accountSs58: "5Bindzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
      label: "bind",
    });
    expect(verifyToken(db, token).valid).toBe(true);

    const ok = bindTokenToTenant(db, tokenHash, "ten-late-bind");
    expect(ok).toBe(true);

    const v = verifyToken(db, token);
    expect(v.valid).toBe(true);
    if (!v.valid) throw new Error("unreachable");
    expect(v.tenantId).toBe("ten-late-bind");
  });

  test("bindTokenToTenant(null) clears the binding", () => {
    const db = makeTokensDb();
    const { token, tokenHash } = issueToken(db, {
      accountSs58: "5Clearccccccccccccccccccccccccccccccccccccccc",
      label: "clear",
      tenantId: "ten-to-be-cleared",
    });
    bindTokenToTenant(db, tokenHash, null);
    const v = verifyToken(db, token);
    expect(v.valid).toBe(true);
    if (!v.valid) throw new Error("unreachable");
    expect(v.tenantId).toBeNull();
  });

  test("bindTokenToTenant returns false for unknown hash", () => {
    const db = makeTokensDb();
    const ok = bindTokenToTenant(db, "deadbeef".repeat(8), "ten-x");
    expect(ok).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Suite 3 — /billing/usage enforcement (the actual P0 fix)
// --------------------------------------------------------------------------

describe("GET /billing/usage — task #119 tenant binding enforcement", () => {
  let ctx: Mounted;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    ctx = setupApp();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  test("token bound to ten-A querying ten-A → 200", async () => {
    const ss58 = "5TenAhappypath11111111111111111111111111111111";
    const { keyHash } = seedApiKey(ctx.quotaDb, { ss58, maxReceipts: 50, maxBytes: 1024 });
    recordUsage(keyHash, 256, 1);

    const { token } = issueToken(ctx.tokensDb, {
      accountSs58: ss58,
      label: "ten-a",
      tenantId: "ten-a",
    });

    const res = await fetchJson(ctx.app, "GET", billingUrl("ten-a"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      tenant_id: string;
      aggregate: { record_count: number };
    };
    expect(body.tenant_id).toBe("ten-a");
    // Empty result is the expected shape — no metering rows in this suite.
    expect(body.aggregate.record_count).toBe(0);
    void keyHash; // quotaDb seeded for legacy parity; new endpoint reads worker_bounds.
  });

  test("token bound to ten-A querying ten-B → 403 TOKEN_TENANT_MISMATCH", async () => {
    const ss58A = "5TenAleakerxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const ss58B = "5TenBvictimyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";
    seedApiKey(ctx.quotaDb, { ss58: ss58A });
    seedApiKey(ctx.quotaDb, { ss58: ss58B, maxReceipts: 999 });

    const { token: tokenA } = issueToken(ctx.tokensDb, {
      accountSs58: ss58A,
      tenantId: "ten-a",
    });

    const res = await fetchJson(ctx.app, "GET", billingUrl("ten-b"), {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.status).toBe(403);
    const body = res.body as { error: string; message?: string };
    expect(body.error).toBe("TOKEN_TENANT_MISMATCH");

    // Audit log fired (cross-tenant probe attempt).
    const calls = (warnSpy.mock.calls as unknown[][]).map((c) => c.join(" "));
    const auditLog = calls.find((m: string) => m.includes("billing-tenant-mismatch"));
    expect(auditLog, `audit log missing: ${JSON.stringify(calls)}`).toBeTruthy();
    expect(auditLog).toContain("boundTenant=ten-a");
    expect(auditLog).toContain("requestedTenant=ten-b");
    // Raw token NEVER in the log.
    expect(auditLog).not.toContain(tokenA);
  });

  test("legacy token with NO tenant_id → query usage(any tenant) → 200", async () => {
    const ss58 = "5LegacyAdminhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh";
    seedApiKey(ctx.quotaDb, { ss58 });

    // Token minted WITHOUT a tenant_id — represents pre-task-119 tokens
    // and admin/legacy tier going forward.
    const { token, tenantId } = issueToken(ctx.tokensDb, {
      accountSs58: ss58,
      label: "legacy-admin",
    });
    expect(tenantId).toBeNull();

    // Querying ANY tenant_id is allowed (admin/legacy tier). Note: the
    // /billing/usage tenant_id regex is `[a-z0-9-]{4,64}` so we use names
    // that satisfy it.
    for (const t of ["ten-anything", "ten-notmine", "ten-flawless"]) {
      const res = await fetchJson(
        ctx.app,
        "GET",
        billingUrl(t),
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(res.status, `query ${t} failed`).toBe(200);
      const body = res.body as { tenant_id: string };
      expect(body.tenant_id).toBe(t);
    }
    void ss58;
  });

  test("token with tenant_id but NO tenant_id query param → 400", async () => {
    const ss58 = "5MissingParammmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm";
    seedApiKey(ctx.quotaDb, { ss58 });
    const { token } = issueToken(ctx.tokensDb, {
      accountSs58: ss58,
      tenantId: "ten-a",
    });

    // Build a URL that ONLY has start/end_ms but no tenant_id.
    const res = await fetchJson(
      ctx.app,
      "GET",
      `/billing/usage?start_ms=0&end_ms=${90 * 24 * 60 * 60 * 1000}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(400);
    const body = res.body as { field?: string; error: string };
    // New endpoint surfaces the field name explicitly.
    expect(body.field ?? body.error).toContain("tenant_id");
  });

  test("post-issuance bindTokenToTenant takes effect on subsequent requests", async () => {
    const ss58 = "5PostBindeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    seedApiKey(ctx.quotaDb, { ss58 });
    const { token, tokenHash } = issueToken(ctx.tokensDb, {
      accountSs58: ss58,
      label: "post-bind",
    });

    // Pre-bind: legacy tier — querying any tenant works.
    const pre = await fetchJson(ctx.app, "GET", billingUrl("ten-z"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(pre.status).toBe(200);

    // Bind to ten-A.
    const bound = bindTokenToTenant(ctx.tokensDb, tokenHash, "ten-a");
    expect(bound).toBe(true);

    // Post-bind: tenant_id=ten-z must now 403.
    const post = await fetchJson(ctx.app, "GET", billingUrl("ten-z"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(post.status).toBe(403);

    // But ten-A succeeds.
    const ok = await fetchJson(ctx.app, "GET", billingUrl("ten-a"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
  });

  test("missing Bearer header → 401", async () => {
    const res = await fetchJson(ctx.app, "GET", billingUrl("ten-a"));
    expect(res.status).toBe(401);
  });

  test("malformed Bearer (wrong prefix) → 401", async () => {
    const res = await fetchJson(ctx.app, "GET", billingUrl("ten-a"), {
      headers: { authorization: "Bearer notmatra_garbage" },
    });
    expect(res.status).toBe(401);
  });

  test("unknown Bearer hash → 401", async () => {
    const bogus = `${TOKEN_PREFIX}aAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa`;
    const res = await fetchJson(ctx.app, "GET", billingUrl("ten-a"), {
      headers: { authorization: `Bearer ${bogus}` },
    });
    expect(res.status).toBe(401);
  });

  test("revoked Bearer → 401 (not 403)", async () => {
    const ss58 = "5RevokedBearerrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr";
    seedApiKey(ctx.quotaDb, { ss58 });
    const { token, tokenHash } = issueToken(ctx.tokensDb, {
      accountSs58: ss58,
      tenantId: "ten-a",
    });
    ctx.tokensDb
      .prepare(
        "UPDATE api_tokens SET revoked_at = ?, revoked_reason = ? WHERE token_hash = ?",
      )
      .run(1, "test", tokenHash);

    const res = await fetchJson(ctx.app, "GET", billingUrl("ten-a"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });
});

// --------------------------------------------------------------------------
// Suite 4 — POST /auth/token accepts tenant_id (snake + camel) — admin path
// --------------------------------------------------------------------------

describe("POST /auth/token — tenant_id mint flow", () => {
  let ctx: Mounted;
  beforeEach(() => {
    ctx = setupApp();
  });

  test("snake-case tenant_id is persisted and verifyable", async () => {
    const res = await fetchJson(ctx.app, "POST", "/auth/token", {
      headers: { "x-admin-token": ctx.adminToken },
      body: {
        account: "5MintTenantSnakeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        label: "snake",
        tenant_id: "ten-snake",
      },
    });
    expect(res.status).toBe(200);
    const body = res.body as { token: string; tokenHash: string; tenantId: string };
    expect(body.tenantId).toBe("ten-snake");

    const v = verifyToken(ctx.tokensDb, body.token);
    expect(v.valid).toBe(true);
    if (!v.valid) throw new Error("unreachable");
    expect(v.tenantId).toBe("ten-snake");
    expect(hashToken(body.token)).toBe(body.tokenHash);
  });

  test("camelCase tenantId also accepted", async () => {
    const res = await fetchJson(ctx.app, "POST", "/auth/token", {
      headers: { "x-admin-token": ctx.adminToken },
      body: {
        account: "5MintTenantCamellllllllllllllllllllllllllllllll",
        label: "camel",
        tenantId: "ten-camel",
      },
    });
    expect(res.status).toBe(200);
    const body = res.body as { tenantId: string };
    expect(body.tenantId).toBe("ten-camel");
  });

  test("mint without tenant_id stays null (legacy/admin)", async () => {
    const res = await fetchJson(ctx.app, "POST", "/auth/token", {
      headers: { "x-admin-token": ctx.adminToken },
      body: {
        account: "5MintNoTenantqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
        label: "legacy",
      },
    });
    expect(res.status).toBe(200);
    const body = res.body as { tenantId: string | null };
    expect(body.tenantId).toBeNull();
  });

  test("mint route stays 401 without admin token even with tenant_id supplied", async () => {
    const res = await fetchJson(ctx.app, "POST", "/auth/token", {
      body: { account: "5x", tenant_id: "ten-X" },
    });
    expect(res.status).toBe(401);
  });
});
