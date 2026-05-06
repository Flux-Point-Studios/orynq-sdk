/**
 * Integration tests for `POST /metering/submit`.
 *
 * In-process Express server, real schema validator, real worker_bounds db
 * (in-memory), real Polkadot crypto. The sponsored-receipt-submitter is a
 * fake HTTP server (mirrors the existing pattern in
 * `__tests__/sponsored-receipts.test.ts`) so we can assert the outbound
 * payload shape without hitting a real submitter.
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll } from "vitest";
import express from "express";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { Keyring } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";

import { config } from "../../config.js";
import { meteringRouter } from "../../routes/metering.js";
import {
  initWorkerBoundsDb,
  setWorkerBoundsDbForTests,
  upsertWorkerBounds,
} from "../../worker_bounds.js";
import {
  canonicalBody,
  SCHEMA_VERSION,
  SCHEMA_HASH_HEX,
  workerPubkeyToSs58,
  type ComputeMeteringV1,
} from "../compute_metering_v1.js";

let keyring: Keyring;

beforeAll(async () => {
  await cryptoWaitReady();
  keyring = new Keyring({ type: "sr25519" });
});

interface FakeSubmitter {
  server: Server;
  port: number;
  captured: Array<{
    method: string;
    url: string;
    body: string;
    headers: Record<string, string | string[] | undefined>;
  }>;
  stop(): Promise<void>;
}

async function startFakeSubmitter(): Promise<FakeSubmitter> {
  const captured: FakeSubmitter["captured"] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      captured.push({
        method: req.method || "",
        url: req.url || "",
        body: Buffer.concat(chunks).toString("utf-8"),
        headers: { ...req.headers },
      });
      res.statusCode = 202;
      res.setHeader("content-type", "application/json");
      res.end('{"accepted":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    captured,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

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
  // Default period: 1h ending 5s ago — comfortably inside the skew tolerance.
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
  prevSubmitterTimeout: number;
  fake: FakeSubmitter;
  db: Database.Database;
}

async function setupApp(): Promise<Ctx> {
  const storage = mkdtempSync(join(tmpdir(), "metering-test-"));
  const prevStorage = config.storagePath;
  config.storagePath = storage;

  // Worker-bounds DB in-memory; mirror the production schema.
  const db = new Database(":memory:");
  initWorkerBoundsDb(db);
  setWorkerBoundsDbForTests(db);

  // Fake submitter
  const fake = await startFakeSubmitter();
  const prevSubmitterUrl = config.sponsoredReceiptSubmitterUrl;
  const prevSubmitterTimeout = config.sponsoredReceiptNotifyTimeoutMs;
  config.sponsoredReceiptSubmitterUrl = `http://127.0.0.1:${fake.port}/submit`;
  config.sponsoredReceiptNotifyTimeoutMs = 5000;

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(meteringRouter);

  return {
    app,
    storage,
    prevStorage,
    prevSubmitterUrl,
    prevSubmitterTimeout,
    fake,
    db,
  };
}

async function teardown(ctx: Ctx): Promise<void> {
  config.storagePath = ctx.prevStorage;
  config.sponsoredReceiptSubmitterUrl = ctx.prevSubmitterUrl;
  config.sponsoredReceiptNotifyTimeoutMs = ctx.prevSubmitterTimeout;
  await ctx.fake.stop();
  rmSync(ctx.storage, { recursive: true, force: true });
  ctx.db.close();
}

async function fetchJson(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
  rawText?: string,
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
        headers: { "content-type": "application/json" },
      };
      if (rawText !== undefined) {
        init.body = rawText;
      } else if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      fetch(url, init)
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

/**
 * Wait until a predicate returns true or the deadline expires. NO sleep loop —
 * exits immediately on success, and the deadline guarantees no test hang.
 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts: { deadlineMs: number; intervalMs?: number; what: string },
): Promise<void> {
  const deadline = Date.now() + opts.deadlineMs;
  const interval = opts.intervalMs ?? 50;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timeout after ${opts.deadlineMs}ms: ${opts.what}`);
}

describe("POST /metering/submit — happy path", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  test("valid record → 200 accepted with content_hash and schema_hash", async () => {
    const rec = buildSigned();
    const res = await fetchJson(ctx.app, "POST", "/metering/submit", rec);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      status: "accepted",
      worker_id: rec.worker_id,
      schema_hash: SCHEMA_HASH_HEX,
    });
    const body = res.body as Record<string, unknown>;
    expect(body.content_hash).toMatch(/^[0-9a-f]{64}$/);
    // Operator SS58 should be derivable from worker_pubkey.
    expect(body.operator).toBe(workerPubkeyToSs58(rec.worker_pubkey));
  });

  test("manifest persisted at receipts/{contentHash}/manifest.json", async () => {
    const rec = buildSigned();
    const res = await fetchJson(ctx.app, "POST", "/metering/submit", rec);
    expect(res.status).toBe(200);
    const ch = (res.body as { content_hash: string }).content_hash;
    const manifestPath = join(
      ctx.storage,
      "receipts",
      ch,
      "manifest.json",
    );
    expect(existsSync(manifestPath)).toBe(true);
    const stored = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      schema: string;
      record: ComputeMeteringV1;
      chunks: unknown[];
      rootHash: string;
    };
    expect(stored.schema).toBe(SCHEMA_VERSION);
    expect(stored.record.worker_id).toBe(rec.worker_id);
    expect(stored.rootHash).toBe(ch);
    expect(stored.chunks).toEqual([]);
  });

  test("submitter notified with schemaHash + source=compute-metering-v1", async () => {
    const rec = buildSigned();
    const res = await fetchJson(ctx.app, "POST", "/metering/submit", rec);
    expect(res.status).toBe(200);
    // Notify is fire-and-forget; poll captured array with a deadline.
    await waitFor(() => ctx.fake.captured.length === 1, {
      deadlineMs: 2000,
      what: "submitter received notify",
    });
    const captured = ctx.fake.captured[0];
    expect(captured.method).toBe("POST");
    const body = JSON.parse(captured.body) as Record<string, unknown>;
    expect(body.contentHash).toBe((res.body as { content_hash: string }).content_hash);
    expect(body.schemaHash).toBe(SCHEMA_HASH_HEX);
    expect(body.source).toBe("compute-metering-v1");
    expect(body.operator).toBe(workerPubkeyToSs58(rec.worker_pubkey));
  });
});

describe("POST /metering/submit — failure modes", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  test("malformed JSON → 400", async () => {
    const res = await fetchJson(
      ctx.app,
      "POST",
      "/metering/submit",
      undefined,
      "{not_json",
    );
    expect(res.status).toBe(400);
    // Express's default JSON-parse failure handler returns its own shape;
    // either way, body is non-empty and no submitter notify was made.
    expect(ctx.fake.captured).toHaveLength(0);
  });

  test("missing schema_version → 400 with field=schema_version", async () => {
    const rec = buildSigned() as Record<string, unknown>;
    delete rec.schema_version;
    const res = await fetchJson(ctx.app, "POST", "/metering/submit", rec);
    expect(res.status).toBe(400);
    const body = res.body as Record<string, unknown>;
    expect(body.code).toBe("MISSING_FIELD");
    expect(body.field).toBe("schema_version");
  });

  test("wrong schema_version → 422", async () => {
    // Use a clearly-unknown schema_version so the dispatcher routes to the v1
    // validator (any non-v2 / non-v1 schema string falls through). The v2
    // dispatch trigger ("compute_metering_v2") is no longer "wrong" now that
    // v2 is live — see metering_v2_route.test.ts for v2-side rejection tests.
    const rec = { ...buildSigned(), schema_version: "compute_metering_vfuture" };
    const res = await fetchJson(ctx.app, "POST", "/metering/submit", rec);
    expect(res.status).toBe(422);
  });

  test("over-bound cpu_seconds → 422", async () => {
    const rec = buildSigned({ cpu_seconds: 460_801 });
    const res = await fetchJson(ctx.app, "POST", "/metering/submit", rec);
    expect(res.status).toBe(422);
    expect((res.body as { code: string }).code).toBe("BOUND_EXCEEDED");
  });

  test("invalid signature → 401", async () => {
    const rec = buildSigned();
    const tampered = {
      ...rec,
      // Flip one bit in the signature.
      worker_signature: rec.worker_signature.slice(0, -2) +
        (rec.worker_signature.endsWith("ff") ? "00" : "ff"),
    };
    const res = await fetchJson(ctx.app, "POST", "/metering/submit", tampered);
    expect(res.status).toBe(401);
    expect((res.body as { code: string }).code).toBe("SIGNATURE_INVALID");
  });

  test("monotonic violation → 409", async () => {
    const baseEnd = Date.now() - 5000;
    const baseStart = baseEnd - 3_600_000;
    const first = buildSigned({
      worker_id: "worker-mono-001",
      period_start: baseStart,
      period_end: baseEnd,
    });
    const r1 = await fetchJson(ctx.app, "POST", "/metering/submit", first);
    expect(r1.status).toBe(200);

    // Submit a record with EARLIER period_start for same worker — must reject.
    const earlier = buildSigned({
      worker_id: "worker-mono-001",
      period_start: baseStart - 60_000,
      period_end: baseStart - 1000,
    });
    const r2 = await fetchJson(ctx.app, "POST", "/metering/submit", earlier);
    expect(r2.status).toBe(409);
    expect((r2.body as { code: string }).code).toBe("MONOTONIC_VIOLATION");
  });

  test("idempotent retry → 200 status:replay; submitter NOT notified twice", async () => {
    const rec = buildSigned({ worker_id: "worker-idem-001" });
    const r1 = await fetchJson(ctx.app, "POST", "/metering/submit", rec);
    expect(r1.status).toBe(200);
    expect((r1.body as { status: string }).status).toBe("accepted");
    await waitFor(() => ctx.fake.captured.length === 1, {
      deadlineMs: 2000,
      what: "first notify",
    });

    const r2 = await fetchJson(ctx.app, "POST", "/metering/submit", rec);
    expect(r2.status).toBe(200);
    expect((r2.body as { status: string }).status).toBe("replay");
    // Give a beat for any async fire-and-forget; submitter must still be 1.
    await new Promise((r) => setTimeout(r, 200));
    expect(ctx.fake.captured).toHaveLength(1);
  });
});

describe("POST /metering/submit — registry-driven bounds", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  test("registered tighter bounds reject otherwise-valid record", async () => {
    upsertWorkerBounds("worker-tight-001", {
      max_cpu_cores: 1,
      max_ram_gb: 1,
      max_disk_gb: 1,
      max_gpu_count: 1,
    });
    // 1h × 1 core = 3600 max cpu_seconds; this requests 3601.
    const rec = buildSigned({
      worker_id: "worker-tight-001",
      cpu_seconds: 3601,
    });
    const res = await fetchJson(ctx.app, "POST", "/metering/submit", rec);
    expect(res.status).toBe(422);
    expect((res.body as { code: string }).code).toBe("BOUND_EXCEEDED");
  });

  test("default bounds accept moderate values for unregistered worker", async () => {
    const rec = buildSigned({
      worker_id: "worker-newbie-001",
      cpu_seconds: 1000, // well under default max.
    });
    const res = await fetchJson(ctx.app, "POST", "/metering/submit", rec);
    expect(res.status).toBe(200);
  });
});
