/**
 * Integration tests for task #93: server-side rootHash compute on POST
 * manifest, and the new GET /blobs/:contentHash/manifest endpoint.
 *
 * Two-sided fix paired with task #60 (cert-daemon-side zero-default
 * protection): when a thin SDK client (e.g. Penny's OpenHome DevKit
 * daemon) omits `manifest.rootHash`, the gateway must compute it
 * server-side using the SAME chunk-Merkle algorithm the cert-daemon uses,
 * otherwise the on-chain `base_root_sha256` mismatches and the pallet
 * rejects with `CertHashMismatch`. The GET endpoint complements the
 * receipt-submitter's existing fallback path of fetching manifests by
 * contentHash.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

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
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { config } from "../config.js";
import { blobsRouter } from "../routes/blobs.js";
import { setQuotaDbForTests, migrateUsageColumns } from "../quota.js";
import {
  initApiTokensDb,
  issueToken,
  setApiTokensDb,
} from "../api-tokens.js";
import { merkleRoot } from "../merkle.js";

// --------------------------------------------------------------------------
// Test harness — mirrors upload-auth.test.ts so reviewers can compare.
// --------------------------------------------------------------------------

async function setupApp(): Promise<{
  app: express.Express;
  ss58: string;
  bearerToken: string;
  randomApiKey: string;
  tokensDb: Database.Database;
  quotaDb: Database.Database;
  tmpStorage: string;
  prevStoragePath: string;
}> {
  const tmpStorage = mkdtempSync(join(tmpdir(), "blob-gateway-roothash-test-"));
  const prevStoragePath = config.storagePath;
  config.storagePath = tmpStorage;

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
  setQuotaDbForTests(quotaDb);

  const ss58 = "5OperatorRoothashTestaaaaaaaaaaaaaaaaaaaaaaaaab";

  const randomApiKey = randomBytes(32).toString("hex");
  const randomKeyHash = createHash("sha256").update(randomApiKey).digest("hex");
  quotaDb
    .prepare(
      `INSERT INTO api_keys
       (key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads, validator_id)
       VALUES (?, 'roothash-test', 1, 100, 1073741824, 5, ?)`,
    )
    .run(randomKeyHash, ss58);

  const tokensDb = new Database(":memory:");
  tokensDb.pragma("journal_mode = WAL");
  initApiTokensDb(tokensDb);
  setApiTokensDb(tokensDb);

  const { token: bearerToken } = issueToken(tokensDb, {
    accountSs58: ss58,
    label: "roothash-test",
  });

  const app = express();
  app.put(
    "/blobs/:contentHash/chunks/:i",
    express.raw({ type: "*/*", limit: `${config.maxChunkBytes}` }),
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(blobsRouter);

  return {
    app,
    ss58,
    bearerToken,
    randomApiKey,
    tokensDb,
    quotaDb,
    tmpStorage,
    prevStoragePath,
  };
}

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

