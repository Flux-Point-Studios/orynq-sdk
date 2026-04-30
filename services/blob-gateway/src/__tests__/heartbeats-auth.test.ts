/**
 * Integration tests for the unified auth path on POST /heartbeats.
 *
 * Before this PR the handler read `req.headers["x-api-key"]` directly, so
 * operators who had issued themselves a Bearer token (`matra_...`) got a
 * silent 401/403 when trying to flip their cert-daemon over. This suite
 * locks in the fix: Bearer (priority 0), legacy x-api-key (priority 1),
 * and the existing sr25519 `x-heartbeat-sig` fallback (priority 2) all
 * land 200 OK, while revoked/missing auth still fail closed with the
 * wire formats the cert-daemon + explorer parse today.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// rpc-client opens a WebSocket to a chain RPC in production. resolveAuth()
// only reaches that code path on the upload-sig branch, which heartbeats
// never trip (we call resolveAuth without a contentHash), but the module is
// still transitively imported — stub it anyway for deterministic teardown.
vi.mock("../rpc-client.js", () => ({
  checkFunded: vi.fn(async () => true),
  checkReceiptStatus: vi.fn(async () => "not_found" as const),
  disconnectRpc: vi.fn(async () => {}),
}));

import express from "express";
import Database from "better-sqlite3";
import { createHash } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { Keyring } from "@polkadot/api";
import { u8aToHex, stringToU8a } from "@polkadot/util";
import type { KeyringPair } from "@polkadot/keyring/types";

import { config } from "../config.js";
import { heartbeatsRouter } from "../routes/heartbeats.js";
import { setQuotaDbForTests, migrateBindingColumn } from "../quota.js";
import {
  initApiTokensDb,
  issueToken,
  setApiTokensDb,
} from "../api-tokens.js";
import { initHeartbeatDb } from "../heartbeat-store.js";

// --------------------------------------------------------------------------
// Test harness
// --------------------------------------------------------------------------

interface HarnessCtx {
  app: express.Express;
  pair: KeyringPair;
  ss58: string;
  legacyApiKey: string;
  randomApiKey: string;
  bearerToken: string;
  tokensDb: Database.Database;
  quotaDb: Database.Database;
  tmpStorage: string;
  prevStoragePath: string;
}

/** Counter for generating unique validator keys per test. The heartbeat
 * route carries a module-level in-memory rate limiter keyed by
 * validator_id; reusing the same ID across sub-tests would 429. Each test
 * gets its own pair via `//HeartbeatValidator${n}`. */
let _pairCounter = 0;

