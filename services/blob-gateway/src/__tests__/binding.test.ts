/**
 * Task #94 — aura → cert-daemon-signer binding tests.
 *
 * Covers:
 *   - Idempotent migration (run twice on same DB = no-op)
 *   - Helpers: bindValidatorAura / clearValidatorAuraBinding /
 *     getApiKeyByHash / getBindingForAura / listAllAuraBindings
 *   - Admin HTTP endpoints (set / get / clear) with x-admin-token guard,
 *     SS58 validation, key-hash validation, and 404 for unknown rows
 *   - /heartbeats/status now returns a top-level `bindings` field
 *
 * No live RPC, no live chain. All DBs are in-memory.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../rpc-client.js", () => ({
  checkFunded: vi.fn(async () => true),
  checkReceiptStatus: vi.fn(async () => "not_found" as const),
  disconnectRpc: vi.fn(async () => {}),
}));

import express from "express";
import Database from "better-sqlite3";
import { createHash, randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { Keyring } from "@polkadot/api";

import { config } from "../config.js";
import {
  setQuotaDbForTests,
  migrateUsageColumns,
  migrateBindingColumn,
  bindValidatorAura,
  clearValidatorAuraBinding,
  getApiKeyByHash,
  getBindingForAura,
  listAllAuraBindings,
} from "../quota.js";
import { registerAdminKeysRoutes } from "../routes/admin-keys.js";
import { heartbeatsRouter } from "../routes/heartbeats.js";
import { initHeartbeatDb } from "../heartbeat-store.js";

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Build a quota DB matching the legacy production schema, then run all
 * migrations the way prod startup does. */
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
  migrateBindingColumn(quotaDb);
  setQuotaDbForTests(quotaDb);
  return quotaDb;
}