/** Build a manifest with N chunks. Each chunk's sha256 is deterministic. */
function buildManifest(n: number, includeRootHash = true): {
  manifest: { chunks: Array<{ index: number; sha256: string; size: number }>; rootHash?: string };
  contentHash: string;
  expectedRoot: string;
} {
  const chunks = [];
  const leaves: Buffer[] = [];
  for (let i = 0; i < n; i += 1) {
    const sha = createHash("sha256")
      .update(Buffer.from(`chunk-${i}-payload`))
      .digest();
    chunks.push({ index: i, sha256: sha.toString("hex"), size: 32 + i });
    leaves.push(sha);
  }
  const expectedRoot = merkleRoot(leaves).toString("hex");
  // contentHash needn't be the merkle root in the gateway — it's just the
  // url path identifier — but using a distinct fresh SHA keeps tests
  // independent.
  const contentHash = createHash("sha256")
    .update(Buffer.from(`manifest-${n}-${randomBytes(4).toString("hex")}`))
    .digest("hex");
  const manifest: { chunks: typeof chunks; rootHash?: string } = { chunks };
  if (includeRootHash) {
    manifest.rootHash = expectedRoot;
  }
  return { manifest, contentHash, expectedRoot };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("POST /blobs/:contentHash/manifest — server-side rootHash compute (task #93)", () => {
  let ctx: Awaited<ReturnType<typeof setupApp>>;

  beforeEach(async () => {
    ctx = await setupApp();
  });

  afterEach(() => {
    config.storagePath = ctx.prevStoragePath;
    rmSync(ctx.tmpStorage, { recursive: true, force: true });
  });

  test("client_omits_rootHash_gateway_computes_and_persists_it", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { manifest, contentHash, expectedRoot } = buildManifest(3, false);
      // Sanity: manifest does NOT contain rootHash.
      expect(
        (manifest as Record<string, unknown>).rootHash,
      ).toBeUndefined();

      const res = await fetchJson(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
        headers: { authorization: `Bearer ${ctx.bearerToken}` },
        jsonBody: manifest,
      });
      expect(res.status).toBe(201);

      // Persisted manifest on disk should now carry the computed rootHash.
      const stored = JSON.parse(
        readFileSync(
          join(ctx.tmpStorage, "receipts", contentHash, "manifest.json"),
          "utf-8",
        ),
      );
      expect(stored.rootHash).toBe(expectedRoot);

      // Telemetry: an info-level "computed server-side" line was emitted.
      const calls = (logSpy.mock.calls as unknown[][]).map((c) => c.join(" "));
      expect(
        calls.some((m) => m.includes("rootHash absent in manifest") && m.includes(expectedRoot)),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("client_supplied_rootHash_is_preserved_verbatim", async () => {
    const { manifest, contentHash, expectedRoot } = buildManifest(2, true);
    expect(manifest.rootHash).toBe(expectedRoot);
    const res = await fetchJson(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
      jsonBody: manifest,
    });
    expect(res.status).toBe(201);
    const stored = JSON.parse(
      readFileSync(
        join(ctx.tmpStorage, "receipts", contentHash, "manifest.json"),
        "utf-8",
      ),
    );
    expect(stored.rootHash).toBe(expectedRoot);
  });

  test("client_supplied_rootHash_disagreeing_with_compute_logs_warning_keeps_client_value", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { manifest, contentHash, expectedRoot } = buildManifest(2, true);
      const wrongRoot = "f".repeat(64);
      manifest.rootHash = wrongRoot;
      const res = await fetchJson(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
        headers: { authorization: `Bearer ${ctx.bearerToken}` },
        jsonBody: manifest,
      });
      expect(res.status).toBe(201);

      const stored = JSON.parse(
        readFileSync(
          join(ctx.tmpStorage, "receipts", contentHash, "manifest.json"),
          "utf-8",
        ),
      );
      // Client value preserved — gateway does NOT silently overwrite a
      // valid-shape client root, even if it disagrees with the compute.
      expect(stored.rootHash).toBe(wrongRoot);
      expect(stored.rootHash).not.toBe(expectedRoot);

      const calls = (warnSpy.mock.calls as unknown[][]).map((c) => c.join(" "));
      expect(calls.some((m) => m.includes("rootHash drift") && m.includes(expectedRoot))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("client_supplied_invalid_rootHash_replaced_with_server_compute", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { manifest, contentHash, expectedRoot } = buildManifest(2, true);
      manifest.rootHash = "not-a-hex-string";
      const res = await fetchJson(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
        headers: { authorization: `Bearer ${ctx.bearerToken}` },
        jsonBody: manifest,
      });
      expect(res.status).toBe(201);

      const stored = JSON.parse(
        readFileSync(
          join(ctx.tmpStorage, "receipts", contentHash, "manifest.json"),
          "utf-8",
        ),
      );
      // Invalid-shape rootHash is replaced with the server-side compute —
      // an invalid value is worse than a missing one.
      expect(stored.rootHash).toBe(expectedRoot);

      const calls = (warnSpy.mock.calls as unknown[][]).map((c) => c.join(" "));
      expect(
        calls.some((m) => m.includes("not valid 64-hex") && m.includes("replacing with server-side compute")),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("single_chunk_manifest_root_equals_chunk_sha", async () => {
    // Edge case: single chunk → root IS the leaf, no hashing.
    const { manifest, contentHash } = buildManifest(1, false);
    const expectedRoot = manifest.chunks[0].sha256;
    const res = await fetchJson(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
      jsonBody: manifest,
    });
    expect(res.status).toBe(201);
    const stored = JSON.parse(
      readFileSync(
        join(ctx.tmpStorage, "receipts", contentHash, "manifest.json"),
        "utf-8",
      ),
    );
    expect(stored.rootHash).toBe(expectedRoot);
  });

  test("empty_chunks_array_does_not_attempt_compute_or_break", async () => {
    // An empty-chunks manifest is a no-op for compute — we don't assign a
    // root from a degenerate input. Auth still gates and the manifest still
    // saves; the upload simply never completes.
    const contentHash = createHash("sha256").update(Buffer.from("empty-test")).digest("hex");
    const manifest = { chunks: [] as Array<unknown> };
    const res = await fetchJson(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
      jsonBody: manifest,
    });
    expect(res.status).toBe(201);
    const stored = JSON.parse(
      readFileSync(
        join(ctx.tmpStorage, "receipts", contentHash, "manifest.json"),
        "utf-8",
      ),
    );
    expect(stored.rootHash).toBeUndefined();
  });
});

describe("GET /blobs/:contentHash/manifest — new endpoint (task #93)", () => {
  let ctx: Awaited<ReturnType<typeof setupApp>>;

  beforeEach(async () => {
    ctx = await setupApp();
  });

  afterEach(() => {
    config.storagePath = ctx.prevStoragePath;
    rmSync(ctx.tmpStorage, { recursive: true, force: true });
  });

  test("get_returns_200_with_stored_manifest_body_when_authenticated_with_bearer", async () => {
    const { manifest, contentHash, expectedRoot } = buildManifest(3, true);
    const post = await fetchJson(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
      jsonBody: manifest,
    });
    expect(post.status).toBe(201);

    const get = await fetchJson(ctx.app, "GET", `/blobs/${contentHash}/manifest`, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
    });
    expect(get.status).toBe(200);
    const body = get.body as Record<string, unknown>;
    expect(body.rootHash).toBe(expectedRoot);
    expect(Array.isArray(body.chunks)).toBe(true);
    expect((body.chunks as unknown[]).length).toBe(3);
  });

  test("get_returns_200_after_server_side_compute_carrying_computed_root", async () => {
    // POST without rootHash → gateway computes → GET sees the populated
    // value. This is the critical path for thin SDK clients.
    const { manifest, contentHash, expectedRoot } = buildManifest(4, false);
    expect((manifest as Record<string, unknown>).rootHash).toBeUndefined();

    const post = await fetchJson(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
      jsonBody: manifest,
    });
    expect(post.status).toBe(201);

    const get = await fetchJson(ctx.app, "GET", `/blobs/${contentHash}/manifest`, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
    });
    expect(get.status).toBe(200);
    const body = get.body as Record<string, unknown>;
    expect(body.rootHash).toBe(expectedRoot);
  });

  test("get_returns_404_when_manifest_does_not_exist", async () => {
    const fakeHash = createHash("sha256")
      .update(Buffer.from("never-uploaded"))
      .digest("hex");
    const res = await fetchJson(ctx.app, "GET", `/blobs/${fakeHash}/manifest`, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
    });
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  test("get_returns_401_when_unauthenticated", async () => {
    const { manifest, contentHash } = buildManifest(2, true);
    const post = await fetchJson(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
      jsonBody: manifest,
    });
    expect(post.status).toBe(201);

    const get = await fetchJson(ctx.app, "GET", `/blobs/${contentHash}/manifest`);
    expect(get.status).toBe(401);
    expect(get.body).toHaveProperty("error");
  });

  test("get_works_with_legacy_x_api_key_too", async () => {
    const { manifest, contentHash } = buildManifest(1, true);
    const post = await fetchJson(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
      headers: { "x-api-key": ctx.randomApiKey },
      jsonBody: manifest,
    });
    expect(post.status).toBe(201);

    const get = await fetchJson(ctx.app, "GET", `/blobs/${contentHash}/manifest`, {
      headers: { "x-api-key": ctx.randomApiKey },
    });
    expect(get.status).toBe(200);
  });
});