async function setupApp(opts: { registerValidator?: boolean } = {}): Promise<HarnessCtx> {
  await cryptoWaitReady();

  // --- fs: point storage at a throwaway temp dir (heartbeat.db lives here) ---
  const tmpStorage = mkdtempSync(join(tmpdir(), "blob-gateway-heartbeats-test-"));
  const prevStoragePath = config.storagePath;
  config.storagePath = tmpStorage;

  // Init the real heartbeat-store against a file in tmpStorage. This is a
  // module-level singleton, so once initialised it points at our temp DB
  // until the test process exits.
  initHeartbeatDb();

  // --- quota db (in-memory, matching initQuotaDb's schema) ---
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
  // Task #94: add bound_validator_aura column so resolveKey()/resolveKeyByAccount()
  // don't 500 when the heartbeat handler queries the row.
  migrateBindingColumn(quotaDb);
  setQuotaDbForTests(quotaDb);

  // Real sr25519 validator key — the heartbeat-sig path requires a real
  // signature that signatureVerify() can check against validator_id. We
  // mint a unique key per setupApp() call so the in-memory rate limiter
  // (module-level `lastPostTime` in heartbeats.ts) doesn't 429 subsequent
  // tests for the same validator_id.
  const keyring = new Keyring({ type: "sr25519" });
  _pairCounter += 1;
  const pair = keyring.addFromUri(`//HeartbeatValidator${_pairCounter}`);
  const ss58 = pair.address;

  // Random per-operator api key (production pattern — 64 hex).
  const randomApiKey = "0".repeat(64);
  const randomKeyHash = createHash("sha256").update(randomApiKey).digest("hex");

  if (opts.registerValidator !== false) {
    quotaDb
      .prepare(
        `INSERT INTO api_keys
         (key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads, validator_id)
         VALUES (?, 'operator-heartbeat-test', 1, 100, 1073741824, 5, ?)`,
      )
      .run(randomKeyHash, ss58);

    // Legacy SS58-as-API-key row: hash(ss58) → validator_id = ss58. This
    // is the path the cert-daemon has been using in prod since v5.
    const legacyKeyHash = createHash("sha256").update(ss58).digest("hex");
    quotaDb
      .prepare(
        `INSERT INTO api_keys
         (key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads, validator_id)
         VALUES (?, 'operator-heartbeat-test-legacy', 1, 100, 1073741824, 5, ?)`,
      )
      .run(legacyKeyHash, ss58);
  }

  // --- api_tokens db (in-memory) ---
  const tokensDb = new Database(":memory:");
  tokensDb.pragma("journal_mode = WAL");
  initApiTokensDb(tokensDb);
  setApiTokensDb(tokensDb);

  const { token: bearerToken } = issueToken(tokensDb, {
    accountSs58: ss58,
    label: "heartbeats-auth-test",
  });

  // --- Express app wired to the real heartbeatsRouter ---
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(heartbeatsRouter);

  return {
    app,
    pair,
    ss58,
    legacyApiKey: ss58, // legacy pattern = send the SS58 itself as the key
    randomApiKey,
    bearerToken,
    tokensDb,
    quotaDb,
    tmpStorage,
    prevStoragePath,
  };
}

