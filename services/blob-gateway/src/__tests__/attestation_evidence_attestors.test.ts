/**
 * Tests for the attestation_evidence_attestors registry + admin routes.
 * Mirrors `fleet_operators.test.ts` + `metering_v2_admin.test.ts`.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import Database from "better-sqlite3";

import { config } from "../config.js";
import {
  initAttestationEvidenceAttestorsDb,
  setAttestationEvidenceAttestorsDbForTests,
  registerAttestationEvidenceAttestor,
  revokeAttestationEvidenceAttestor,
  getAttestationEvidenceAttestor,
  isAttestationEvidenceAttestorActive,
  listAttestationEvidenceAttestors,
} from "../attestation_evidence_attestors.js";
import { registerAttestationEvidenceAttestorRoutes } from "../routes/attestation_evidence_attestors.js";

const ADMIN_TOKEN = "admin-test-token-deadbeef";
const PUB_A = "a".repeat(64);
const PUB_B = "b".repeat(64);
const PUB_C = "c".repeat(64);

function makeMemDb(): Database.Database {
  const db = new Database(":memory:");
  initAttestationEvidenceAttestorsDb(db);
  setAttestationEvidenceAttestorsDbForTests(db);
  return db;
}

interface Ctx {
  app: express.Express;
  db: Database.Database;
  prevToken: string;
}

function setupApp(opts: { withToken?: boolean } = {}): Ctx {
  const db = makeMemDb();
  const prevToken = config.daemonNotifyToken;
  config.daemonNotifyToken = opts.withToken === false ? "" : ADMIN_TOKEN;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  registerAttestationEvidenceAttestorRoutes(app);
  return { app, db, prevToken };
}

function teardown(ctx: Ctx): void {
  config.daemonNotifyToken = ctx.prevToken;
  ctx.db.close();
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
        headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
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
// Storage layer
// ===========================================================================

describe("attestation_evidence_attestors: storage", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeMemDb();
  });
  afterEach(() => {
    db.close();
  });

  test("init_creates_table_with_expected_columns", () => {
    const cols = db
      .prepare("PRAGMA table_info(attestation_evidence_attestors)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      "id",
      "label",
      "notes",
      "pubkey_hex",
      "registered_at",
      "revoked_at",
      "sig_algo",
    ]);
  });

  test("register_get_isActive_revoke_round_trip", () => {
    expect(isAttestationEvidenceAttestorActive(PUB_A)).toBe(false);
    const row = registerAttestationEvidenceAttestor({
      pubkey: PUB_A,
      label: "acurast-pixel-8",
      notes: "phase 2 phone",
    });
    expect(row.pubkey_hex).toBe(PUB_A);
    expect(getAttestationEvidenceAttestor(PUB_A)).not.toBeNull();
    expect(isAttestationEvidenceAttestorActive(PUB_A)).toBe(true);
    expect(revokeAttestationEvidenceAttestor(PUB_A)).toBe(true);
    expect(isAttestationEvidenceAttestorActive(PUB_A)).toBe(false);
    // Revoke is idempotent.
    expect(revokeAttestationEvidenceAttestor(PUB_A)).toBe(false);
  });

  test("register_normalises_0x_prefix_and_uppercase", () => {
    const row = registerAttestationEvidenceAttestor({
      pubkey: "0X" + PUB_A.toUpperCase(),
    });
    expect(row.pubkey_hex).toBe(PUB_A);
  });

  test("register_throws_on_invalid_hex", () => {
    expect(() =>
      registerAttestationEvidenceAttestor({ pubkey: "not-hex" }),
    ).toThrow(/32 bytes hex/);
  });

  test("register_secp256r1_requires_33_byte_pubkey", () => {
    // 32-byte hex pubkey registered under secp256r1 must be rejected —
    // P-256 compressed points are 33 bytes.
    expect(() =>
      registerAttestationEvidenceAttestor({
        pubkey: PUB_A,
        sig_algo: "secp256r1",
      }),
    ).toThrow(/33 bytes hex/);
  });

  test("register_secp256r1_accepts_33_byte_pubkey", () => {
    // 33-byte compressed point (66 hex chars) — valid for secp256r1, must
    // be REJECTED for sr25519/ed25519 (which expect 32 bytes).
    const pub33 = "02" + PUB_A; // 0x02 = compressed point prefix
    const row = registerAttestationEvidenceAttestor({
      pubkey: pub33,
      sig_algo: "secp256r1",
    });
    expect(row.sig_algo).toBe("secp256r1");
    expect(row.pubkey_hex).toBe(pub33);
    // Same 33-byte pubkey rejected under ed25519
    expect(() =>
      registerAttestationEvidenceAttestor({
        pubkey: "03" + PUB_B,
        sig_algo: "ed25519",
      }),
    ).toThrow(/32 bytes hex/);
  });

  test("register_throws_on_duplicate", () => {
    registerAttestationEvidenceAttestor({ pubkey: PUB_A });
    expect(() =>
      registerAttestationEvidenceAttestor({ pubkey: PUB_A }),
    ).toThrow(/UNIQUE/i);
  });

  test("list_returns_active_only_when_filtered", () => {
    registerAttestationEvidenceAttestor({ pubkey: PUB_A, now: 100 });
    registerAttestationEvidenceAttestor({ pubkey: PUB_B, now: 200 });
    registerAttestationEvidenceAttestor({ pubkey: PUB_C, now: 150 });
    revokeAttestationEvidenceAttestor(PUB_B);
    const all = listAttestationEvidenceAttestors();
    expect(all).toHaveLength(3);
    const active = listAttestationEvidenceAttestors({ active: true });
    expect(active).toHaveLength(2);
    expect(active.map((r) => r.pubkey_hex).sort()).toEqual([PUB_A, PUB_C].sort());
  });
});

// ===========================================================================
// Admin route
// ===========================================================================

describe("/admin/attestation-evidence-attestors — auth gating", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupApp();
  });
  afterEach(() => {
    teardown(ctx);
  });

  test("POST_without_token_returns_401", async () => {
    const res = await callApp(
      ctx.app,
      "POST",
      "/admin/attestation-evidence-attestors",
      { body: { pubkey: PUB_A } },
    );
    expect(res.status).toBe(401);
  });

  test("POST_with_wrong_token_returns_401", async () => {
    const res = await callApp(
      ctx.app,
      "POST",
      "/admin/attestation-evidence-attestors",
      { headers: { "x-admin-token": "wrong" }, body: { pubkey: PUB_A } },
    );
    expect(res.status).toBe(401);
  });

  test("DELETE_without_token_returns_401", async () => {
    const res = await callApp(
      ctx.app,
      "DELETE",
      `/admin/attestation-evidence-attestors/${PUB_A}`,
    );
    expect(res.status).toBe(401);
  });

  test("GET_without_token_returns_401", async () => {
    const res = await callApp(
      ctx.app,
      "GET",
      "/admin/attestation-evidence-attestors",
    );
    expect(res.status).toBe(401);
  });
});

describe("/admin/attestation-evidence-attestors — POST + DELETE + GET", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupApp();
  });
  afterEach(() => {
    teardown(ctx);
  });

  test("POST_register_returns_200_with_persisted_row", async () => {
    const res = await callApp(
      ctx.app,
      "POST",
      "/admin/attestation-evidence-attestors",
      {
        headers: { "x-admin-token": ADMIN_TOKEN },
        body: { pubkey: PUB_A, label: "pixel-8", notes: "test phone" },
      },
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe("created");
    const att = body.attestor as Record<string, unknown>;
    expect(att.pubkey_hex).toBe(PUB_A);
    expect(att.label).toBe("pixel-8");
    expect(att.notes).toBe("test phone");
    expect(att.revoked_at).toBeNull();
  });

  test("POST_with_0x_prefix_normalises", async () => {
    const res = await callApp(
      ctx.app,
      "POST",
      "/admin/attestation-evidence-attestors",
      {
        headers: { "x-admin-token": ADMIN_TOKEN },
        body: { pubkey: "0x" + PUB_A.toUpperCase() },
      },
    );
    expect(res.status).toBe(200);
    expect(
      (res.body as { attestor: { pubkey_hex: string } }).attestor.pubkey_hex,
    ).toBe(PUB_A);
  });

  test("POST_missing_pubkey_returns_400", async () => {
    const res = await callApp(
      ctx.app,
      "POST",
      "/admin/attestation-evidence-attestors",
      { headers: { "x-admin-token": ADMIN_TOKEN }, body: {} },
    );
    expect(res.status).toBe(400);
  });

  test("POST_invalid_pubkey_returns_400", async () => {
    const res = await callApp(
      ctx.app,
      "POST",
      "/admin/attestation-evidence-attestors",
      {
        headers: { "x-admin-token": ADMIN_TOKEN },
        body: { pubkey: "abcd" },
      },
    );
    expect(res.status).toBe(400);
  });

  test("POST_duplicate_returns_409", async () => {
    await callApp(
      ctx.app,
      "POST",
      "/admin/attestation-evidence-attestors",
      { headers: { "x-admin-token": ADMIN_TOKEN }, body: { pubkey: PUB_A } },
    );
    const res = await callApp(
      ctx.app,
      "POST",
      "/admin/attestation-evidence-attestors",
      { headers: { "x-admin-token": ADMIN_TOKEN }, body: { pubkey: PUB_A } },
    );
    expect(res.status).toBe(409);
  });

  test("DELETE_unknown_returns_404", async () => {
    const res = await callApp(
      ctx.app,
      "DELETE",
      `/admin/attestation-evidence-attestors/${PUB_A}`,
      { headers: { "x-admin-token": ADMIN_TOKEN } },
    );
    expect(res.status).toBe(404);
  });

  test("DELETE_active_returns_200_revoked", async () => {
    await callApp(
      ctx.app,
      "POST",
      "/admin/attestation-evidence-attestors",
      { headers: { "x-admin-token": ADMIN_TOKEN }, body: { pubkey: PUB_A } },
    );
    const res = await callApp(
      ctx.app,
      "DELETE",
      `/admin/attestation-evidence-attestors/${PUB_A}`,
      { headers: { "x-admin-token": ADMIN_TOKEN } },
    );
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe("revoked");
  });

  test("DELETE_already_revoked_returns_already_revoked", async () => {
    await callApp(
      ctx.app,
      "POST",
      "/admin/attestation-evidence-attestors",
      { headers: { "x-admin-token": ADMIN_TOKEN }, body: { pubkey: PUB_A } },
    );
    await callApp(
      ctx.app,
      "DELETE",
      `/admin/attestation-evidence-attestors/${PUB_A}`,
      { headers: { "x-admin-token": ADMIN_TOKEN } },
    );
    const res = await callApp(
      ctx.app,
      "DELETE",
      `/admin/attestation-evidence-attestors/${PUB_A}`,
      { headers: { "x-admin-token": ADMIN_TOKEN } },
    );
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe("already-revoked");
  });

  test("GET_returns_empty_for_fresh_db", async () => {
    const res = await callApp(
      ctx.app,
      "GET",
      "/admin/attestation-evidence-attestors",
      { headers: { "x-admin-token": ADMIN_TOKEN } },
    );
    expect(res.status).toBe(200);
    expect((res.body as { attestors: unknown[] }).attestors).toEqual([]);
  });

  test("GET_active_filters_revoked", async () => {
    for (const p of [PUB_A, PUB_B]) {
      await callApp(
        ctx.app,
        "POST",
        "/admin/attestation-evidence-attestors",
        { headers: { "x-admin-token": ADMIN_TOKEN }, body: { pubkey: p } },
      );
    }
    await callApp(
      ctx.app,
      "DELETE",
      `/admin/attestation-evidence-attestors/${PUB_A}`,
      { headers: { "x-admin-token": ADMIN_TOKEN } },
    );
    const res = await callApp(
      ctx.app,
      "GET",
      "/admin/attestation-evidence-attestors?active=1",
      { headers: { "x-admin-token": ADMIN_TOKEN } },
    );
    expect(res.status).toBe(200);
    const arr = (res.body as { attestors: Array<{ pubkey_hex: string }> }).attestors;
    expect(arr).toHaveLength(1);
    expect(arr[0]!.pubkey_hex).toBe(PUB_B);
  });
});

describe("/admin/attestation-evidence-attestors — unconfigured", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupApp({ withToken: false });
  });
  afterEach(() => {
    teardown(ctx);
  });

  test("POST_returns_503_when_admin_token_unset", async () => {
    const res = await callApp(
      ctx.app,
      "POST",
      "/admin/attestation-evidence-attestors",
      { body: { pubkey: PUB_A } },
    );
    expect(res.status).toBe(503);
  });

  test("DELETE_returns_503_when_admin_token_unset", async () => {
    const res = await callApp(
      ctx.app,
      "DELETE",
      `/admin/attestation-evidence-attestors/${PUB_A}`,
    );
    expect(res.status).toBe(503);
  });

  test("GET_returns_503_when_admin_token_unset", async () => {
    const res = await callApp(
      ctx.app,
      "GET",
      "/admin/attestation-evidence-attestors",
    );
    expect(res.status).toBe(503);
  });
});
