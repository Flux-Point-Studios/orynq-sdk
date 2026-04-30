/**
 * Phase 1 billing — per-token usage metering tests.
 *
 * No billing enforcement; these tests only verify that:
 *   - `recordUsage()` bumps lifetime_receipts / lifetime_bytes / last_used_at
 *     atomically on an in-memory SQLite DB (same semantics as prod quota.db).
 *   - `getUsage()` reads those counters back.
 *   - The `GET /auth/token/:hash/usage` admin route returns the usage JSON
 *     shape and is gated by x-admin-token (same guard as DELETE).
 *   - The integration path (POST manifest → PUT chunk via Bearer) actually
 *     credits the right token's lifetime counters.
 *
 * Migration idempotency is also covered: repeated `migrateUsageColumns()`
 * against an already-migrated handle is a no-op, which mirrors what the
 * prod blob-gateway does on every restart.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// rpc-client + notify mocks mirror upload-auth.test.ts so the sig-only and
// sponsored-receipt hot paths don't try to open WebSockets or POST to any
// daemon. Tests that touch only quota.ts directly won't exercise these,
// but the integration tests do.
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
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { config } from "../config.js";
import { blobsRouter } from "../routes/blobs.js";
import {
  setQuotaDbForTests,
  migrateUsageColumns,
  migrateBindingColumn,
  recordUsage,
  getUsage,
} from "../quota.js";
import {
  initApiTokensDb,
  issueToken,
  setApiTokensDb,
} from "../api-tokens.js";
import { registerTokenRoutes } from "../routes/tokens.js";

// --------------------------------------------------------------------------
// Shared DB fixtures
// --------------------------------------------------------------------------

/**
 * Build an in-memory quota DB with the full schema (api_keys includes the
 * Phase 1 usage columns via `migrateUsageColumns`). Returns the handle
 * AND injects it into quota.ts via `setQuotaDbForTests` so callers of
 * recordUsage/getUsage operate on this DB.
 */