/** Minimal fetch wrapper around an ephemeral-port listen. */
async function fetchJson(
  app: express.Express,
  method: string,
  path: string,
  opts: {
    headers?: Record<string, string>;
    jsonBody?: unknown;
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
      if (opts.jsonBody !== undefined) {
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

interface HeartbeatBody {
  validator_id: string;
  seq: number;
  timestamp: number;
  best_block: number;
  finalized_block: number;
  finality_gap: number;
  pending_receipts: number;
  certs_submitted: number;
  substrate_connected: boolean;
  version: string;
  uptime_seconds: number;
}

/** Build a well-formed heartbeat body + matching x-heartbeat-sig header. */
function buildHeartbeat(
  pair: KeyringPair,
  validator_id: string,
  seq: number,
  overrides: Partial<HeartbeatBody> = {},
): { body: HeartbeatBody; sig: string } {
  const body: HeartbeatBody = {
    validator_id,
    seq,
    timestamp: Math.floor(Date.now() / 1000),
    best_block: 12345,
    finalized_block: 12340,
    finality_gap: 5,
    pending_receipts: 0,
    certs_submitted: 0,
    substrate_connected: true,
    version: "test-1.0.0",
    uptime_seconds: 3600,
    ...overrides,
  };
  const scInt = body.substrate_connected ? 1 : 0;
  const signingString = [
    "materios-heartbeat-v1",
    body.validator_id,
    String(body.seq),
    String(body.timestamp),
    String(body.best_block),
    String(body.finalized_block),
    String(body.finality_gap),
    String(body.pending_receipts),
    String(body.certs_submitted),
    String(scInt),
    String(body.version),
    String(body.uptime_seconds),
  ].join("|");
  const sig = u8aToHex(pair.sign(stringToU8a(signingString)));
  return { body, sig };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("POST /heartbeats: unified auth (Bearer / x-api-key / x-heartbeat-sig)", () => {
  let ctx: HarnessCtx;
  /** Monotonically-increasing seq per test to dodge the replay guard. */
  let nextSeq = 1_000_000;

  beforeEach(async () => {
    ctx = await setupApp();
    // Bump seq baseline by a large step so the in-memory heartbeat-store
    // (reused across beforeEach's, since initHeartbeatDb opens a file on
    // disk keyed by tmpStorage) never flags sub-tests as replays.
    nextSeq += 1_000;
  });

  afterEach(() => {
    config.storagePath = ctx.prevStoragePath;
    rmSync(ctx.tmpStorage, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------------
  // 1. Bearer token accepted — the actual regression this PR fixes
  // ------------------------------------------------------------------------
  test("test_heartbeat_accepts_bearer_token", async () => {
    const seq = nextSeq++;
    const { body, sig } = buildHeartbeat(ctx.pair, ctx.ss58, seq);
    const res = await fetchJson(ctx.app, "POST", "/heartbeats", {
      headers: {
        authorization: `Bearer ${ctx.bearerToken}`,
        "x-heartbeat-sig": sig,
      },
      jsonBody: body,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", seq });
    // Surfacing the tier helps operators debug which header was accepted
    // during the rollout; we lock it in so the contract survives.
    expect((res.body as { auth_tier?: string }).auth_tier).toBe("bearer");

    // Regression: last_seq stored under the validator_id
    const lastSeq = await fetchJson(ctx.app, "GET", `/heartbeats/seq/${ctx.ss58}`);
    expect(lastSeq.status).toBe(200);
    expect((lastSeq.body as { last_seq: number }).last_seq).toBe(seq);
  });

  // ------------------------------------------------------------------------
  // 2. Legacy x-api-key (random hex) — regression guard
  // ------------------------------------------------------------------------
  test("test_heartbeat_accepts_legacy_x_api_key_random_hex", async () => {
    const seq = nextSeq++;
    const { body, sig } = buildHeartbeat(ctx.pair, ctx.ss58, seq);
    const res = await fetchJson(ctx.app, "POST", "/heartbeats", {
      headers: {
        "x-api-key": ctx.randomApiKey,
        "x-heartbeat-sig": sig,
      },
      jsonBody: body,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", seq });
    expect((res.body as { auth_tier?: string }).auth_tier).toBe("api-key");
  });

  // ------------------------------------------------------------------------
  // 2b. Legacy SS58-as-x-api-key — PROD cert-daemon's current flow.
  //     Regression guard: breaking this would take every attestor's
  //     heartbeat offline until they rotate to a Bearer token.
  // ------------------------------------------------------------------------
  test("test_heartbeat_accepts_legacy_x_api_key_ss58", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation((() => {}) as (...args: unknown[]) => void);
    try {
      const seq = nextSeq++;
      const { body, sig } = buildHeartbeat(ctx.pair, ctx.ss58, seq);
      const res = await fetchJson(ctx.app, "POST", "/heartbeats", {
        headers: {
          "x-api-key": ctx.legacyApiKey,
          "x-heartbeat-sig": sig,
        },
        jsonBody: body,
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "ok", seq });
      expect((res.body as { auth_tier?: string }).auth_tier).toBe("api-key-legacy-ss58");

      // The deprecated-ss58-auth warn-log must fire so we can track
      // migration progress via `kubectl logs | grep deprecated-ss58-auth`.
      const calls = (warn.mock.calls as unknown[][]).map((c) => c.join(" "));
      expect(calls.some((m) => m.includes("deprecated-ss58-auth"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  // ------------------------------------------------------------------------
  // 3. Keyless x-heartbeat-sig flow still works (registered validator,
  //    no account-auth headers at all)
  // ------------------------------------------------------------------------
  test("test_heartbeat_accepts_x_heartbeat_sig_only", async () => {
    const seq = nextSeq++;
    const { body, sig } = buildHeartbeat(ctx.pair, ctx.ss58, seq);
    const res = await fetchJson(ctx.app, "POST", "/heartbeats", {
      headers: { "x-heartbeat-sig": sig },
      jsonBody: body,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", seq });
    expect((res.body as { auth_tier?: string }).auth_tier).toBe("sig-only");
  });

  // ------------------------------------------------------------------------
  // 4. No auth at all → 403 (unregistered validator branch). An
  //    unregistered account with no Bearer/api-key can't backdoor the
  //    heartbeat ingest even if they can sign a payload.
  // ------------------------------------------------------------------------
  test("test_heartbeat_rejects_no_auth_unregistered_validator", async () => {
    // Re-setup without registering — forces the sig-path lookupValidatorInfo
    // to return null.
    config.storagePath = ctx.prevStoragePath;
    rmSync(ctx.tmpStorage, { recursive: true, force: true });
    ctx = await setupApp({ registerValidator: false });

    const seq = nextSeq++;
    const { body, sig } = buildHeartbeat(ctx.pair, ctx.ss58, seq);
    const res = await fetchJson(ctx.app, "POST", "/heartbeats", {
      headers: { "x-heartbeat-sig": sig },
      jsonBody: body,
    });
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/not registered/i);
  });

  // ------------------------------------------------------------------------
  // 5. Missing x-heartbeat-sig with a Bearer present → 400. The Bearer
  //    authenticates the ACCOUNT; the sig is what binds this specific
  //    heartbeat payload to the key. Dropping the sig would let anyone
  //    with the Bearer replay arbitrary payloads.
  // ------------------------------------------------------------------------
  test("test_heartbeat_rejects_bearer_without_heartbeat_sig", async () => {
    const seq = nextSeq++;
    const { body } = buildHeartbeat(ctx.pair, ctx.ss58, seq);
    const res = await fetchJson(ctx.app, "POST", "/heartbeats", {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
      jsonBody: body,
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/x-heartbeat-sig/);
  });

  // ------------------------------------------------------------------------
  // 6. Revoked Bearer → 401. Mirrors upload-auth.test.ts' revocation test.
  // ------------------------------------------------------------------------
  test("test_heartbeat_rejects_revoked_bearer", async () => {
    const tokenHash = createHash("sha256").update(ctx.bearerToken).digest("hex");
    ctx.tokensDb
      .prepare(
        `UPDATE api_tokens SET revoked_at = ?, revoked_reason = 'test' WHERE token_hash = ?`,
      )
      .run(Math.floor(Date.now() / 1000), tokenHash);

    const seq = nextSeq++;
    const { body, sig } = buildHeartbeat(ctx.pair, ctx.ss58, seq);
    const res = await fetchJson(ctx.app, "POST", "/heartbeats", {
      headers: {
        authorization: `Bearer ${ctx.bearerToken}`,
        "x-heartbeat-sig": sig,
      },
      jsonBody: body,
    });
    expect(res.status).toBe(401);
    const err = (res.body as { error: string }).error;
    expect(err.toLowerCase()).toContain("revoked");
  });

  // ------------------------------------------------------------------------
  // 7. Bad x-api-key → 401 with the legacy wire-format error message.
  //    cert-daemon clients parse this exact string to distinguish auth
  //    failures from other 4xx modes.
  // ------------------------------------------------------------------------
  test("test_heartbeat_bad_x_api_key_returns_legacy_401_message", async () => {
    const seq = nextSeq++;
    const { body, sig } = buildHeartbeat(ctx.pair, ctx.ss58, seq);
    const res = await fetchJson(ctx.app, "POST", "/heartbeats", {
      headers: {
        "x-api-key": "not-a-valid-key-at-all",
        "x-heartbeat-sig": sig,
      },
      jsonBody: body,
    });
    expect(res.status).toBe(401);
    const err = (res.body as { error: string }).error;
    expect(err).toBe("Invalid or disabled API key");
  });

  // ------------------------------------------------------------------------
  // 8. Bearer with MISMATCHED validator_id in body → 403. The Bearer
  //    token binds to a specific SS58; the body can't claim to be
  //    someone else.
  // ------------------------------------------------------------------------
  test("test_heartbeat_rejects_bearer_with_mismatched_validator_id", async () => {
    // Build a body for a different SS58 entirely, signed by a different
    // key so the sig is still valid for THAT payload — the test is that
    // the binding check trips BEFORE the sig check.
    const otherKeyring = new Keyring({ type: "sr25519" });
    const otherPair = otherKeyring.addFromUri("//OtherValidator");
    const otherSs58 = otherPair.address;

    const seq = nextSeq++;
    const { body, sig } = buildHeartbeat(otherPair, otherSs58, seq);

    const res = await fetchJson(ctx.app, "POST", "/heartbeats", {
      headers: {
        authorization: `Bearer ${ctx.bearerToken}`, // Bearer is for ctx.ss58
        "x-heartbeat-sig": sig,
      },
      jsonBody: body,
    });
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/does not match/i);
  });
});
