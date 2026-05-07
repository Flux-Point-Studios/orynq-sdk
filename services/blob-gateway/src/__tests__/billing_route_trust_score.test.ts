/**
 * Integration tests for task #142 — composite_trust_score on /billing/usage.
 *
 * The chain pallet `pallet-tee-attestation` exposes a per-receipt
 * `CompositeTrustScores` storage map (u8, ValueQuery, default = 0). The
 * gateway billing route must surface that score for every record and a
 * `tee_attested_count` aggregate so customers can tell at a glance how
 * many of their workloads have hardware-backed attestation.
 *
 * The Path C smoke harness (Phase 2) polls this very field — the harness
 * function `_wait_for_anchor` looks for
 *
 *     composite_trust_score >= 1 AND cardano_anchor_tx != null
 *
 * to confirm a Pixel/Samsung TEE-attested run made it onto chain.
 *
 * What this file pins:
 *   - score = 0 from chain → surfaced as 0 (NOT null).
 *   - score = 3 from chain → surfaced verbatim (no clamping or
 *     re-bucketing into {certified, anchored, ...} aggregate buckets).
 *   - chain RPC fails → surfaced as null per record (NOT 0). The
 *     distinction is load-bearing for downstream consumers that wait on
 *     the field becoming non-zero.
 *   - aggregate.tee_attested_count counts records with score >= 1.
 *   - include_records=true plumbs the score per-record via the http handler.
 *
 * What this file does NOT cover (covered elsewhere):
 *   - Live preprod chain query → tested manually + by the Path C harness.
 *   - Pure aggregate math → `billing_aggregate.test.ts`.
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  vi,
} from "vitest";
import express from "express";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Keyring } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";
import { createHash } from "crypto";

import { config } from "../config.js";
import { meteringRouter } from "../routes/metering.js";
import {
  initWorkerBoundsDb,
  setWorkerBoundsDbForTests,
} from "../worker_bounds.js";
import {
  canonicalBody,
  SCHEMA_VERSION,
  type ComputeMeteringV1,
} from "../schemas/compute_metering_v1.js";
import {
  initApiTokensDb,
  setApiTokensDb,
  issueToken,
} from "../api-tokens.js";
import {
  setQuotaDbForTests,
  migrateBindingColumn,
} from "../quota.js";

// Mock the chain RPC layer. The two query helpers are independent at the
// module boundary — we mock both so route tests don't need a live node.
vi.mock("../billing/chain_query.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../billing/chain_query.js")>();
  return {
    ...actual,
    queryReceiptStatuses: vi.fn(),
    queryCompositeTrustScores: vi.fn(),
  };
});

// Mock anchor resolver too (same reasoning as billing_route.test.ts).
vi.mock("../billing/anchor_resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../billing/anchor_resolver.js")>();
  return {
    ...actual,
    resolveAnchorTxs: vi.fn(),
  };
});

import { billingRouter } from "../routes/billing.js";
import {
  queryReceiptStatuses,
  queryCompositeTrustScores,
  type ChainStatus,
  type ChainTrustScore,
} from "../billing/chain_query.js";
import { resolveAnchorTxs } from "../billing/anchor_resolver.js";

const queryReceiptStatusesMock = vi.mocked(queryReceiptStatuses);
const queryCompositeTrustScoresMock = vi.mocked(queryCompositeTrustScores);
const resolveAnchorTxsMock = vi.mocked(resolveAnchorTxs);

let keyring: Keyring;

beforeAll(async () => {
  await cryptoWaitReady();
  keyring = new Keyring({ type: "sr25519" });
});

interface BuildOpts {
  worker_id?: string;
  tenant_id?: string;
  period_start?: number;
  period_end?: number;
  uri?: string;
}

function buildSigned(opts: BuildOpts = {}): ComputeMeteringV1 {
  const pair = keyring.addFromUri(opts.uri ?? "//ComputeWorkerTrust");
  const now = Date.now();
  const period_end = opts.period_end ?? now - 5000;
  const period_start = opts.period_start ?? period_end - 3_600_000;
  const body = {
    schema_version: SCHEMA_VERSION,
    worker_id: opts.worker_id ?? "worker-trust-001",
    tenant_id: opts.tenant_id ?? "tenant-trust-1",
    period_start,
    period_end,
    cpu_seconds: 30,
    ram_gb_hours: 0.5,
    disk_gb_hours: 1,
    net_bytes_in: 1024,
    net_bytes_out: 512,
    gpu_seconds: 0,
    worker_pubkey: u8aToHex(pair.publicKey, undefined, false),
  } as const;
  const cb = canonicalBody(body);
  const sig = u8aToHex(pair.sign(cb), undefined, false);
  return { ...body, worker_signature: sig };
}

interface Ctx {
  app: express.Express;
  storage: string;
  prevStorage: string;
  prevSubmitterUrl: string;
  workerBoundsDb: Database.Database;
  quotaDb: Database.Database;
  tokensDb: Database.Database;
  bearerToken: string;
}

async function setupApp(): Promise<Ctx> {
  const storage = mkdtempSync(join(tmpdir(), "billing-trust-test-"));
  const prevStorage = config.storagePath;
  config.storagePath = storage;

  const prevSubmitterUrl = config.sponsoredReceiptSubmitterUrl;
  config.sponsoredReceiptSubmitterUrl = "";

  const workerBoundsDb = new Database(":memory:");
  initWorkerBoundsDb(workerBoundsDb);
  setWorkerBoundsDbForTests(workerBoundsDb);

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
  migrateBindingColumn(quotaDb);
  setQuotaDbForTests(quotaDb);

  const tokensDb = new Database(":memory:");
  tokensDb.pragma("journal_mode = WAL");
  initApiTokensDb(tokensDb);
  setApiTokensDb(tokensDb);

  const ss58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"; // //Alice
  const tok = issueToken(tokensDb, {
    accountSs58: ss58,
    label: "billing-trust-test",
  });

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(meteringRouter);
  app.use(billingRouter);

  return {
    app,
    storage,
    prevStorage,
    prevSubmitterUrl,
    workerBoundsDb,
    quotaDb,
    tokensDb,
    bearerToken: tok.token,
  };
}

async function teardown(ctx: Ctx): Promise<void> {
  config.storagePath = ctx.prevStorage;
  config.sponsoredReceiptSubmitterUrl = ctx.prevSubmitterUrl;
  rmSync(ctx.storage, { recursive: true, force: true });
  ctx.workerBoundsDb.close();
  ctx.quotaDb.close();
  ctx.tokensDb.close();
}

interface FetchInit {
  headers?: Record<string, string>;
  body?: unknown;
}

async function call(
  app: express.Express,
  method: string,
  path: string,
  init: FetchInit = {},
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
      const headers: Record<string, string> = { ...(init.headers ?? {}) };
      const opts: RequestInit = { method, headers };
      if (init.body !== undefined) {
        headers["content-type"] = "content-type" in headers ? headers["content-type"] : "application/json";
        opts.body = JSON.stringify(init.body);
      }
      fetch(url, opts)
        .then(async (res) => {
          const text = await res.text();
          let parsed: unknown;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          server.close();
          resolve({ status: res.status, body: parsed });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

async function submitOne(
  ctx: Ctx,
  opts: BuildOpts = {},
): Promise<{ content_hash: string }> {
  const r = buildSigned(opts);
  const res = await call(ctx.app, "POST", "/metering/submit", { body: r });
  if (res.status !== 200) {
    throw new Error(
      `submit failed ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }
  return { content_hash: (res.body as { content_hash: string }).content_hash };
}

/** Helper: synthesise a `ChainStatus` row that matches the receipt-id. */
function statusRow(content_hash: string, status: ChainStatus["status"], cert_hash: string | null): ChainStatus {
  return {
    content_hash,
    receipt_id: "0x" + createHash("sha256").update(Buffer.from(content_hash, "hex")).digest("hex"),
    status,
    cert_hash,
  };
}

