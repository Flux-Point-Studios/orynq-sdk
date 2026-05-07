/**
 * Tests for the daemon-facing chain-submission endpoints (task #143).
 *
 *   GET  /v2/attestation_evidence/pending
 *   POST /v2/attestation_evidence/:row_id/mark_submitted
 *
 * Coverage matrix:
 *   Auth
 *     - missing Bearer → 401 (both routes)
 *     - wrong Bearer  → 401
 *     - empty config token → 401 even with matching empty Bearer
 *     - correct Bearer + non-empty config → 200
 *
 *   Pending route
 *     - empty DB → rows: [], next_since: 0
 *     - 3 rows, no since → all returned, ordered by id ASC, next_since = max id
 *     - since cursor: returns only rows with id > since
 *     - limit cap rejected when <= 0
 *     - rows with submitted_to_chain_at != NULL are excluded
 *     - payload column round-trips as a parsed object (NOT a JSON string)
 *
 *   Mark-submitted route
 *     - first ack on a pending row → status:marked + row reflects timestamp +
 *       extrinsic hash
 *     - retry → status:already-marked + the SAME extrinsic hash (idempotency)
 *     - bad row_id (non-int) → 400
 *     - missing/bad chain_extrinsic_hash → 400
 *     - unknown row id → 404
 *     - 0x-prefixed hash accepted, normalised lowercase
 *
 *   Round-trip
 *     - POST mark_submitted then GET pending → that row no longer surfaces
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

import { config } from "../config.js";
import { attestationEvidenceSubmissionRouter } from "../routes/attestation_evidence_submission.js";
import {
  initReceiptAttestationEvidenceDb,
  setReceiptAttestationEvidenceDbForTests,
  insertReceiptEvidence,
  markReceiptEvidenceSubmittedToChain,
} from "../receipt_attestation_evidence.js";
import type { EvidenceType } from "../schemas/compute_metering_v2.js";

interface Ctx {
  app: express.Express;
  db: Database.Database;
  prevToken: string;
  prevStorage: string;
  storage: string;
  bearerToken: string;
}

function setupApp(opts: { token?: string } = {}): Ctx {
  const storage = mkdtempSync(join(tmpdir(), "att-evidence-submission-"));
  const prevStorage = config.storagePath;
  config.storagePath = storage;

  const bearerToken =
    opts.token !== undefined
      ? opts.token
      : "submitter-tok-" + randomBytes(8).toString("hex");
  const prevToken = config.sponsoredReceiptSubmitterToken;
  config.sponsoredReceiptSubmitterToken = bearerToken;

  const db = new Database(":memory:");
  initReceiptAttestationEvidenceDb(db);
  setReceiptAttestationEvidenceDbForTests(db);

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(attestationEvidenceSubmissionRouter);

  return { app, db, prevToken, prevStorage, storage, bearerToken };
}

function teardown(ctx: Ctx): void {
  ctx.db.close();
  config.sponsoredReceiptSubmitterToken = ctx.prevToken;
  config.storagePath = ctx.prevStorage;
  rmSync(ctx.storage, { recursive: true, force: true });
}

function insertOne(opts: {
  receipt_id?: string;
  evidence_type?: EvidenceType;
  payload?: Record<string, unknown>;
} = {}): { id: number } {
  const receipt_id = opts.receipt_id ?? randomBytes(32).toString("hex");
  const out = insertReceiptEvidence({
    receipt_id,
    evidence_type: opts.evidence_type ?? "arm_trustzone",
    nonce_hex: randomBytes(32).toString("hex"),
    payload: opts.payload ?? { cert_chain_b64: ["aGVsbG8="] },
    attestor_pubkey_hex: randomBytes(32).toString("hex"),
    signature_hex: randomBytes(64).toString("hex"),
  });
  if (out.status !== "inserted") {
    throw new Error("test setup: insertReceiptEvidence didn't insert");
  }
  return { id: out.row.id };
}

async function callApp(
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
        headers: {
          "content-type": "application/json",
          ...(opts.headers ?? {}),
        },
      };
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
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

// ===========================================================================
// GET /v2/attestation_evidence/pending — auth
// ===========================================================================

describe("GET /v2/attestation_evidence/pending — auth", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupApp();
  });
  afterEach(() => teardown(ctx));

  test("missing Bearer → 401", async () => {
    const r = await callApp(ctx.app, "GET", "/v2/attestation_evidence/pending");
    expect(r.status).toBe(401);
  });

  test("wrong Bearer → 401", async () => {
    const r = await callApp(ctx.app, "GET", "/v2/attestation_evidence/pending", {
      headers: { authorization: "Bearer not-the-token" },
    });
    expect(r.status).toBe(401);
  });

  test("correct Bearer → 200", async () => {
    const r = await callApp(ctx.app, "GET", "/v2/attestation_evidence/pending", {
      headers: { authorization: "Bearer " + ctx.bearerToken },
    });
    expect(r.status).toBe(200);
  });
});

describe("GET /v2/attestation_evidence/pending — empty config token rejects all", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupApp({ token: "" });
  });
  afterEach(() => teardown(ctx));

  test("empty config + empty Bearer → 401 (no free pass)", async () => {
    const r = await callApp(ctx.app, "GET", "/v2/attestation_evidence/pending", {
      headers: { authorization: "Bearer " },
    });
    expect(r.status).toBe(401);
  });

  test("empty config + any Bearer → 401", async () => {
    const r = await callApp(ctx.app, "GET", "/v2/attestation_evidence/pending", {
      headers: { authorization: "Bearer anything" },
    });
    expect(r.status).toBe(401);
  });
});

// ===========================================================================
// GET /v2/attestation_evidence/pending — listing
// ===========================================================================

describe("GET /v2/attestation_evidence/pending — listing", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupApp();
  });
  afterEach(() => teardown(ctx));

  test("empty DB → rows: [], next_since == 0", async () => {
    const r = await callApp(ctx.app, "GET", "/v2/attestation_evidence/pending", {
      headers: { authorization: "Bearer " + ctx.bearerToken },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, rows: [], next_since: 0 });
  });

  test("3 rows, no since → ordered by id ASC, next_since = max id", async () => {
    const a = insertOne();
    const b = insertOne();
    const c = insertOne();
    const r = await callApp(ctx.app, "GET", "/v2/attestation_evidence/pending", {
      headers: { authorization: "Bearer " + ctx.bearerToken },
    });
    expect(r.status).toBe(200);
    const body = r.body as {
      ok: boolean;
      rows: Array<{ id: number }>;
      next_since: number;
    };
    expect(body.ok).toBe(true);
    expect(body.rows.map((x) => x.id)).toEqual([a.id, b.id, c.id]);
    expect(body.next_since).toBe(c.id);
  });

  test("since cursor → only rows with id > since", async () => {
    const a = insertOne();
    const b = insertOne();
    const r = await callApp(
      ctx.app,
      "GET",
      `/v2/attestation_evidence/pending?since=${a.id}`,
      { headers: { authorization: "Bearer " + ctx.bearerToken } },
    );
    expect(r.status).toBe(200);
    const body = r.body as {
      rows: Array<{ id: number }>;
      next_since: number;
    };
    expect(body.rows.map((x) => x.id)).toEqual([b.id]);
    expect(body.next_since).toBe(b.id);
  });

  test("limit honoured", async () => {
    insertOne();
    insertOne();
    insertOne();
    const r = await callApp(
      ctx.app,
      "GET",
      `/v2/attestation_evidence/pending?limit=2`,
      { headers: { authorization: "Bearer " + ctx.bearerToken } },
    );
    expect(r.status).toBe(200);
    const body = r.body as { rows: Array<{ id: number }> };
    expect(body.rows).toHaveLength(2);
  });

  test("rows already marked are excluded", async () => {
    const a = insertOne();
    const b = insertOne();
    markReceiptEvidenceSubmittedToChain({
      row_id: a.id,
      chain_extrinsic_hash: "11".repeat(32),
    });
    const r = await callApp(ctx.app, "GET", "/v2/attestation_evidence/pending", {
      headers: { authorization: "Bearer " + ctx.bearerToken },
    });
    const body = r.body as {
      rows: Array<{ id: number }>;
      next_since: number;
    };
    expect(body.rows.map((x) => x.id)).toEqual([b.id]);
    expect(body.next_since).toBe(b.id);
  });

  test("payload deserialises as parsed object, not JSON string", async () => {
    insertOne({
      payload: { cert_chain_b64: ["AAEC"], device_model: "Pixel-X" },
    });
    const r = await callApp(ctx.app, "GET", "/v2/attestation_evidence/pending", {
      headers: { authorization: "Bearer " + ctx.bearerToken },
    });
    const body = r.body as {
      rows: Array<{ payload: Record<string, unknown> }>;
    };
    expect(body.rows[0].payload).toEqual({
      cert_chain_b64: ["AAEC"],
      device_model: "Pixel-X",
    });
  });

  test("invalid since rejected with 400", async () => {
    const r = await callApp(
      ctx.app,
      "GET",
      `/v2/attestation_evidence/pending?since=-7`,
      { headers: { authorization: "Bearer " + ctx.bearerToken } },
    );
    expect(r.status).toBe(400);
  });

  test("invalid limit rejected with 400", async () => {
    const r = await callApp(
      ctx.app,
      "GET",
      `/v2/attestation_evidence/pending?limit=0`,
      { headers: { authorization: "Bearer " + ctx.bearerToken } },
    );
    expect(r.status).toBe(400);
  });
});

// ===========================================================================
// POST /v2/attestation_evidence/:row_id/mark_submitted
// ===========================================================================

describe("POST /v2/attestation_evidence/:row_id/mark_submitted — auth", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupApp();
  });
  afterEach(() => teardown(ctx));

  test("missing Bearer → 401", async () => {
    const a = insertOne();
    const r = await callApp(
      ctx.app,
      "POST",
      `/v2/attestation_evidence/${a.id}/mark_submitted`,
      { body: { chain_extrinsic_hash: "ab".repeat(32) } },
    );
    expect(r.status).toBe(401);
  });

  test("wrong Bearer → 401", async () => {
    const a = insertOne();
    const r = await callApp(
      ctx.app,
      "POST",
      `/v2/attestation_evidence/${a.id}/mark_submitted`,
      {
        headers: { authorization: "Bearer wrong" },
        body: { chain_extrinsic_hash: "ab".repeat(32) },
      },
    );
    expect(r.status).toBe(401);
  });
});

describe("POST /v2/attestation_evidence/:row_id/mark_submitted — happy path + idempotency", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupApp();
  });
  afterEach(() => teardown(ctx));

  test("first ack → status:marked, retry → already-marked (preserves first hash)", async () => {
    const a = insertOne();
    const firstHash = "ab".repeat(32);
    const r1 = await callApp(
      ctx.app,
      "POST",
      `/v2/attestation_evidence/${a.id}/mark_submitted`,
      {
        headers: { authorization: "Bearer " + ctx.bearerToken },
        body: { chain_extrinsic_hash: firstHash },
      },
    );
    expect(r1.status).toBe(200);
    const b1 = r1.body as {
      ok: boolean;
      status: string;
      row: { chain_extrinsic_hash: string; submitted_to_chain_at: number };
    };
    expect(b1.ok).toBe(true);
    expect(b1.status).toBe("marked");
    expect(b1.row.chain_extrinsic_hash).toBe(firstHash);
    expect(typeof b1.row.submitted_to_chain_at).toBe("number");

    const secondHash = "cd".repeat(32);
    const r2 = await callApp(
      ctx.app,
      "POST",
      `/v2/attestation_evidence/${a.id}/mark_submitted`,
      {
        headers: { authorization: "Bearer " + ctx.bearerToken },
        body: { chain_extrinsic_hash: secondHash },
      },
    );
    expect(r2.status).toBe(200);
    const b2 = r2.body as {
      status: string;
      row: { chain_extrinsic_hash: string };
    };
    expect(b2.status).toBe("already-marked");
    expect(b2.row.chain_extrinsic_hash).toBe(firstHash);
  });

  test("0x-prefixed hash accepted, normalised lowercase", async () => {
    const a = insertOne();
    const r = await callApp(
      ctx.app,
      "POST",
      `/v2/attestation_evidence/${a.id}/mark_submitted`,
      {
        headers: { authorization: "Bearer " + ctx.bearerToken },
        body: { chain_extrinsic_hash: "0xAB" + "ab".repeat(31) },
      },
    );
    expect(r.status).toBe(200);
    const body = r.body as { row: { chain_extrinsic_hash: string } };
    expect(body.row.chain_extrinsic_hash).toBe("ab".repeat(32));
  });

  test("unknown row id → 404", async () => {
    const r = await callApp(
      ctx.app,
      "POST",
      `/v2/attestation_evidence/999999/mark_submitted`,
      {
        headers: { authorization: "Bearer " + ctx.bearerToken },
        body: { chain_extrinsic_hash: "ab".repeat(32) },
      },
    );
    expect(r.status).toBe(404);
  });

  test("bad row_id (non-int) → 400", async () => {
    const r = await callApp(
      ctx.app,
      "POST",
      `/v2/attestation_evidence/foo/mark_submitted`,
      {
        headers: { authorization: "Bearer " + ctx.bearerToken },
        body: { chain_extrinsic_hash: "ab".repeat(32) },
      },
    );
    expect(r.status).toBe(400);
  });

  test("missing chain_extrinsic_hash → 400", async () => {
    const a = insertOne();
    const r = await callApp(
      ctx.app,
      "POST",
      `/v2/attestation_evidence/${a.id}/mark_submitted`,
      {
        headers: { authorization: "Bearer " + ctx.bearerToken },
        body: {},
      },
    );
    expect(r.status).toBe(400);
  });

  test("malformed chain_extrinsic_hash → 400", async () => {
    const a = insertOne();
    const r = await callApp(
      ctx.app,
      "POST",
      `/v2/attestation_evidence/${a.id}/mark_submitted`,
      {
        headers: { authorization: "Bearer " + ctx.bearerToken },
        body: { chain_extrinsic_hash: "not-hex" },
      },
    );
    expect(r.status).toBe(400);
  });
});

// ===========================================================================
// Round-trip
// ===========================================================================

describe("Round-trip: ack removes from pending list", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupApp();
  });
  afterEach(() => teardown(ctx));

  test("POST mark_submitted then GET pending → row no longer surfaces", async () => {
    const a = insertOne();
    const b = insertOne();
    await callApp(
      ctx.app,
      "POST",
      `/v2/attestation_evidence/${a.id}/mark_submitted`,
      {
        headers: { authorization: "Bearer " + ctx.bearerToken },
        body: { chain_extrinsic_hash: "ab".repeat(32) },
      },
    );
    const r = await callApp(
      ctx.app,
      "GET",
      "/v2/attestation_evidence/pending",
      { headers: { authorization: "Bearer " + ctx.bearerToken } },
    );
    const body = r.body as { rows: Array<{ id: number }> };
    expect(body.rows.map((x) => x.id)).toEqual([b.id]);
  });
});

// ===========================================================================
// Migration (additive columns)
// ===========================================================================

describe("Migration: chain-submission columns are added on existing DBs", () => {
  test("init twice on the same handle is idempotent and adds columns", () => {
    const db = new Database(":memory:");
    // Simulate an OLD db that pre-dates the migration: build the table with
    // the original schema (no submitted_to_chain_at, no chain_extrinsic_hash).
    db.exec(`
      CREATE TABLE receipt_attestation_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        receipt_id TEXT NOT NULL,
        evidence_type TEXT NOT NULL,
        nonce_hex TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attestor_pubkey_hex TEXT NOT NULL,
        signature_hex TEXT NOT NULL,
        submitted_at_ms INTEGER NOT NULL,
        UNIQUE (receipt_id, attestor_pubkey_hex, evidence_type)
      );
    `);
    initReceiptAttestationEvidenceDb(db);
    setReceiptAttestationEvidenceDbForTests(db);
    // Running the init AGAIN must not fail with "duplicate column".
    initReceiptAttestationEvidenceDb(db);

    const cols = (db
      .prepare("PRAGMA table_info(receipt_attestation_evidence)")
      .all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("submitted_to_chain_at");
    expect(cols).toContain("chain_extrinsic_hash");
    db.close();
  });
});