function seedKey(
  quotaDb: Database.Database,
  opts: { name?: string; ss58?: string | null; aura?: string | null } = {},
): { keyHash: string; apiKey: string } {
  const apiKey = randomBytes(32).toString("hex");
  const keyHash = createHash("sha256").update(apiKey).digest("hex");
  quotaDb
    .prepare(
      `INSERT INTO api_keys
       (key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads, validator_id, bound_validator_aura)
       VALUES (?, ?, 1, 100, 1073741824, 5, ?, ?)`,
    )
    .run(keyHash, opts.name ?? "binding-test", opts.ss58 ?? null, opts.aura ?? null);
  return { keyHash, apiKey };
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
// Migration tests
// --------------------------------------------------------------------------

describe("migrateBindingColumn", () => {
  test("test_idempotent_on_legacy_schema", () => {
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

    migrateBindingColumn(db);
    migrateBindingColumn(db);
    migrateBindingColumn(db);

    const cols = db.prepare("PRAGMA table_info(api_keys)").all() as Array<{
      name: string;
    }>;
    expect(cols.some((c) => c.name === "bound_validator_aura")).toBe(true);

    // Legacy row has NULL binding by default.
    const row = db
      .prepare("SELECT bound_validator_aura FROM api_keys WHERE key_hash = 'aa'")
      .get() as { bound_validator_aura: string | null };
    expect(row.bound_validator_aura).toBeNull();
  });

  test("test_idempotent_on_already_migrated_schema", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE api_keys (
        key_hash TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        max_receipts_per_day INTEGER NOT NULL DEFAULT 100,
        max_bytes_per_day INTEGER NOT NULL DEFAULT 1073741824,
        max_concurrent_uploads INTEGER NOT NULL DEFAULT 5,
        validator_id TEXT DEFAULT NULL,
        bound_validator_aura TEXT DEFAULT NULL
      );
    `);
    expect(() => migrateBindingColumn(db)).not.toThrow();
    expect(() => migrateBindingColumn(db)).not.toThrow();
  });
});

// --------------------------------------------------------------------------
// Helper-function tests
// --------------------------------------------------------------------------

describe("quota binding helpers", () => {
  let quotaDb: Database.Database;
  beforeEach(() => {
    quotaDb = makeQuotaDb();
  });

  test("test_bindValidatorAura_sets_then_reads_back", () => {
    const { keyHash } = seedKey(quotaDb, { name: "set-then-read" });
    const aura = "5Fn3UBWziTisjT6cx1K42eqycX5Fz4n9wWw97o5zd3RmAR9J";

    expect(bindValidatorAura(keyHash, aura)).toBe(true);

    const row = getApiKeyByHash(keyHash);
    expect(row?.boundValidatorAura).toBe(aura);
  });

  test("test_bindValidatorAura_returns_false_for_unknown_keyHash", () => {
    const result = bindValidatorAura("0".repeat(64), "5Fn3UBWziTisjT6cx1K42eqycX5Fz4n9wWw97o5zd3RmAR9J");
    expect(result).toBe(false);
  });

  test("test_clearValidatorAuraBinding_nulls_existing", () => {
    const aura = "5Fn3UBWziTisjT6cx1K42eqycX5Fz4n9wWw97o5zd3RmAR9J";
    const { keyHash } = seedKey(quotaDb, { name: "clear-test", aura });

    expect(getApiKeyByHash(keyHash)?.boundValidatorAura).toBe(aura);
    expect(clearValidatorAuraBinding(keyHash)).toBe(true);
    expect(getApiKeyByHash(keyHash)?.boundValidatorAura).toBeNull();
  });

  test("test_clearValidatorAuraBinding_idempotent_on_null_row", () => {
    const { keyHash } = seedKey(quotaDb, { name: "already-null" });
    expect(clearValidatorAuraBinding(keyHash)).toBe(true); // row exists, no-op write
    expect(getApiKeyByHash(keyHash)?.boundValidatorAura).toBeNull();
  });

  test("test_getBindingForAura_returns_first_enabled_row", () => {
    const aura = "5Fn3UBWziTisjT6cx1K42eqycX5Fz4n9wWw97o5zd3RmAR9J";
    const certDaemonSs58 = "5ELL8NYkKPKqrdXig7KnsAzN82CyomztrXoY6uHsb4tuck7T";
    seedKey(quotaDb, {
      name: "OnTimeData",
      ss58: certDaemonSs58,
      aura,
    });

    const lookup = getBindingForAura(aura);
    expect(lookup).not.toBeNull();
    expect(lookup?.certDaemonSs58).toBe(certDaemonSs58);
    expect(lookup?.name).toBe("OnTimeData");
  });

  test("test_getBindingForAura_returns_null_when_no_binding", () => {
    seedKey(quotaDb, { name: "no-binding" });
    expect(getBindingForAura("5Fn3UBWziTisjT6cx1K42eqycX5Fz4n9wWw97o5zd3RmAR9J")).toBeNull();
  });

  test("test_getBindingForAura_skips_disabled_rows", () => {
    const aura = "5Fn3UBWziTisjT6cx1K42eqycX5Fz4n9wWw97o5zd3RmAR9J";
    const certDaemonSs58 = "5ELL8NYkKPKqrdXig7KnsAzN82CyomztrXoY6uHsb4tuck7T";
    const apiKey = randomBytes(32).toString("hex");
    const keyHash = createHash("sha256").update(apiKey).digest("hex");
    quotaDb
      .prepare(
        `INSERT INTO api_keys
         (key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads, validator_id, bound_validator_aura)
         VALUES (?, 'disabled', 0, 100, 1073741824, 5, ?, ?)`,
      )
      .run(keyHash, certDaemonSs58, aura);

    expect(getBindingForAura(aura)).toBeNull();
  });

  test("test_listAllAuraBindings_empty_when_no_bindings", () => {
    seedKey(quotaDb, { name: "no-binding-1" });
    seedKey(quotaDb, { name: "no-binding-2" });
    expect(listAllAuraBindings()).toEqual({});
  });

  test("test_listAllAuraBindings_returns_aura_to_certdaemon_map", () => {
    seedKey(quotaDb, {
      name: "OnTimeData",
      ss58: "5ELL8NYkKPKqrdXig7KnsAzN82CyomztrXoY6uHsb4tuck7T",
      aura: "5Fn3UBWziTisjT6cx1K42eqycX5Fz4n9wWw97o5zd3RmAR9J",
    });
    seedKey(quotaDb, {
      name: "macbook-preprod",
      ss58: "5GgCBrKDwMCWckd8P7CNLxy2ARmPHRVE4yjXuTP1vfwNtYzX",
      aura: "5CoiW8b5wm45shiSagjxyFgpz7DS8pZiESQRVUcxJU1W687J",
    });
    seedKey(quotaDb, { name: "no-binding" }); // omitted from result
    seedKey(quotaDb, {
      name: "binding-but-no-validator-id",
      ss58: null,
      aura: "5SomethingWithoutSignerUsedaaaaaaaaaaaaaaaaaaaaab",
    }); // omitted from result (validator_id IS NULL)

    const all = listAllAuraBindings();
    expect(Object.keys(all).length).toBe(2);
    expect(all["5Fn3UBWziTisjT6cx1K42eqycX5Fz4n9wWw97o5zd3RmAR9J"]).toEqual({
      certDaemonSs58: "5ELL8NYkKPKqrdXig7KnsAzN82CyomztrXoY6uHsb4tuck7T",
      label: "OnTimeData",
    });
    expect(all["5CoiW8b5wm45shiSagjxyFgpz7DS8pZiESQRVUcxJU1W687J"]).toEqual({
      certDaemonSs58: "5GgCBrKDwMCWckd8P7CNLxy2ARmPHRVE4yjXuTP1vfwNtYzX",
      label: "macbook-preprod",
    });
  });

  test("test_listAllAuraBindings_degenerate_aura_equals_signer", () => {
    // Hetzner case: the same SS58 is both validator aura and cert-daemon
    // signer (operator chose convenience over key-isolation). The schema
    // accepts this; explorer renders without the "via cert-daemon X" hint
    // because the aura equals the signer.
    const ss58 = "5ELbHNFv5rJveN4XnfF6zzTEqCiAbLP2mNEhNgF4iX5nS1h7";
    seedKey(quotaDb, {
      name: "Hetzner-cert-daemon",
      ss58,
      aura: ss58,
    });
    const all = listAllAuraBindings();
    expect(all[ss58]).toEqual({
      certDaemonSs58: ss58,
      label: "Hetzner-cert-daemon",
    });
  });
});

// --------------------------------------------------------------------------
// Admin endpoint tests
// --------------------------------------------------------------------------

type MountedAdmin = {
  app: express.Express;
  adminToken: string;
  quotaDb: Database.Database;
  keyHash: string;
};

function setupAdminApp(): MountedAdmin {
  const quotaDb = makeQuotaDb();
  const { keyHash } = seedKey(quotaDb, {
    name: "admin-binding-test",
    ss58: "5ELL8NYkKPKqrdXig7KnsAzN82CyomztrXoY6uHsb4tuck7T",
  });

  const adminToken = `admin-${randomBytes(16).toString("hex")}`;
  const app = express();
  app.use(express.json());
  registerAdminKeysRoutes(app, { adminToken });

  return { app, adminToken, quotaDb, keyHash };
}

describe("GET /admin/api-keys/:keyHash", () => {
  let ctx: MountedAdmin;
  beforeEach(() => {
    ctx = setupAdminApp();
  });

  test("test_401_without_admin_token", async () => {
    const res = await fetchJson(ctx.app, "GET", `/admin/api-keys/${ctx.keyHash}`);
    expect(res.status).toBe(401);
  });

  test("test_401_with_wrong_admin_token", async () => {
    const res = await fetchJson(ctx.app, "GET", `/admin/api-keys/${ctx.keyHash}`, {
      headers: { "x-admin-token": "wrong" },
    });
    expect(res.status).toBe(401);
  });

  test("test_400_for_malformed_keyHash", async () => {
    const res = await fetchJson(ctx.app, "GET", `/admin/api-keys/not-hex`, {
      headers: { "x-admin-token": ctx.adminToken },
    });
    expect(res.status).toBe(400);
  });

  test("test_404_for_unknown_keyHash", async () => {
    const bogus = "a".repeat(64);
    const res = await fetchJson(ctx.app, "GET", `/admin/api-keys/${bogus}`, {
      headers: { "x-admin-token": ctx.adminToken },
    });
    expect(res.status).toBe(404);
  });

  test("test_returns_row_with_null_binding_initially", async () => {
    const res = await fetchJson(ctx.app, "GET", `/admin/api-keys/${ctx.keyHash}`, {
      headers: { "x-admin-token": ctx.adminToken },
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      keyHash: string;
      name: string;
      enabled: boolean;
      validatorId: string | null;
      boundValidatorAura: string | null;
    };
    expect(body.keyHash).toBe(ctx.keyHash);
    expect(body.name).toBe("admin-binding-test");
    expect(body.enabled).toBe(true);
    expect(body.validatorId).toBe("5ELL8NYkKPKqrdXig7KnsAzN82CyomztrXoY6uHsb4tuck7T");
    expect(body.boundValidatorAura).toBeNull();
  });
});

describe("POST /admin/api-keys/:keyHash/binding", () => {
  let ctx: MountedAdmin;
  beforeEach(() => {
    ctx = setupAdminApp();
  });

  test("test_401_without_admin_token", async () => {
    const res = await fetchJson(ctx.app, "POST", `/admin/api-keys/${ctx.keyHash}/binding`, {
      body: { validatorAura: "5Fn3UBWziTisjT6cx1K42eqycX5Fz4n9wWw97o5zd3RmAR9J" },
    });
    expect(res.status).toBe(401);
  });

  test("test_400_for_missing_validatorAura", async () => {
    const res = await fetchJson(ctx.app, "POST", `/admin/api-keys/${ctx.keyHash}/binding`, {
      headers: { "x-admin-token": ctx.adminToken },
      body: {},
    });
    expect(res.status).toBe(400);
  });

  test("test_400_for_invalid_ss58", async () => {
    const res = await fetchJson(ctx.app, "POST", `/admin/api-keys/${ctx.keyHash}/binding`, {
      headers: { "x-admin-token": ctx.adminToken },
      body: { validatorAura: "not-a-valid-address" },
    });
    expect(res.status).toBe(400);
  });

  test("test_404_for_unknown_keyHash", async () => {
    const bogus = "b".repeat(64);
    const res = await fetchJson(ctx.app, "POST", `/admin/api-keys/${bogus}/binding`, {
      headers: { "x-admin-token": ctx.adminToken },
      body: { validatorAura: "5Fn3UBWziTisjT6cx1K42eqycX5Fz4n9wWw97o5zd3RmAR9J" },
    });
    expect(res.status).toBe(404);
  });

  test("test_200_persists_binding", async () => {
    const aura = "5Fn3UBWziTisjT6cx1K42eqycX5Fz4n9wWw97o5zd3RmAR9J";
    const res = await fetchJson(ctx.app, "POST", `/admin/api-keys/${ctx.keyHash}/binding`, {
      headers: { "x-admin-token": ctx.adminToken },
      body: { validatorAura: aura },
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      status: string;
      keyHash: string;
      boundValidatorAura: string;
      certDaemonSs58: string | null;
    };
    expect(body.status).toBe("bound");
    expect(body.boundValidatorAura).toBe(aura);
    expect(body.certDaemonSs58).toBe("5ELL8NYkKPKqrdXig7KnsAzN82CyomztrXoY6uHsb4tuck7T");

    // Verify it's actually persisted via GET.
    const get = await fetchJson(ctx.app, "GET", `/admin/api-keys/${ctx.keyHash}`, {
      headers: { "x-admin-token": ctx.adminToken },
    });
    expect(get.status).toBe(200);
    expect((get.body as { boundValidatorAura: string }).boundValidatorAura).toBe(aura);
  });

  test("test_re_binding_overwrites_previous_value", async () => {
    const a1 = "5Fn3UBWziTisjT6cx1K42eqycX5Fz4n9wWw97o5zd3RmAR9J";
    const a2 = "5CoiW8b5wm45shiSagjxyFgpz7DS8pZiESQRVUcxJU1W687J";
    await fetchJson(ctx.app, "POST", `/admin/api-keys/${ctx.keyHash}/binding`, {
      headers: { "x-admin-token": ctx.adminToken },
      body: { validatorAura: a1 },
    });
    await fetchJson(ctx.app, "POST", `/admin/api-keys/${ctx.keyHash}/binding`, {
      headers: { "x-admin-token": ctx.adminToken },
      body: { validatorAura: a2 },
    });
    const get = await fetchJson(ctx.app, "GET", `/admin/api-keys/${ctx.keyHash}`, {
      headers: { "x-admin-token": ctx.adminToken },
    });
    expect((get.body as { boundValidatorAura: string }).boundValidatorAura).toBe(a2);
  });
});

describe("DELETE /admin/api-keys/:keyHash/binding", () => {
  let ctx: MountedAdmin;
  beforeEach(() => {
    ctx = setupAdminApp();
  });

  test("test_401_without_admin_token", async () => {
    const res = await fetchJson(ctx.app, "DELETE", `/admin/api-keys/${ctx.keyHash}/binding`);
    expect(res.status).toBe(401);
  });

  test("test_400_for_malformed_keyHash", async () => {
    const res = await fetchJson(ctx.app, "DELETE", `/admin/api-keys/not-hex/binding`, {
      headers: { "x-admin-token": ctx.adminToken },
    });
    expect(res.status).toBe(400);
  });

  test("test_404_for_unknown_keyHash", async () => {
    const bogus = "c".repeat(64);
    const res = await fetchJson(ctx.app, "DELETE", `/admin/api-keys/${bogus}/binding`, {
      headers: { "x-admin-token": ctx.adminToken },
    });
    expect(res.status).toBe(404);
  });

  test("test_200_clears_existing_binding", async () => {
    // Set then clear.
    await fetchJson(ctx.app, "POST", `/admin/api-keys/${ctx.keyHash}/binding`, {
      headers: { "x-admin-token": ctx.adminToken },
      body: { validatorAura: "5Fn3UBWziTisjT6cx1K42eqycX5Fz4n9wWw97o5zd3RmAR9J" },
    });
    const del = await fetchJson(ctx.app, "DELETE", `/admin/api-keys/${ctx.keyHash}/binding`, {
      headers: { "x-admin-token": ctx.adminToken },
    });
    expect(del.status).toBe(200);
    expect((del.body as { status: string }).status).toBe("cleared");

    const get = await fetchJson(ctx.app, "GET", `/admin/api-keys/${ctx.keyHash}`, {
      headers: { "x-admin-token": ctx.adminToken },
    });
    expect((get.body as { boundValidatorAura: string | null }).boundValidatorAura).toBeNull();
  });

  test("test_503_when_admin_token_unconfigured", async () => {
    const app = express();
    app.use(express.json());
    registerAdminKeysRoutes(app, { adminToken: "" });

    // With no token, every endpoint must 503 — the production behaviour
    // we expose on misconfigured deployments.
    const cases: Array<[string, string]> = [
      ["GET", `/admin/api-keys/${ctx.keyHash}`],
      ["POST", `/admin/api-keys/${ctx.keyHash}/binding`],
      ["DELETE", `/admin/api-keys/${ctx.keyHash}/binding`],
    ];
    for (const [method, path] of cases) {
      const res = await fetchJson(app, method, path);
      expect(res.status).toBe(503);
    }
  });
});

// --------------------------------------------------------------------------
// /heartbeats/status now exposes the bindings inline
// --------------------------------------------------------------------------

describe("GET /heartbeats/status with bindings", () => {
  let tmpStorage: string;
  let prevStoragePath: string;

  beforeEach(async () => {
    await cryptoWaitReady();
    tmpStorage = mkdtempSync(join(tmpdir(), "blob-gateway-binding-test-"));
    prevStoragePath = config.storagePath;
    config.storagePath = tmpStorage;
    initHeartbeatDb();
    // The /heartbeats/status handler caches its response in a module-level
    // variable for 10s. Tests run in order against the same module, so we
    // rely on POST /heartbeats invalidation OR reaching across the boundary.
    // The cleanest path: invalidate by importing the route's reset hook.
    // We don't expose one, so we accept that two `GET /heartbeats/status`
    // tests in a row will see the same cached body if they run within 10s.
    // To get deterministic results we register one test with a binding and
    // verify both bindings + empty in a single pass (no second GET).
  });

  afterEach(() => {
    config.storagePath = prevStoragePath;
    rmSync(tmpStorage, { recursive: true, force: true });
  });

  test("test_status_response_contains_bindings_field", async () => {
    const quotaDb = makeQuotaDb();
    seedKey(quotaDb, {
      name: "OnTimeData",
      ss58: "5ELL8NYkKPKqrdXig7KnsAzN82CyomztrXoY6uHsb4tuck7T",
      aura: "5Fn3UBWziTisjT6cx1K42eqycX5Fz4n9wWw97o5zd3RmAR9J",
    });

    const app = express();
    app.use(express.json());
    app.use(heartbeatsRouter);

    const res = await fetchJson(app, "GET", "/heartbeats/status");
    expect(res.status).toBe(200);
    const body = res.body as {
      validators: Record<string, unknown>;
      summary: unknown;
      bindings: Record<string, { certDaemonSs58: string; label: string }>;
    };
    expect(body.bindings).toBeDefined();
    expect(body.bindings["5Fn3UBWziTisjT6cx1K42eqycX5Fz4n9wWw97o5zd3RmAR9J"]).toEqual({
      certDaemonSs58: "5ELL8NYkKPKqrdXig7KnsAzN82CyomztrXoY6uHsb4tuck7T",
      label: "OnTimeData",
    });
  });

  // NOTE: a separate "empty bindings" test would conflict with the 10s
  // cache in the route handler. The bindings field with empty {} is
  // already covered by listAllAuraBindings unit tests above
  // (test_listAllAuraBindings_empty_when_no_bindings).
});