/** Helper: synthesise a `ChainTrustScore` row. */
function trustRow(content_hash: string, score: number | null): ChainTrustScore {
  return {
    content_hash,
    receipt_id: "0x" + createHash("sha256").update(Buffer.from(content_hash, "hex")).digest("hex"),
    composite_trust_score: score,
  };
}

beforeEach(() => {
  // Base mocks: status all "unknown", trust all null. Specific tests
  // override per-call. Keeps the harness aligned with billing_route.test.ts.
  queryReceiptStatusesMock.mockImplementation(async (hashes) =>
    hashes.map((h) => statusRow(h, "unknown", null)),
  );
  queryCompositeTrustScoresMock.mockImplementation(async (hashes) =>
    hashes.map((h) => trustRow(h, null)),
  );
  resolveAnchorTxsMock.mockImplementation(async (certs) => certs.map(() => null));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /billing/usage — composite_trust_score wiring (task #142)", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  test("composite_trust_score is surfaced as 0 when chain returns 0 (committee-attested baseline)", async () => {
    // Chain says: receipt exists, no TEE evidence yet → 0. The route MUST
    // surface 0, NOT null. Distinguishing 0 from null is the whole point
    // of the field.
    const tenant = "tenant-trust-zero";
    const baseEnd = Date.now() - 60_000;
    const sub = await submitOne(ctx, {
      tenant_id: tenant,
      worker_id: "wkr-zero",
      uri: "//WkrTrustZero",
      period_start: baseEnd - 3_600_000,
      period_end: baseEnd,
    });
    queryCompositeTrustScoresMock.mockImplementation(async (hashes) =>
      hashes.map((h) => trustRow(h, 0)),
    );

    const res = await call(
      ctx.app,
      "GET",
      `/billing/usage?tenant_id=${tenant}&start_ms=${baseEnd - 2 * 3_600_000}&end_ms=${baseEnd + 1000}&include_records=true`,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      records: Array<{ content_hash: string; composite_trust_score: number | null }>;
      aggregate: { tee_attested_count: number };
    };
    expect(body.records).toHaveLength(1);
    expect(body.records[0].content_hash).toBe(sub.content_hash);
    expect(body.records[0].composite_trust_score).toBe(0);
    // 0 does NOT count as TEE-attested.
    expect(body.aggregate.tee_attested_count).toBe(0);
  });

  test("composite_trust_score = 3 (multi-vendor + build) flows through verbatim", async () => {
    // Non-default value path. The route must NOT clamp / re-bucket / drop
    // the score; downstream consumers compare against literal 1..4.
    const tenant = "tenant-trust-three";
    const baseEnd = Date.now() - 60_000;
    const sub = await submitOne(ctx, {
      tenant_id: tenant,
      worker_id: "wkr-three",
      uri: "//WkrTrustThree",
      period_start: baseEnd - 3_600_000,
      period_end: baseEnd,
    });
    queryCompositeTrustScoresMock.mockImplementation(async (hashes) =>
      hashes.map((h) => trustRow(h, 3)),
    );

    const res = await call(
      ctx.app,
      "GET",
      `/billing/usage?tenant_id=${tenant}&start_ms=${baseEnd - 2 * 3_600_000}&end_ms=${baseEnd + 1000}&include_records=true`,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      records: Array<{ content_hash: string; composite_trust_score: number | null }>;
      aggregate: { tee_attested_count: number };
    };
    expect(body.records[0].content_hash).toBe(sub.content_hash);
    expect(body.records[0].composite_trust_score).toBe(3);
    expect(body.aggregate.tee_attested_count).toBe(1);
  });

  test("composite_trust_score is null when chain query failed", async () => {
    // RPC unreachable → trust query returns null per record. The route
    // MUST preserve null (not collapse to 0). The Path C harness reads
    // this field and treats null as "keep waiting", whereas 0 would lie
    // that the chain confirmed no evidence.
    const tenant = "tenant-trust-null";
    const baseEnd = Date.now() - 60_000;
    await submitOne(ctx, {
      tenant_id: tenant,
      worker_id: "wkr-null",
      uri: "//WkrTrustNull",
      period_start: baseEnd - 3_600_000,
      period_end: baseEnd,
    });
    // Trust mock: explicit null. (This is also the default, but
    // we set it explicitly so the test's intent is obvious.)
    queryCompositeTrustScoresMock.mockImplementation(async (hashes) =>
      hashes.map((h) => trustRow(h, null)),
    );

    const res = await call(
      ctx.app,
      "GET",
      `/billing/usage?tenant_id=${tenant}&start_ms=${baseEnd - 2 * 3_600_000}&end_ms=${baseEnd + 1000}&include_records=true`,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      records: Array<{ composite_trust_score: number | null }>;
      aggregate: { tee_attested_count: number };
    };
    expect(body.records[0].composite_trust_score).toBeNull();
    expect(body.aggregate.tee_attested_count).toBe(0);
  });

  test("aggregate tee_attested_count counts only records with score >= 1 (mixed batch)", async () => {
    // Five records, all in one tenant, with mixed trust scores. Aggregate
    // is the only block returned (include_records is false), so this
    // pins the aggregate path explicitly.
    const tenant = "tenant-trust-mixed";
    const baseEnd = Date.now() - 60_000;
    const subs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const s = await submitOne(ctx, {
        tenant_id: tenant,
        worker_id: `wkr-mixed-${i}`,
        uri: `//WkrTrustMixed${i}`,
        period_start: baseEnd - (i + 1) * 3_600_000,
        period_end: baseEnd - i * 3_600_000,
      });
      subs.push(s.content_hash);
    }
    // Scores: [null, 0, 1, 2, 4] — only three (scores >= 1) count.
    const scoreByHash = new Map<string, number | null>();
    scoreByHash.set(subs[0], null);
    scoreByHash.set(subs[1], 0);
    scoreByHash.set(subs[2], 1);
    scoreByHash.set(subs[3], 2);
    scoreByHash.set(subs[4], 4);
    queryCompositeTrustScoresMock.mockImplementation(async (hashes) =>
      hashes.map((h) => trustRow(h, scoreByHash.has(h) ? scoreByHash.get(h)! : null)),
    );

    const res = await call(
      ctx.app,
      "GET",
      `/billing/usage?tenant_id=${tenant}&start_ms=${baseEnd - 10 * 3_600_000}&end_ms=${baseEnd + 1000}`,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      aggregate: { record_count: number; tee_attested_count: number };
    };
    expect(body.aggregate.record_count).toBe(5);
    expect(body.aggregate.tee_attested_count).toBe(3);
  });

  test("include_records=true plumbs trust score per record alongside cardano_anchor_tx", async () => {
    // The Path C harness's headline assertion combines both fields. Pin
    // the wiring so they appear on the same record together: a record
    // can be both TEE-attested AND Cardano-anchored at the same time.
    const tenant = "tenant-trust-anchor";
    const baseEnd = Date.now() - 60_000;
    const sub = await submitOne(ctx, {
      tenant_id: tenant,
      worker_id: "wkr-trust-anchor",
      uri: "//WkrTrustAnchor",
      period_start: baseEnd - 3_600_000,
      period_end: baseEnd,
    });
    const certHash = "0x" + "ee".repeat(32);
    const anchorTx = "11".repeat(32);
    queryReceiptStatusesMock.mockImplementation(async (hashes) =>
      hashes.map((h) => statusRow(h, "certified", certHash)),
    );
    queryCompositeTrustScoresMock.mockImplementation(async (hashes) =>
      hashes.map((h) => trustRow(h, 2)),
    );
    resolveAnchorTxsMock.mockImplementation(async (certs) =>
      certs.map((c) => (c === certHash ? anchorTx : null)),
    );

    const res = await call(
      ctx.app,
      "GET",
      `/billing/usage?tenant_id=${tenant}&start_ms=${baseEnd - 2 * 3_600_000}&end_ms=${baseEnd + 1000}&include_records=true`,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      records: Array<{
        content_hash: string;
        composite_trust_score: number | null;
        cardano_anchor_tx: string | null;
      }>;
      aggregate: {
        certified_count: number;
        anchored_count: number;
        tee_attested_count: number;
      };
    };
    expect(body.records).toHaveLength(1);
    expect(body.records[0].content_hash).toBe(sub.content_hash);
    expect(body.records[0].composite_trust_score).toBe(2);
    expect(body.records[0].cardano_anchor_tx).toBe("0x" + anchorTx);
    expect(body.aggregate.certified_count).toBe(1);
    expect(body.aggregate.anchored_count).toBe(1);
    expect(body.aggregate.tee_attested_count).toBe(1);
  });
});
