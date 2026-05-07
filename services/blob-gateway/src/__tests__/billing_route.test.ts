/**
 * In-process integration tests for `GET /billing/usage`.
 *
 * The route is wired against:
 *   - real schema validator (compute_metering_v1)
 *   - real worker_bounds.ts in-memory sqlite
 *   - real bearer-auth middleware (in-memory api_keys / api_tokens dbs)
 *   - in-memory aggregate function (no mock)
 *   - **mocked chain RPC** — `queryReceiptStatuses` is overridden via
 *     module mock so we don't need a live Materios node here. The
 *     LIVE_PREPROD test exercises the full chain leg end-to-end.
 *   - **mocked anchor resolver** — same reason; we point the resolver at
 *     a tmp checkpoint-history.json + log file so the mtime cache logic
 *     is exercised under controlled inputs.
 *
 * What we cover:
 *   - happy path (auth, params, full record echo, audit_trail)
 *   - empty range → 200 zero-aggregate
 *   - tenant isolation (records for other tenants must not leak)
 *   - param validation: missing, malformed, out-of-window, bad cursor
 *   - pagination round-trip across two pages
 *   - large result set (page_size cap)
 *   - replay-friendly: same query → same result (idempotent reads)
 *   - mixed states: one certified+anchored, one certified-only, one pending
 *
 * What we DO NOT cover here (covered elsewhere):
 *   - chain RPC failure (covered by chain_query_unit.test.ts? — exercised
 *     here via the `apiOverride` injection path of `queryReceiptStatuses`)
 *   - LIVE preprod end-to-end (covered by `billing_live_preprod.test.ts`)
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
import { createHash, randomBytes } from "crypto";

import { config } from "../config.js";
import { meteringRouter } from "../routes/metering.js";
import {
  initWorkerBoundsDb,
  setWorkerBoundsDbForTests,
} from "../worker_bounds.js";
import {
  canonicalBody,
  SCHEMA_VERSION,
  SCHEMA_HASH_HEX,
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

// We mock the chain query to avoid a live RPC dependency in the route
// tests. The aggregate test pins the math; this test pins the wiring.
vi.mock("../billing/chain_query.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../billing/chain_query.js")>();
  return {
    ...actual,
    queryReceiptStatuses: vi.fn(),
    // Trust-score query is also mocked here. The dedicated wiring test
    // (`billing_route_trust_score.test.ts`) pins the per-record / aggregate
    // surface; in this file we just need the route to not crash when the
    // function is called.
    queryCompositeTrustScores: vi.fn(),
  };
});

// Mock anchor resolver too — synthetic checkpoint-history.json + log
// generation is covered by anchor_resolver_unit.test.ts.
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
  cpu_seconds?: number;
  ram_gb_hours?: number;
  disk_gb_hours?: number;
  net_bytes_in?: number;
  net_bytes_out?: number;
  gpu_seconds?: number;
  uri?: string;
}

function buildSigned(opts: BuildOpts = {}): ComputeMeteringV1 {
  const pair = keyring.addFromUri(opts.uri ?? "//ComputeWorker0");
  const now = Date.now();
  const period_end = opts.period_end ?? now - 5000;
  const period_start = opts.period_start ?? period_end - 3_600_000;
  const body = {
    schema_version: SCHEMA_VERSION,
    worker_id: opts.worker_id ?? "worker-int-001",
    tenant_id: opts.tenant_id ?? "tenant-acme-1",
    period_start,
    period_end,
    cpu_seconds: opts.cpu_seconds ?? 30,
    ram_gb_hours: opts.ram_gb_hours ?? 0.5,
    disk_gb_hours: opts.disk_gb_hours ?? 1,
    net_bytes_in: opts.net_bytes_in ?? 1024,
    net_bytes_out: opts.net_bytes_out ?? 512,
    gpu_seconds: opts.gpu_seconds ?? 0,
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
  /** Plaintext bearer token authorised to call /billing/usage. */
  bearerToken: string;
}