function makeQuotaDb(): Database.Database {
  const quotaDb = new Database(":memory:");
  quotaDb.pragma("journal_mode = WAL");
  // Match the non-phase-1 columns from initQuotaDb. We deliberately create
  // the legacy shape first so migrateUsageColumns has something to alter —
  // same situation the first production restart after this PR will face.
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
    CREATE TABLE uploads_inflight (
      upload_id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL,
      started_at TEXT NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE account_quotas_daily (
      address TEXT NOT NULL,
      day TEXT NOT NULL,
      receipts INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (address, day)
    );
    CREATE TABLE account_uploads_inflight (
      upload_id TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      started_at TEXT NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active'
    );
  `);
  migrateUsageColumns(quotaDb);
  // Task #94: also add the bound_validator_aura column so resolveKey()
  // doesn't 500 when bearer-auth queries the row.
  migrateBindingColumn(quotaDb);
  setQuotaDbForTests(quotaDb);
  return quotaDb;
}

/** Insert a single api_keys row and return its hash. */
function seedKey(
  quotaDb: Database.Database,
  opts: {
    plaintext?: string;
    name?: string;
    ss58?: string | null;
    maxReceipts?: number;
    maxBytes?: number;
  } = {},
): { apiKey: string; keyHash: string } {
  const plaintext = opts.plaintext ?? randomBytes(32).toString("hex");
  const keyHash = createHash("sha256").update(plaintext).digest("hex");
  quotaDb
    .prepare(
      `INSERT INTO api_keys
       (key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads, validator_id)
       VALUES (?, ?, 1, ?, ?, 5, ?)`,
    )
    .run(
      keyHash,
      opts.name ?? "usage-test",
      opts.maxReceipts ?? 100,
      opts.maxBytes ?? 1073741824,
      opts.ss58 ?? null,
    );
  return { apiKey: plaintext, keyHash };
}

// --------------------------------------------------------------------------
// Unit tests — recordUsage / getUsage / migration idempotency
// --------------------------------------------------------------------------

describe("quota.recordUsage", () => {
  let quotaDb: Database.Database;
  beforeEach(() => {
    quotaDb = makeQuotaDb();
  });

  test("test_recordUsage_bumps_receipts_and_last_used_at", () => {
    const { keyHash } = seedKey(quotaDb, { name: "receipts" });
    const before = quotaDb
      .prepare("SELECT lifetime_receipts, last_used_at FROM api_keys WHERE key_hash = ?")
      .get(keyHash) as { lifetime_receipts: number; last_used_at: string | null };
    expect(before.lifetime_receipts).toBe(0);
    expect(before.last_used_at).toBeNull();

    recordUsage(keyHash, 0, 1);

    const after = quotaDb
      .prepare("SELECT lifetime_receipts, lifetime_bytes, last_used_at FROM api_keys WHERE key_hash = ?")
      .get(keyHash) as {
        lifetime_receipts: number;
        lifetime_bytes: number;
        last_used_at: string | null;
      };
    expect(after.lifetime_receipts).toBe(1);
    expect(after.lifetime_bytes).toBe(0);
    expect(after.last_used_at).not.toBeNull();
    // ISO-8601 string shape: "YYYY-MM-DDTHH:MM:SS.sssZ"
    expect(after.last_used_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  test("test_recordUsage_bumps_bytes", () => {
    const { keyHash } = seedKey(quotaDb, { name: "bytes" });
    recordUsage(keyHash, 1234, 0);
    const row = quotaDb
      .prepare("SELECT lifetime_receipts, lifetime_bytes FROM api_keys WHERE key_hash = ?")
      .get(keyHash) as { lifetime_receipts: number; lifetime_bytes: number };
    expect(row.lifetime_receipts).toBe(0);
    expect(row.lifetime_bytes).toBe(1234);
  });

  test("test_recordUsage_is_idempotent_within_transaction", () => {
    // better-sqlite3 is synchronous — the "concurrent" case is really a
    // sequence of back-to-back calls. We assert the += math doesn't drift:
    // 100 calls of (64 bytes, 0 receipts) and 100 calls of (0 bytes, 1 receipt)
    // must land at (6400, 100) exactly, regardless of interleaving.
    const { keyHash } = seedKey(quotaDb, { name: "idempotent" });
    for (let i = 0; i < 100; i++) {
      recordUsage(keyHash, 64, 0);
      recordUsage(keyHash, 0, 1);
    }
    const row = quotaDb
      .prepare("SELECT lifetime_receipts, lifetime_bytes FROM api_keys WHERE key_hash = ?")
      .get(keyHash) as { lifetime_receipts: number; lifetime_bytes: number };
    expect(row.lifetime_receipts).toBe(100);
    expect(row.lifetime_bytes).toBe(100 * 64);
  });

  test("test_recordUsage_unknown_keyHash_is_silent_noop", () => {
    // Missing rows must not crash — they represent a registration race
    // and we'd rather swallow than 500 an upload.
    expect(() => recordUsage("deadbeef".repeat(8), 42, 1)).not.toThrow();
  });

  test("test_recordUsage_negative_and_nan_bytes_are_coerced_to_zero", () => {
    const { keyHash } = seedKey(quotaDb, { name: "sanitize" });
    recordUsage(keyHash, -5, 0);
    recordUsage(keyHash, Number.NaN, 0);
    const row = quotaDb
      .prepare("SELECT lifetime_bytes FROM api_keys WHERE key_hash = ?")
      .get(keyHash) as { lifetime_bytes: number };
    expect(row.lifetime_bytes).toBe(0);
  });
});

describe("quota.getUsage", () => {
  let quotaDb: Database.Database;
  beforeEach(() => {
    quotaDb = makeQuotaDb();
  });

  test("test_getUsage_returns_latest_counters", () => {
    const { keyHash } = seedKey(quotaDb, {
      name: "latest",
      maxReceipts: 500,
      maxBytes: 999,
    });
    recordUsage(keyHash, 100, 1);
    recordUsage(keyHash, 200, 0);
    recordUsage(keyHash, 300, 1);
    const snap = getUsage(keyHash);
    expect(snap).not.toBeNull();
    expect(snap!.lifetime_receipts).toBe(2);
    expect(snap!.lifetime_bytes).toBe(600);
    expect(snap!.lifetime_matra_debited).toBe(0);
    expect(snap!.max_receipts_per_day).toBe(500);
    expect(snap!.max_bytes_per_day).toBe(999);
    expect(snap!.last_used_at).not.toBeNull();
  });

  test("test_getUsage_nonexistent_key_returns_null", () => {
    expect(getUsage("deadbeef".repeat(8))).toBeNull();
  });

  test("test_getUsage_returns_zeroes_for_fresh_row", () => {
    const { keyHash } = seedKey(quotaDb, { name: "fresh" });
    const snap = getUsage(keyHash);
    expect(snap).not.toBeNull();
    expect(snap!.lifetime_receipts).toBe(0);
    expect(snap!.lifetime_bytes).toBe(0);
    expect(snap!.lifetime_matra_debited).toBe(0);
    expect(snap!.last_used_at).toBeNull();
  });
});

describe("quota.migrateUsageColumns idempotency", () => {
  test("test_idempotent_migration", () => {
    // Fresh legacy-schema DB. First migrate: adds 4 columns. Second: no-op.
    // Third (belt + suspenders): still no-op. Verify counters survive.
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
    db.prepare(
      `INSERT INTO api_keys (key_hash, name) VALUES ('aa', 'pre-migration')`,
    ).run();

    migrateUsageColumns(db);
    migrateUsageColumns(db);
    migrateUsageColumns(db);

    const cols = db.prepare("PRAGMA table_info(api_keys)").all() as Array<{
      name: string;
    }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("lifetime_receipts")).toBe(true);
    expect(names.has("lifetime_bytes")).toBe(true);
    expect(names.has("lifetime_matra_debited")).toBe(true);
    expect(names.has("last_used_at")).toBe(true);

    // Row that pre-existed the migration must show DEFAULT 0 via SELECT.
    const row = db
      .prepare(
        "SELECT lifetime_receipts, lifetime_bytes, lifetime_matra_debited, last_used_at FROM api_keys WHERE key_hash = 'aa'",
      )
      .get() as {
        lifetime_receipts: number;
        lifetime_bytes: number;
        lifetime_matra_debited: number;
        last_used_at: string | null;
      };
    expect(row.lifetime_receipts).toBe(0);
    expect(row.lifetime_bytes).toBe(0);
    expect(row.lifetime_matra_debited).toBe(0);
    expect(row.last_used_at).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Admin endpoint tests — GET /auth/token/:hash/usage
// --------------------------------------------------------------------------

type MountedAdmin = {
  app: express.Express;
  adminToken: string;
  tokensDb: Database.Database;
  quotaDb: Database.Database;
  ss58: string;
  tokenHash: string;
  keyHash: string;
};

function setupAdminApp(): MountedAdmin {
  const quotaDb = makeQuotaDb();

  const tokensDb = new Database(":memory:");
  tokensDb.pragma("journal_mode = WAL");
  initApiTokensDb(tokensDb);
  setApiTokensDb(tokensDb);

  const ss58 = "5UsageAdminTestaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";
  // api_keys row bound to the account (validator_id = ss58) — same shape
  // operators.db registration produces in production.
  const { keyHash } = seedKey(quotaDb, {
    name: "usage-admin",
    ss58,
    maxReceipts: 42,
    maxBytes: 7777,
  });

  const { tokenHash } = issueToken(tokensDb, {
    accountSs58: ss58,
    label: "usage-label",
  });

  const adminToken = `admin-${randomBytes(16).toString("hex")}`;

  const app = express();
  app.use(express.json());
  registerTokenRoutes(app, { adminToken });

  return { app, adminToken, tokensDb, quotaDb, ss58, tokenHash, keyHash };
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

describe("GET /auth/token/:hash/usage", () => {
  let ctx: MountedAdmin;
  beforeEach(() => {
    ctx = setupAdminApp();
  });

  test("test_admin_endpoint_401_without_admin_token", async () => {
    const res = await fetchJson(ctx.app, "GET", `/auth/token/${ctx.tokenHash}/usage`);
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error");
  });

  test("test_admin_endpoint_401_with_wrong_admin_token", async () => {
    const res = await fetchJson(ctx.app, "GET", `/auth/token/${ctx.tokenHash}/usage`, {
      headers: { "x-admin-token": "not-the-real-admin-token" },
    });
    expect(res.status).toBe(401);
  });

  test("test_admin_endpoint_returns_usage_json", async () => {
    // Seed some usage so we can assert non-zero values came through.
    recordUsage(ctx.keyHash, 500, 1);
    recordUsage(ctx.keyHash, 250, 0);

    const res = await fetchJson(ctx.app, "GET", `/auth/token/${ctx.tokenHash}/usage`, {
      headers: { "x-admin-token": ctx.adminToken },
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      tokenHash: string;
      accountSs58: string;
      label: string | null;
      lifetime: { receipts: number; bytes: number; matra_debited: number };
      today: { receipts: number; bytes: number };
      caps: { max_receipts_per_day: number; max_bytes_per_day: number };
      last_used_at: string | null;
    };
    expect(body.tokenHash).toBe(ctx.tokenHash);
    expect(body.accountSs58).toBe(ctx.ss58);
    expect(body.label).toBe("usage-label");
    expect(body.lifetime.receipts).toBe(1);
    expect(body.lifetime.bytes).toBe(750);
    expect(body.lifetime.matra_debited).toBe(0);
    expect(body.today.receipts).toBe(0); // recordUsage doesn't touch quota_daily
    expect(body.today.bytes).toBe(0);
    expect(body.caps.max_receipts_per_day).toBe(42);
    expect(body.caps.max_bytes_per_day).toBe(7777);
    expect(body.last_used_at).not.toBeNull();
  });

  test("test_admin_endpoint_404_for_unknown_token_hash", async () => {
    const bogus = "a".repeat(64);
    const res = await fetchJson(ctx.app, "GET", `/auth/token/${bogus}/usage`, {
      headers: { "x-admin-token": ctx.adminToken },
    });
    expect(res.status).toBe(404);
  });

  test("test_admin_endpoint_400_for_malformed_hash", async () => {
    const res = await fetchJson(ctx.app, "GET", `/auth/token/not-hex/usage`, {
      headers: { "x-admin-token": ctx.adminToken },
    });
    expect(res.status).toBe(400);
  });
});

// --------------------------------------------------------------------------
// Integration tests — POST manifest + PUT chunk credit the right token
// --------------------------------------------------------------------------

type MountedUpload = {
  app: express.Express;
  quotaDb: Database.Database;
  tokensDb: Database.Database;
  keyHash: string;
  bearerToken: string;
  tmpStorage: string;
  prevStoragePath: string;
};

function setupUploadApp(): MountedUpload {
  const tmpStorage = mkdtempSync(join(tmpdir(), "blob-gateway-usage-test-"));
  const prevStoragePath = config.storagePath;
  config.storagePath = tmpStorage;

  const quotaDb = makeQuotaDb();
  const tokensDb = new Database(":memory:");
  tokensDb.pragma("journal_mode = WAL");
  initApiTokensDb(tokensDb);
  setApiTokensDb(tokensDb);

  const ss58 = "5UsageUploadTestaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";
  const { keyHash } = seedKey(quotaDb, { name: "usage-upload", ss58 });

  const { token: bearerToken } = issueToken(tokensDb, {
    accountSs58: ss58,
    label: "usage-upload",
  });

  const app = express();
  // Raw body parser for chunk uploads (mirrors prod index.ts ordering).
  app.put(
    "/blobs/:contentHash/chunks/:i",
    express.raw({ type: "*/*", limit: `${config.maxChunkBytes}` }),
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(blobsRouter);

  return { app, quotaDb, tokensDb, keyHash, bearerToken, tmpStorage, prevStoragePath };
}

function buildSingleChunkManifest(payload = Buffer.from("usage-hello-world")): {
  manifest: { chunks: Array<{ index: number; sha256: string; size: number }> };
  chunk: Buffer;
  contentHash: string;
} {
  const sha = createHash("sha256").update(payload).digest("hex");
  return {
    manifest: { chunks: [{ index: 0, sha256: sha, size: payload.length }] },
    chunk: payload,
    contentHash: sha,
  };
}

async function fetchRaw(
  app: express.Express,
  method: string,
  path: string,
  opts: {
    headers?: Record<string, string>;
    jsonBody?: unknown;
    rawBody?: Buffer;
  } = {},
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
        headers: { ...(opts.headers || {}) },
      };
      if (opts.rawBody !== undefined) {
        init.body = opts.rawBody;
        (init.headers as Record<string, string>)["content-type"] =
          (init.headers as Record<string, string>)["content-type"] ?? "application/octet-stream";
        (init.headers as Record<string, string>)["content-length"] = String(opts.rawBody.length);
      } else if (opts.jsonBody !== undefined) {
        init.body = JSON.stringify(opts.jsonBody);
        (init.headers as Record<string, string>)["content-type"] = "application/json";
      }
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

describe("upload routes: usage metering", () => {
  let ctx: MountedUpload;
  beforeEach(() => {
    ctx = setupUploadApp();
  });
  afterEach(() => {
    config.storagePath = ctx.prevStoragePath;
    rmSync(ctx.tmpStorage, { recursive: true, force: true });
  });

  test("test_manifest_upload_records_receipt_count", async () => {
    const { manifest, contentHash } = buildSingleChunkManifest();
    const res = await fetchRaw(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
      jsonBody: manifest,
    });
    expect(res.status).toBe(201);

    const snap = getUsage(ctx.keyHash);
    expect(snap).not.toBeNull();
    expect(snap!.lifetime_receipts).toBe(1);
    // No chunk has been uploaded yet, so bytes stay at 0.
    expect(snap!.lifetime_bytes).toBe(0);
    expect(snap!.last_used_at).not.toBeNull();
  });

  test("test_chunk_upload_records_bytes", async () => {
    const { manifest, chunk, contentHash } = buildSingleChunkManifest();
    const manifestRes = await fetchRaw(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
      jsonBody: manifest,
    });
    expect(manifestRes.status).toBe(201);

    const chunkRes = await fetchRaw(ctx.app, "PUT", `/blobs/${contentHash}/chunks/0`, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
      rawBody: chunk,
    });
    expect(chunkRes.status).toBe(200);

    const snap = getUsage(ctx.keyHash);
    expect(snap).not.toBeNull();
    // One receipt (manifest), one chunk worth of bytes (chunk body).
    expect(snap!.lifetime_receipts).toBe(1);
    expect(snap!.lifetime_bytes).toBe(chunk.length);
  });
});
