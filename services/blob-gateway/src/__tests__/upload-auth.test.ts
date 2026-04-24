/**
 * Integration tests for the unified auth path on blob UPLOAD endpoints:
 *
 *   POST /blobs/:contentHash/manifest
 *   PUT  /blobs/:contentHash/chunks/:i
 *
 * PR #6 shipped Bearer tokens for /auth/* and /blobs/:hash/certified but the
 * upload handlers in routes/blobs.ts were still reading x-api-key directly,
 * so operators minting a Bearer token got 401 on the very endpoints they
 * needed to hit. This test suite locks in the fix: Bearer, legacy x-api-key,
 * and sr25519 upload-sig all reach the quota layer via a single resolveAuth()
 * call, with the same 401/403/429 shapes the Penny client already parses.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// rpc-client opens a WebSocket to a chain RPC in production. Tests must never
// try to touch that; stub checkFunded so the sig-only path is deterministic
// and doesn't hang. Use `{ amount: "*" }` matcher-equivalent via vi.mock with
// a factory — fresh for every test.
vi.mock("../rpc-client.js", () => ({
  checkFunded: vi.fn(async () => true),
  checkReceiptStatus: vi.fn(async () => "not_found" as const),
  disconnectRpc: vi.fn(async () => {}),
}));

// storage.ts does fs writes under config.storagePath. notify.ts posts to a
// daemon when uploads complete — no-op it in tests so we don't need a mock
// HTTP server just to record chunks.
vi.mock("../notify.js", () => ({
  notifyDaemon: vi.fn(async () => {}),
}));

import express from "express";
import Database from "better-sqlite3";
import { createHash, randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cryptoWaitReady, signatureVerify } from "@polkadot/util-crypto";
import { Keyring } from "@polkadot/api";
import { u8aToHex, stringToU8a } from "@polkadot/util";

import { config } from "../config.js";
import { blobsRouter } from "../routes/blobs.js";
import { setQuotaDbForTests, migrateUsageColumns } from "../quota.js";
import {
  initApiTokensDb,
  issueToken,
  setApiTokensDb,
} from "../api-tokens.js";

// --------------------------------------------------------------------------
// Test harness
// --------------------------------------------------------------------------

async function setupApp(opts: { registerOperator?: boolean } = {}): Promise<{
  app: express.Express;
  ss58: string;
  legacyApiKey: string;
  randomApiKey: string;
  bearerToken: string;
  tokensDb: Database.Database;
  quotaDb: Database.Database;
  tmpStorage: string;
  prevStoragePath: string;
}> {
  // --- fs: point storage at a throwaway temp dir ---
  const tmpStorage = mkdtempSync(join(tmpdir(), "blob-gateway-upload-test-"));
  const prevStoragePath = config.storagePath;
  config.storagePath = tmpStorage;

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
  // Phase 1 billing: add lifetime_* columns so recordUsage() from the
  // manifest/chunk handlers has a column to UPDATE. Without this, the
  // in-test handler emits a warn-log ("no such column: lifetime_receipts")
  // which is harmless but noisy — the production initQuotaDb does the
  // same migration automatically.
  migrateUsageColumns(quotaDb);
  setQuotaDbForTests(quotaDb);

  // SS58-shape account used by both Bearer and legacy-SS58-as-API-key tests.
  const ss58 = "5OperatorUploadAuthTestaaaaaaaaaaaaaaaaaaaaaaab";

  // Random per-operator api key (the "real" production pattern — 64 hex).
  const randomApiKey = randomBytes(32).toString("hex");
  const randomKeyHash = createHash("sha256").update(randomApiKey).digest("hex");

  if (opts.registerOperator !== false) {
    quotaDb
      .prepare(
        `INSERT INTO api_keys
         (key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads, validator_id)
         VALUES (?, 'operator-test', 1, 100, 1073741824, 5, ?)`,
      )
      .run(randomKeyHash, ss58);

    // Legacy SS58-as-API-key: hash(ss58) also stored, validator_id = ss58.
    const legacyKeyHash = createHash("sha256").update(ss58).digest("hex");
    quotaDb
      .prepare(
        `INSERT INTO api_keys
         (key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads, validator_id)
         VALUES (?, 'operator-test-legacy', 1, 100, 1073741824, 5, ?)`,
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
    label: "upload-auth-test",
  });

  // --- Express app wired to the real blobsRouter ---
  const app = express();
  // Raw body parser for chunk uploads (mirrors production index.ts ordering).
  app.put(
    "/blobs/:contentHash/chunks/:i",
    express.raw({ type: "*/*", limit: `${config.maxChunkBytes}` }),
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(blobsRouter);

  return {
    app,
    ss58,
    legacyApiKey: ss58,
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

/**
 * Build a manifest body for a known payload. Returns the manifest, the
 * single chunk buffer, and the contentHash (sha256 of the chunk as hex — we
 * don't care about cryptographic fidelity here, just that the gateway's
 * own SHA-256 verification passes).
 */
function buildSingleChunkManifest(payload = Buffer.from("hello-world")): {
  manifest: { chunks: Array<{ index: number; sha256: string; size: number }> };
  chunk: Buffer;
  contentHash: string;
} {
  const sha = createHash("sha256").update(payload).digest("hex");
  return {
    manifest: { chunks: [{ index: 0, sha256: sha, size: payload.length }] },
    chunk: payload,
    contentHash: sha, // SHA-256 of the one chunk is a fine stand-in content hash
  };
}

describe("upload endpoints: unified auth (Bearer / x-api-key / sig)", () => {
  let ctx: Awaited<ReturnType<typeof setupApp>>;

  beforeEach(async () => {
    ctx = await setupApp();
  });

  afterEach(() => {
    config.storagePath = ctx.prevStoragePath;
    rmSync(ctx.tmpStorage, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------------
  // 1. Bearer accepted on manifest POST
  // ------------------------------------------------------------------------
  test("bearer_accepted_on_manifest_post_returns_201_ok", async () => {
    const { manifest, contentHash } = buildSingleChunkManifest();
    const res = await fetchJson(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
      jsonBody: manifest,
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: "ok", contentHash });
    // Print the happy-path response so the PR report can quote literal JSON.
    // eslint-disable-next-line no-console
    console.log(
      `[upload-auth-test] bearer_manifest_success status=${res.status} body=${JSON.stringify(res.body)}`,
    );
  });

  // ------------------------------------------------------------------------
  // 2. Bearer accepted on chunk PUT
  // ------------------------------------------------------------------------
  test("bearer_accepted_on_chunk_put_returns_200_ok", async () => {
    const { manifest, chunk, contentHash } = buildSingleChunkManifest();
    const manifestRes = await fetchJson(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
      jsonBody: manifest,
    });
    expect(manifestRes.status).toBe(201);

    const chunkRes = await fetchJson(ctx.app, "PUT", `/blobs/${contentHash}/chunks/0`, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
      rawBody: chunk,
    });
    expect(chunkRes.status).toBe(200);
    expect(chunkRes.body).toEqual({ status: "ok", chunkIndex: 0 });
  });

  // ------------------------------------------------------------------------
  // 3. Legacy x-api-key (random hex) still works — regression guard
  // ------------------------------------------------------------------------
  test("legacy_x_api_key_still_works_on_upload", async () => {
    const { manifest, chunk, contentHash } = buildSingleChunkManifest();
    const manifestRes = await fetchJson(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
      headers: { "x-api-key": ctx.randomApiKey },
      jsonBody: manifest,
    });
    expect(manifestRes.status).toBe(201);

    const chunkRes = await fetchJson(ctx.app, "PUT", `/blobs/${contentHash}/chunks/0`, {
      headers: { "x-api-key": ctx.randomApiKey },
      rawBody: chunk,
    });
    expect(chunkRes.status).toBe(200);
  });

  // ------------------------------------------------------------------------
  // 3b. Legacy SS58-as-API-key still works (deprecation coexistence window)
  // ------------------------------------------------------------------------
  test("legacy_ss58_as_api_key_still_works_on_upload", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation((() => {}) as (...args: unknown[]) => void);
    try {
      const { manifest, contentHash } = buildSingleChunkManifest();
      const res = await fetchJson(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
        headers: { "x-api-key": ctx.legacyApiKey },
        jsonBody: manifest,
      });
      expect(res.status).toBe(201);
      // deprecated-ss58-auth warn-log fires in resolveAuth
      const calls = (warn.mock.calls as unknown[][]).map((c) => c.join(" "));
      expect(calls.some((m) => m.includes("deprecated-ss58-auth"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  // ------------------------------------------------------------------------
  // 4. Sig-only path still works — regression guard
  // ------------------------------------------------------------------------
  test("sig_only_path_still_works_on_upload", async () => {
    await cryptoWaitReady();
    const keyring = new Keyring({ type: "sr25519" });
    // Deterministic seed for reproducibility; any 32-byte seed works.
    const pair = keyring.addFromUri("//SigOnlyUploader");
    const addr = pair.address;

    const { manifest, chunk, contentHash } = buildSingleChunkManifest(Buffer.from("sig-only-hello"));
    const ts = Math.floor(Date.now() / 1000);
    const signingString = `materios-upload-v1|${contentHash}|${addr}|${ts}`;
    const sig = u8aToHex(pair.sign(stringToU8a(signingString)));

    // Sanity: the gateway's signatureVerify should accept this pair too.
    expect(signatureVerify(stringToU8a(signingString), sig, addr).isValid).toBe(true);

    const sigHeaders: Record<string, string> = {
      "x-upload-sig": sig,
      "x-uploader-address": addr,
      "x-upload-ts": String(ts),
    };

    const mres = await fetchJson(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
      headers: sigHeaders,
      jsonBody: manifest,
    });
    expect(mres.status).toBe(201);

    const cres = await fetchJson(ctx.app, "PUT", `/blobs/${contentHash}/chunks/0`, {
      headers: sigHeaders,
      rawBody: chunk,
    });
    expect(cres.status).toBe(200);
  });

  // ------------------------------------------------------------------------
  // 5. Unauthenticated upload → 401
  // ------------------------------------------------------------------------
  test("unauthenticated_upload_returns_401", async () => {
    const { manifest, contentHash } = buildSingleChunkManifest();
    const res = await fetchJson(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
      jsonBody: manifest,
    });
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error");
  });

  // ------------------------------------------------------------------------
  // 6. Bearer + revoked token → 401 (full lifecycle integration)
  // ------------------------------------------------------------------------
  test("revoked_bearer_rejected_with_401_on_upload", async () => {
    // Revoke by hashing the plaintext and updating the tokens DB directly —
    // mirrors what /auth/token/:hash DELETE does in production.
    const tokenHash = createHash("sha256").update(ctx.bearerToken).digest("hex");
    ctx.tokensDb
      .prepare(
        `UPDATE api_tokens SET revoked_at = ?, revoked_reason = 'test' WHERE token_hash = ?`,
      )
      .run(Math.floor(Date.now() / 1000), tokenHash);

    const { manifest, contentHash } = buildSingleChunkManifest();
    const res = await fetchJson(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
      jsonBody: manifest,
    });
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error");
    const err = (res.body as { error: string }).error;
    expect(err.toLowerCase()).toContain("revoked");
  });
});