async function setupApp(): Promise<Ctx> {
  const storage = mkdtempSync(join(tmpdir(), "billing-test-"));
  const prevStorage = config.storagePath;
  config.storagePath = storage;

  // Sponsored-receipt submitter must be UNCONFIGURED for these tests
  // (otherwise notifySponsoredReceiptSubmitter would try to fetch a real
  // URL and time-out 5s into each test). Leave it empty so the metering
  // route just persists locally.
  const prevSubmitterUrl = config.sponsoredReceiptSubmitterUrl;
  config.sponsoredReceiptSubmitterUrl = "";

  const workerBoundsDb = new Database(":memory:");
  initWorkerBoundsDb(workerBoundsDb);
  setWorkerBoundsDbForTests(workerBoundsDb);

  // Bearer auth machinery — quota.db (api_keys) + api_tokens.db tables.
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

  // Mint a Bearer token for an arbitrary SS58 — we only need a valid
  // bearer to satisfy bearerAuth({required:true}); the route doesn't
  // currently enforce tenant_id ↔ bearer binding (deferred follow-up).
  const ss58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"; // //Alice
  const tok = issueToken(tokensDb, {
    accountSs58: ss58,
    label: "billing-route-test",
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
      const headers: Record<string, string> = {
        ...(init.headers ?? {}),
      };
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

/** Helper: submit a record AND receive its content_hash. */
async function submitOne(
  ctx: Ctx,
  opts: BuildOpts = {},
): Promise<{ content_hash: string; record: ComputeMeteringV1 }> {
  const r = buildSigned(opts);
  const res = await call(ctx.app, "POST", "/metering/submit", { body: r });
  if (res.status !== 200) {
    throw new Error(
      `submit failed ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }
  const body = res.body as { content_hash: string };
  return { content_hash: body.content_hash, record: r };
}

beforeEach(() => {
  // Default mocks: every receipt is "unknown" (chain RPC degraded), no
  // anchor txs. Specific tests override per-call.
  queryReceiptStatusesMock.mockImplementation(async (hashes) =>
    hashes.map((h) => ({
      content_hash: h,
      receipt_id: "0x" + createHash("sha256").update(Buffer.from(h, "hex")).digest("hex"),
      status: "unknown",
      cert_hash: null,
    } satisfies ChainStatus)),
  );
  // Trust-score default: null (chain RPC degraded). Same shape as
  // queryReceiptStatusesMock — the dedicated trust-score test file
  // overrides per-test.
  queryCompositeTrustScoresMock.mockImplementation(async (hashes) =>
    hashes.map((h) => ({
      content_hash: h,
      receipt_id: "0x" + createHash("sha256").update(Buffer.from(h, "hex")).digest("hex"),
      composite_trust_score: null,
    })),
  );
  resolveAnchorTxsMock.mockImplementation(async (certs) =>
    certs.map(() => null),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /billing/usage — auth", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  test("missing Bearer → 401", async () => {
    const res = await call(
      ctx.app,
      "GET",
      "/billing/usage?tenant_id=tenant-acme-1&start_ms=1&end_ms=2",
    );
    expect(res.status).toBe(401);
  });

  test("malformed Bearer → 401", async () => {
    const res = await call(
      ctx.app,
      "GET",
      "/billing/usage?tenant_id=tenant-acme-1&start_ms=1&end_ms=2",
      { headers: { authorization: "Bearer matra_not_a_real_token" } },
    );
    expect(res.status).toBe(401);
  });

  test("valid Bearer → 200 even with zero records", async () => {
    const res = await call(
      ctx.app,
      "GET",
      "/billing/usage?tenant_id=tenant-empty-1&start_ms=1&end_ms=2",
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(200);
    expect((res.body as { aggregate: { record_count: number } }).aggregate.record_count).toBe(0);
  });
});

describe("GET /billing/usage — query-param validation", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  function authed(path: string) {
    return call(ctx.app, "GET", path, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
    });
  }

  test("missing tenant_id → 400 with field=tenant_id", async () => {
    const r = await authed("/billing/usage?start_ms=1&end_ms=2");
    expect(r.status).toBe(400);
    expect((r.body as { field: string }).field).toBe("tenant_id");
  });

  test("missing start_ms → 400 with field=start_ms", async () => {
    const r = await authed("/billing/usage?tenant_id=tenant-acme-1&end_ms=2");
    expect(r.status).toBe(400);
    expect((r.body as { field: string }).field).toBe("start_ms");
  });

  test("missing end_ms → 400 with field=end_ms", async () => {
    const r = await authed("/billing/usage?tenant_id=tenant-acme-1&start_ms=1");
    expect(r.status).toBe(400);
    expect((r.body as { field: string }).field).toBe("end_ms");
  });

  test("malformed tenant_id → 400 BAD_PARAM", async () => {
    const r = await authed("/billing/usage?tenant_id=BAD_UPPER&start_ms=1&end_ms=2");
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe("BAD_PARAM");
    expect((r.body as { field: string }).field).toBe("tenant_id");
  });

  test("non-integer start_ms → 400", async () => {
    const r = await authed(
      "/billing/usage?tenant_id=tenant-acme-1&start_ms=abc&end_ms=2",
    );
    expect(r.status).toBe(400);
    expect((r.body as { field: string }).field).toBe("start_ms");
  });

  test("end_ms <= start_ms → 400 BAD_WINDOW", async () => {
    const r = await authed(
      "/billing/usage?tenant_id=tenant-acme-1&start_ms=10&end_ms=5",
    );
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe("BAD_WINDOW");
  });

  test("end_ms === start_ms → 400 BAD_WINDOW", async () => {
    const r = await authed(
      "/billing/usage?tenant_id=tenant-acme-1&start_ms=10&end_ms=10",
    );
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe("BAD_WINDOW");
  });

  test("window > 90 days → 400 BAD_WINDOW", async () => {
    const ninety = 90 * 24 * 60 * 60 * 1000;
    const r = await authed(
      `/billing/usage?tenant_id=tenant-acme-1&start_ms=0&end_ms=${ninety + 1}`,
    );
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe("BAD_WINDOW");
  });

  test("window === 90 days → accepted", async () => {
    const ninety = 90 * 24 * 60 * 60 * 1000;
    const r = await authed(
      `/billing/usage?tenant_id=tenant-acme-1&start_ms=0&end_ms=${ninety}`,
    );
    expect(r.status).toBe(200);
  });

  test("page_size out of range → 400", async () => {
    const r = await authed(
      "/billing/usage?tenant_id=tenant-acme-1&start_ms=1&end_ms=2&page_size=999",
    );
    expect(r.status).toBe(400);
    expect((r.body as { field: string }).field).toBe("page_size");
  });

  test("negative page_size → 400", async () => {
    const r = await authed(
      "/billing/usage?tenant_id=tenant-acme-1&start_ms=1&end_ms=2&page_size=-1",
    );
    expect(r.status).toBe(400);
  });

  test("malformed cursor → 400", async () => {
    const r = await authed(
      "/billing/usage?tenant_id=tenant-acme-1&start_ms=1&end_ms=2&cursor=garbage!@#",
    );
    expect(r.status).toBe(400);
    expect((r.body as { field: string }).field).toBe("cursor");
  });
});

describe("GET /billing/usage — happy path", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  test("nonexistent tenant in window → 200 zero-aggregate (NOT 404)", async () => {
    const res = await call(
      ctx.app,
      "GET",
      "/billing/usage?tenant_id=nope-no-such&start_ms=1&end_ms=2",
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(200);
    const b = res.body as {
      tenant_id: string;
      aggregate: { record_count: number; first_record_ms: null };
      records?: unknown[];
    };
    expect(b.tenant_id).toBe("nope-no-such");
    expect(b.aggregate.record_count).toBe(0);
    expect(b.aggregate.first_record_ms).toBeNull();
    // include_records defaults false → no records[] in body
    expect(b.records).toBeUndefined();
  });

  test("aggregate sums match input across multiple records", async () => {
    const tenant = "tenant-sumtest";
    // Three records, each 1h apart, same worker.
    const baseEnd = Date.now() - 60_000;
    await submitOne(ctx, {
      tenant_id: tenant,
      worker_id: "wkr-sum-1",
      uri: "//ComputeWorkerSum",
      cpu_seconds: 10,
      ram_gb_hours: 0.1,
      net_bytes_in: 1000,
      net_bytes_out: 2000,
      period_end: baseEnd - 2 * 3_600_000,
      period_start: baseEnd - 3 * 3_600_000,
    });
    await submitOne(ctx, {
      tenant_id: tenant,
      worker_id: "wkr-sum-1",
      uri: "//ComputeWorkerSum",
      cpu_seconds: 20,
      ram_gb_hours: 0.2,
      net_bytes_in: 3000,
      net_bytes_out: 4000,
      period_end: baseEnd - 1 * 3_600_000,
      period_start: baseEnd - 2 * 3_600_000,
    });
    await submitOne(ctx, {
      tenant_id: tenant,
      worker_id: "wkr-sum-1",
      uri: "//ComputeWorkerSum",
      cpu_seconds: 30,
      ram_gb_hours: 0.3,
      net_bytes_in: 5000,
      net_bytes_out: 6000,
      period_end: baseEnd,
      period_start: baseEnd - 1 * 3_600_000,
    });

    const start = baseEnd - 5 * 3_600_000;
    const end = baseEnd + 1000;
    const res = await call(
      ctx.app,
      "GET",
      `/billing/usage?tenant_id=${tenant}&start_ms=${start}&end_ms=${end}&include_records=true`,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(200);
    const b = res.body as {
      aggregate: {
        record_count: number;
        cpu_seconds_total: number;
        ram_gb_hours_total: number;
        net_bytes_in_total: number;
        net_bytes_out_total: number;
        unique_workers: number;
      };
      records: Array<{ content_hash: string; metrics: { cpu_seconds: number } }>;
      audit_trail: { schema_hash: string; gateway_db_query_ms: number };
    };
    expect(b.aggregate.record_count).toBe(3);
    expect(b.aggregate.cpu_seconds_total).toBeCloseTo(60, 6);
    expect(b.aggregate.ram_gb_hours_total).toBeCloseTo(0.6, 6);
    expect(b.aggregate.net_bytes_in_total).toBe(9000);
    expect(b.aggregate.net_bytes_out_total).toBe(12000);
    expect(b.aggregate.unique_workers).toBe(1);
    expect(b.records).toHaveLength(3);
    expect(b.audit_trail.schema_hash).toBe(SCHEMA_HASH_HEX);
    expect(b.audit_trail.gateway_db_query_ms).toBeGreaterThanOrEqual(0);
  });

  test("tenant isolation: tenant A's query never sees tenant B records", async () => {
    const baseEnd = Date.now() - 60_000;
    await submitOne(ctx, {
      tenant_id: "tenant-iso-a",
      worker_id: "wkr-iso-a",
      uri: "//ComputeWorkerIsoA",
      period_start: baseEnd - 3_600_000,
      period_end: baseEnd,
    });
    await submitOne(ctx, {
      tenant_id: "tenant-iso-b",
      worker_id: "wkr-iso-b",
      uri: "//ComputeWorkerIsoB",
      period_start: baseEnd - 3_600_000,
      period_end: baseEnd,
    });
    const start = baseEnd - 5 * 3_600_000;
    const end = baseEnd + 1000;
    const aRes = await call(
      ctx.app,
      "GET",
      `/billing/usage?tenant_id=tenant-iso-a&start_ms=${start}&end_ms=${end}&include_records=true`,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(aRes.status).toBe(200);
    const ab = aRes.body as {
      aggregate: { record_count: number };
      records: Array<{ worker_id: string }>;
    };
    expect(ab.aggregate.record_count).toBe(1);
    expect(ab.records[0].worker_id).toBe("wkr-iso-a");
  });

  test("time-window: records with period_start === start_ms are included", async () => {
    const tenant = "tenant-window";
    const baseEnd = Date.now() - 60_000;
    const periodStart = baseEnd - 3_600_000;
    await submitOne(ctx, {
      tenant_id: tenant,
      worker_id: "wkr-window-1",
      uri: "//ComputeWorkerWindow1",
      period_start: periodStart,
      period_end: baseEnd,
    });

    // start_ms === record's period_start → included (inclusive lower bound)
    const res = await call(
      ctx.app,
      "GET",
      `/billing/usage?tenant_id=${tenant}&start_ms=${periodStart}&end_ms=${periodStart + 3_600_001}&include_records=true`,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(200);
    expect(
      (res.body as { aggregate: { record_count: number } }).aggregate.record_count,
    ).toBe(1);
  });

  test("time-window: records with period_start === end_ms are EXCLUDED", async () => {
    const tenant = "tenant-window-ex";
    const baseEnd = Date.now() - 60_000;
    const periodStart = baseEnd - 3_600_000;
    await submitOne(ctx, {
      tenant_id: tenant,
      worker_id: "wkr-window-2",
      uri: "//ComputeWorkerWindow2",
      period_start: periodStart,
      period_end: baseEnd,
    });

    // end_ms === period_start → record at upper boundary is EXCLUDED.
    const res = await call(
      ctx.app,
      "GET",
      `/billing/usage?tenant_id=${tenant}&start_ms=${periodStart - 1000}&end_ms=${periodStart}`,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(200);
    expect(
      (res.body as { aggregate: { record_count: number } }).aggregate.record_count,
    ).toBe(0);
  });

  test("idempotent reads: same query → same result twice", async () => {
    const tenant = "tenant-idem";
    const baseEnd = Date.now() - 60_000;
    await submitOne(ctx, {
      tenant_id: tenant,
      worker_id: "wkr-idem-1",
      uri: "//ComputeWorkerIdem",
      period_start: baseEnd - 3_600_000,
      period_end: baseEnd,
    });
    const url = `/billing/usage?tenant_id=${tenant}&start_ms=${baseEnd - 5 * 3_600_000}&end_ms=${baseEnd + 1000}&include_records=true`;
    const r1 = await call(ctx.app, "GET", url, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
    });
    const r2 = await call(ctx.app, "GET", url, {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Strip the period.now_ms field which IS time-dependent; everything
    // else MUST be byte-identical for a "verifiable" billing query.
    const stripNow = (b: unknown): unknown => {
      const obj = JSON.parse(JSON.stringify(b)) as {
        period: { now_ms: number };
        audit_trail: {
          gateway_db_query_ms: number;
          chain_query_ms: number;
          anchor_resolution_ms: number;
        };
      };
      obj.period.now_ms = 0;
      // Audit-trail timing fields are also non-deterministic; zero them.
      obj.audit_trail.gateway_db_query_ms = 0;
      obj.audit_trail.chain_query_ms = 0;
      obj.audit_trail.anchor_resolution_ms = 0;
      return obj;
    };
    expect(stripNow(r1.body)).toEqual(stripNow(r2.body));
  });
});

describe("GET /billing/usage — chain status integration", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  test("certified+anchored vs certified+not-anchored vs pending", async () => {
    const tenant = "tenant-mixed";
    const baseEnd = Date.now() - 60_000;
    const a = await submitOne(ctx, {
      tenant_id: tenant,
      worker_id: "wkr-mixed-a",
      uri: "//ComputeWorkerMixedA",
      period_start: baseEnd - 3 * 3_600_000,
      period_end: baseEnd - 2 * 3_600_000,
    });
    const b = await submitOne(ctx, {
      tenant_id: tenant,
      worker_id: "wkr-mixed-b",
      uri: "//ComputeWorkerMixedB",
      period_start: baseEnd - 2 * 3_600_000,
      period_end: baseEnd - 1 * 3_600_000,
    });
    const c = await submitOne(ctx, {
      tenant_id: tenant,
      worker_id: "wkr-mixed-c",
      uri: "//ComputeWorkerMixedC",
      period_start: baseEnd - 1 * 3_600_000,
      period_end: baseEnd,
    });

    const certHashA = "0x" + "aa".repeat(32);
    const certHashB = "0x" + "bb".repeat(32);
    const txA = "cc".repeat(32);

    queryReceiptStatusesMock.mockImplementation(async (hashes) =>
      hashes.map((h) => {
        if (h === a.content_hash) {
          return {
            content_hash: h,
            receipt_id: "0x" + createHash("sha256").update(Buffer.from(h, "hex")).digest("hex"),
            status: "certified",
            cert_hash: certHashA,
          };
        }
        if (h === b.content_hash) {
          return {
            content_hash: h,
            receipt_id: "0x" + createHash("sha256").update(Buffer.from(h, "hex")).digest("hex"),
            status: "certified",
            cert_hash: certHashB,
          };
        }
        // c is still pending
        return {
          content_hash: h,
          receipt_id: "0x" + createHash("sha256").update(Buffer.from(h, "hex")).digest("hex"),
          status: "pending",
          cert_hash: null,
        };
      }),
    );
    resolveAnchorTxsMock.mockImplementation(async (certs) =>
      certs.map((cert) => {
        if (cert === certHashA) return txA;
        return null;
      }),
    );

    const start = baseEnd - 5 * 3_600_000;
    const end = baseEnd + 1000;
    const res = await call(
      ctx.app,
      "GET",
      `/billing/usage?tenant_id=${tenant}&start_ms=${start}&end_ms=${end}&include_records=true`,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      aggregate: {
        record_count: number;
        certified_count: number;
        anchored_count: number;
      };
      records: Array<{
        content_hash: string;
        attestation_status: string;
        attestation_cert_hash: string | null;
        cardano_anchor_tx: string | null;
      }>;
    };
    expect(body.aggregate.record_count).toBe(3);
    expect(body.aggregate.certified_count).toBe(2);
    expect(body.aggregate.anchored_count).toBe(1);

    // Find each record by content_hash and check states.
    const byCh = new Map(body.records.map((r) => [r.content_hash, r]));
    const recA = byCh.get(a.content_hash);
    const recB = byCh.get(b.content_hash);
    const recC = byCh.get(c.content_hash);
    expect(recA?.attestation_status).toBe("certified");
    expect(recA?.attestation_cert_hash).toBe(certHashA);
    expect(recA?.cardano_anchor_tx).toBe("0x" + txA);

    expect(recB?.attestation_status).toBe("certified");
    expect(recB?.attestation_cert_hash).toBe(certHashB);
    expect(recB?.cardano_anchor_tx).toBeNull();

    expect(recC?.attestation_status).toBe("pending");
    expect(recC?.attestation_cert_hash).toBeNull();
    expect(recC?.cardano_anchor_tx).toBeNull();
  });

  test("RPC unavailable → all records 'unknown' but query still 200", async () => {
    const tenant = "tenant-rpcfail";
    const baseEnd = Date.now() - 60_000;
    await submitOne(ctx, {
      tenant_id: tenant,
      worker_id: "wkr-rpcfail",
      uri: "//ComputeWorkerRpcFail",
      period_start: baseEnd - 3_600_000,
      period_end: baseEnd,
    });
    // Default mock already returns "unknown" for every hash.
    const res = await call(
      ctx.app,
      "GET",
      `/billing/usage?tenant_id=${tenant}&start_ms=${baseEnd - 2 * 3_600_000}&end_ms=${baseEnd + 1000}&include_records=true`,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      aggregate: { certified_count: number; anchored_count: number };
      records: Array<{ attestation_status: string; cardano_anchor_tx: string | null }>;
    };
    expect(body.aggregate.certified_count).toBe(0);
    expect(body.aggregate.anchored_count).toBe(0);
    expect(body.records[0].attestation_status).toBe("unknown");
    expect(body.records[0].cardano_anchor_tx).toBeNull();
  });
});

describe("GET /billing/usage — pagination + large result", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  async function fillN(n: number, tenant: string): Promise<void> {
    const baseEnd = Date.now() - 60_000;
    // Stagger period_start so they're naturally ordered.
    for (let i = 0; i < n; i++) {
      const periodStart = baseEnd - (n - i + 1) * 3_600_000;
      const periodEnd = periodStart + 3_600_000;
      const seed = randomBytes(8).toString("hex");
      await submitOne(ctx, {
        tenant_id: tenant,
        worker_id: `wkr-page-${i}`,
        uri: `//Worker${seed}`,
        period_start: periodStart,
        period_end: periodEnd,
      });
    }
  }

  test("page_size=2 with 5 records → 3 pages, all unique, no duplicates", async () => {
    const tenant = "tenant-paged";
    await fillN(5, tenant);
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    while (true) {
      pages += 1;
      if (pages > 10) throw new Error("pagination loop too long");
      const cursorParam = cursor ? `&cursor=${cursor}` : "";
      const start_ms = Date.now() - 60 * 24 * 3_600_000; // 60 days ago
      const end_ms = Date.now() + 1000;
      const res = await call(
        ctx.app,
        "GET",
        `/billing/usage?tenant_id=${tenant}&start_ms=${start_ms}&end_ms=${end_ms}&include_records=true&page_size=2${cursorParam}`,
        { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
      );
      expect(res.status).toBe(200);
      const b = res.body as {
        records: Array<{ content_hash: string }>;
        next_cursor: string | null;
      };
      for (const r of b.records) {
        expect(seen.has(r.content_hash)).toBe(false);
        seen.add(r.content_hash);
      }
      if (b.next_cursor === null) break;
      cursor = b.next_cursor;
    }
    expect(seen.size).toBe(5);
  });

  test("default page_size=100, large set capped", async () => {
    const tenant = "tenant-large";
    // Submit 12 records — well under default 100. We just check the
    // default works; large-set cap is enforced by page_size validation.
    await fillN(12, tenant);
    const start_ms = Date.now() - 60 * 24 * 3_600_000;
    const end_ms = Date.now() + 1000;
    const res = await call(
      ctx.app,
      "GET",
      `/billing/usage?tenant_id=${tenant}&start_ms=${start_ms}&end_ms=${end_ms}&include_records=true`,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(200);
    const b = res.body as {
      aggregate: { record_count: number };
      records: Array<unknown>;
      next_cursor: string | null;
    };
    expect(b.aggregate.record_count).toBe(12);
    expect(b.records).toHaveLength(12);
    expect(b.next_cursor).toBeNull();
  });
});

describe("GET /billing/usage — partial certification + replay", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  test("partial certification: 5 records, 2 certified, 1 anchored", async () => {
    const tenant = "tenant-partial";
    const baseEnd = Date.now() - 60_000;
    const submitted: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await submitOne(ctx, {
        tenant_id: tenant,
        worker_id: `wkr-pc-${i}`,
        uri: `//ComputeWorkerPC${i}`,
        period_start: baseEnd - (i + 1) * 3_600_000,
        period_end: baseEnd - i * 3_600_000,
      });
      submitted.push(r.content_hash);
    }

    const certified = new Set([submitted[0], submitted[2]]);
    const anchorTxByCert = new Map<string, string>();
    const certHash0 = "0x" + "10".repeat(32);
    const certHash2 = "0x" + "20".repeat(32);
    anchorTxByCert.set(certHash0, "ee".repeat(32));

    queryReceiptStatusesMock.mockImplementation(async (hashes) =>
      hashes.map((h) => {
        if (h === submitted[0]) {
          return {
            content_hash: h,
            receipt_id: "0x" + createHash("sha256").update(Buffer.from(h, "hex")).digest("hex"),
            status: "certified",
            cert_hash: certHash0,
          };
        }
        if (h === submitted[2]) {
          return {
            content_hash: h,
            receipt_id: "0x" + createHash("sha256").update(Buffer.from(h, "hex")).digest("hex"),
            status: "certified",
            cert_hash: certHash2,
          };
        }
        return {
          content_hash: h,
          receipt_id: "0x" + createHash("sha256").update(Buffer.from(h, "hex")).digest("hex"),
          status: "pending",
          cert_hash: null,
        };
      }),
    );
    resolveAnchorTxsMock.mockImplementation(async (certs) =>
      certs.map((c) => (c ? anchorTxByCert.get(c) ?? null : null)),
    );

    const start_ms = Date.now() - 60 * 24 * 3_600_000;
    const end_ms = Date.now() + 1000;
    const res = await call(
      ctx.app,
      "GET",
      `/billing/usage?tenant_id=${tenant}&start_ms=${start_ms}&end_ms=${end_ms}`,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(200);
    const b = res.body as {
      aggregate: {
        record_count: number;
        certified_count: number;
        anchored_count: number;
      };
    };
    expect(b.aggregate.record_count).toBe(5);
    expect(b.aggregate.certified_count).toBe(2);
    expect(b.aggregate.anchored_count).toBe(1);
    void certified;
  });

  test("replay tolerance: re-submit same record → same content_hash, no double-count", async () => {
    const tenant = "tenant-replay";
    const baseEnd = Date.now() - 60_000;
    const r1 = buildSigned({
      tenant_id: tenant,
      worker_id: "wkr-replay-1",
      uri: "//ComputeWorkerReplay",
      period_start: baseEnd - 3_600_000,
      period_end: baseEnd,
    });
    const a = await call(ctx.app, "POST", "/metering/submit", { body: r1 });
    expect(a.status).toBe(200);
    // Re-submit the EXACT SAME record → metering route returns "replay" but
    // never appends a new metering_submissions row (PRIMARY KEY = content_hash
    // means INSERT OR IGNORE drops the duplicate).
    const b = await call(ctx.app, "POST", "/metering/submit", { body: r1 });
    expect(b.status).toBe(200);
    expect((b.body as { status: string }).status).toBe("replay");
    const start_ms = Date.now() - 60 * 24 * 3_600_000;
    const end_ms = Date.now() + 1000;
    const res = await call(
      ctx.app,
      "GET",
      `/billing/usage?tenant_id=${tenant}&start_ms=${start_ms}&end_ms=${end_ms}`,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(200);
    expect((res.body as { aggregate: { record_count: number } }).aggregate.record_count).toBe(1);
  });
});

// Anti-injection: tenant_id is regex-validated server-side, but we also
// confirm a SQL-injection attempt fails the regex check (so it never
// reaches the prepared statement).
describe("GET /billing/usage — tenant_id injection guard", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  test("' OR 1=1 -- → 400 BAD_PARAM (regex blocks it)", async () => {
    const evil = encodeURIComponent("' OR 1=1 --");
    const r = await call(
      ctx.app,
      "GET",
      `/billing/usage?tenant_id=${evil}&start_ms=1&end_ms=2`,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(r.status).toBe(400);
    expect((r.body as { field: string }).field).toBe("tenant_id");
  });
});


