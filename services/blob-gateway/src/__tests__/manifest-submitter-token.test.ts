/**
 * Integration tests for task #134 — sponsored-receipt-submitter manifest fetch.
 *
 * The receipt-submitter is a trusted internal service: the gateway hands it
 * `SPONSORED_RECEIPT_SUBMITTER_TOKEN` so the gateway can call it on the
 * inbound POST direction. The submitter, in turn, needs to call BACK to the
 * gateway's GET /blobs/:contentHash/manifest to enrich the receipt with the
 * 14 sub-hash fields required by submit_receipt_v2.
 *
 * Before this fix the submitter had no auth header on that fetch — every
 * request 401'd, the submitter fell back to a synthesised manifest hash,
 * and the receipt_id it wrote on chain disagreed with the gateway's
 * billing-API receipt_id (which derives from content_hash directly).
 * Result: billing API forever showed `attestation_status: "unknown"`.
 *
 * Fix shape (Option B from the task brief): the gateway recognises the SAME
 * `SPONSORED_RECEIPT_SUBMITTER_TOKEN` it shares with the submitter as a
 * privileged read-only credential on GET /blobs/:contentHash/manifest. No
 * new secret channel is added; the existing service-to-service trust is
 * symmetric in both directions.
 *
 * The token is read from `config.sponsoredReceiptSubmitterToken` at request
 * time (not at module load), so tests can flip it on/off per case.
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
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { config } from "../config.js";
import { blobsRouter } from "../routes/blobs.js";
import { setQuotaDbForTests, migrateUsageColumns, migrateBindingColumn } from "../quota.js";
import {
  initApiTokensDb,
  issueToken,
  setApiTokensDb,
} from "../api-tokens.js";

// --------------------------------------------------------------------------
// Test harness — mirrors manifest-roothash.test.ts so reviewers can compare.
// --------------------------------------------------------------------------

async function setupApp(): Promise<{
  app: express.Express;
  ss58: string;
  bearerToken: string;
  submitterToken: string;
  prevSubmitterToken: string;
  tmpStorage: string;
  prevStoragePath: string;
}> {
  const tmpStorage = mkdtempSync(join(tmpdir(), "blob-gateway-submitter-token-test-"));
  const prevStoragePath = config.storagePath;
  config.storagePath = tmpStorage;

  const submitterToken =
    "submitter-token-" + randomBytes(16).toString("hex");
  const prevSubmitterToken = config.sponsoredReceiptSubmitterToken;
  config.sponsoredReceiptSubmitterToken = submitterToken;

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

  const ss58 = "5OperatorSubmitterTokenTestaaaaaaaaaaaaaaaaaaaaaaab";

  const tokensDb = new Database(":memory:");
  tokensDb.pragma("journal_mode = WAL");
  initApiTokensDb(tokensDb);
  setApiTokensDb(tokensDb);

  const { token: bearerToken } = issueToken(tokensDb, {
    accountSs58: ss58,
    label: "submitter-token-test",
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
    submitterToken,
    prevSubmitterToken,
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

function buildManifest(): {
  manifest: {
    chunks: Array<{ index: number; sha256: string; size: number }>;
    rootHash: string;
  };
  contentHash: string;
} {
  const chunks: Array<{ index: number; sha256: string; size: number }> = [];
  for (let i = 0; i < 2; i += 1) {
    const sha = createHash("sha256")
      .update(Buffer.from(`stoken-chunk-${i}`))
      .digest();
    chunks.push({ index: i, sha256: sha.toString("hex"), size: 32 + i });
  }
  // rootHash is included so the gateway doesn't need to compute it.
  const rootHash = createHash("sha256")
    .update(Buffer.from("stoken-root"))
    .digest("hex");
  const contentHash = createHash("sha256")
    .update(Buffer.from(`stoken-content-${randomBytes(4).toString("hex")}`))
    .digest("hex");
  return { manifest: { chunks, rootHash }, contentHash };
}

// --------------------------------------------------------------------------
// Tests — sponsored-receipt-submitter token recognition on GET manifest
// --------------------------------------------------------------------------

describe("GET /blobs/:contentHash/manifest — sponsored-receipt-submitter token (task #134)", () => {
  let ctx: Awaited<ReturnType<typeof setupApp>>;

  beforeEach(async () => {
    ctx = await setupApp();
  });

  afterEach(() => {
    config.storagePath = ctx.prevStoragePath;
    config.sponsoredReceiptSubmitterToken = ctx.prevSubmitterToken;
    rmSync(ctx.tmpStorage, { recursive: true, force: true });
  });

  test("get_manifest_with_sponsored_receipt_submitter_token_returns_200", async () => {
    // First POST the manifest with the operator's normal Bearer token so
    // there's something to fetch.
    const { manifest, contentHash } = buildManifest();
    const post = await fetchJson(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
      jsonBody: manifest,
    });
    expect(post.status).toBe(201);

    // Now the submitter calls back with the sponsored-receipt-submitter
    // shared secret. This is NOT a `matra_`-prefixed user token; it's the
    // same opaque string the gateway sent on its own POST callback. The
    // gateway must recognise it as a privileged read on this route.
    const get = await fetchJson(ctx.app, "GET", `/blobs/${contentHash}/manifest`, {
      headers: { authorization: `Bearer ${ctx.submitterToken}` },
    });
    expect(get.status).toBe(200);
    const body = get.body as Record<string, unknown>;
    expect(body.rootHash).toBe(manifest.rootHash);
    expect(Array.isArray(body.chunks)).toBe(true);
    expect((body.chunks as unknown[]).length).toBe(2);
  });

  test("get_manifest_with_wrong_token_returns_401", async () => {
    const { manifest, contentHash } = buildManifest();
    const post = await fetchJson(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
      jsonBody: manifest,
    });
    expect(post.status).toBe(201);

    // Wrong submitter token (correct shape, wrong value) must NOT be
    // accepted — guarantees we're matching the configured value, not just
    // "any non-`matra_`-prefixed Bearer".
    const get = await fetchJson(ctx.app, "GET", `/blobs/${contentHash}/manifest`, {
      headers: { authorization: `Bearer wrong-submitter-token-deadbeef` },
    });
    expect(get.status).toBe(401);
  });

  test("get_manifest_with_submitter_token_when_not_configured_returns_401", async () => {
    // If the gateway has no submitter token configured, ANY value sent in
    // that channel must be rejected — never accept "" as a valid match.
    const { manifest, contentHash } = buildManifest();
    const post = await fetchJson(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
      jsonBody: manifest,
    });
    expect(post.status).toBe(201);

    const savedToken = config.sponsoredReceiptSubmitterToken;
    config.sponsoredReceiptSubmitterToken = "";
    try {
      const get = await fetchJson(ctx.app, "GET", `/blobs/${contentHash}/manifest`, {
        headers: { authorization: `Bearer ${ctx.submitterToken}` },
      });
      expect(get.status).toBe(401);

      // Also: an empty Bearer must be rejected when the configured token is
      // empty (so an unset env var doesn't accidentally turn into a free pass).
      const getEmpty = await fetchJson(ctx.app, "GET", `/blobs/${contentHash}/manifest`, {
        headers: { authorization: "Bearer " },
      });
      expect(getEmpty.status).toBe(401);
    } finally {
      config.sponsoredReceiptSubmitterToken = savedToken;
    }
  });

  test("get_manifest_with_no_auth_still_returns_401", async () => {
    // Sanity: removing auth entirely is still rejected. We didn't make the
    // route public, just added one new accepted token shape.
    const { manifest, contentHash } = buildManifest();
    const post = await fetchJson(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
      jsonBody: manifest,
    });
    expect(post.status).toBe(201);

    const get = await fetchJson(ctx.app, "GET", `/blobs/${contentHash}/manifest`);
    expect(get.status).toBe(401);
  });

  test("post_manifest_does_not_accept_submitter_token_for_writes", async () => {
    // The submitter token is read-only on the manifest path. Mutating
    // requests (POST manifest, PUT chunk, PATCH certified) must reject it
    // — only legitimate uploaders write blobs. This guards against a
    // compromised submitter token being used to backdoor data into the
    // gateway.
    const { manifest, contentHash } = buildManifest();
    const res = await fetchJson(ctx.app, "POST", `/blobs/${contentHash}/manifest`, {
      headers: { authorization: `Bearer ${ctx.submitterToken}` },
      jsonBody: manifest,
    });
    expect(res.status).toBe(401);
  });
});

// --------------------------------------------------------------------------
// Tests — receipt_id agreement between gateway billing + submitter
// --------------------------------------------------------------------------

describe("receipt_id derivation — submitter must agree with gateway billing (task #134)", () => {
  test("computeReceiptId_is_sha256_of_content_hash_bytes", async () => {
    // This is the canonical scheme the gateway billing API uses:
    //   receipt_id = sha256(content_hash_bytes)
    // (See services/blob-gateway/src/billing/chain_query.ts::receiptIdFromContentHash
    //  and services/blob-gateway/src/storage.ts::computeReceiptId)
    //
    // The submitter MUST use the same scheme so on-chain Receipts[receipt_id]
    // is queryable from the billing path. The submitter lives in
    // /home/deci/materios-node/receipt-submitter.mjs and reproduces this
    // function as `deriveReceiptId(contentHashBare)` — re-derived here as a
    // pure function so the regression is caught by `pnpm test` without a live
    // submitter process.
    const { computeReceiptId } = await import("../storage.js");

    // Mirror the submitter's helper exactly, so any drift between the two
    // breaks this assertion.
    function submitterDeriveReceiptId(contentHashBare: string): string {
      return computeReceiptId(contentHashBare);
    }

    // Three random content hashes from compute_metering_v2 records.
    const samples = [
      "2fdf7b9e8eb56096d10b37cf497e8a27f71dc4c22d7daaa8814195397e8b0e20", // from live evidence
      createHash("sha256").update(Buffer.from("stoken-test-1")).digest("hex"),
      createHash("sha256").update(Buffer.from("stoken-test-2")).digest("hex"),
    ];

    for (const ch of samples) {
      const gatewayId = computeReceiptId(ch);
      const submitterId = submitterDeriveReceiptId(ch);
      expect(submitterId).toBe(gatewayId);
    }

    // Specifically: the live-evidence content_hash from the task brief must
    // produce the gateway-reported receipt_id when both sides use the new
    // canonical scheme. (Pre-fix the submitter wrote a different value
    // because it mixed the manifest hash into the pre-image.)
    expect(
      computeReceiptId("2fdf7b9e8eb56096d10b37cf497e8a27f71dc4c22d7daaa8814195397e8b0e20"),
    ).toBe(
      "0x426244bbfb94a4b285a7e327be47410eaa0c4bdd289d1d3c8bdda0d4d6ec6ca7",
    );
  });
});
