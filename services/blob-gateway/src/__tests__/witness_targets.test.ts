/**
 * Tests for the witness_targets store + HTTP routes.
 *
 * Uses the same in-memory SQLite + `app.listen(0)` + fetch pattern as
 * `attestation_evidence_attestors.test.ts` — no supertest dep.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import Database from "better-sqlite3";

import { config } from "../config.js";
import {
  initWitnessTargetsDb,
  setWitnessTargetsDbForTests,
  registerWitnessTarget,
  revokeWitnessTarget,
  getWitnessTarget,
  listWitnessTargets,
  validateProbeUrl,
} from "../witness_targets.js";
import { registerWitnessTargetRoutes } from "../routes/witness_targets.js";

const ADMIN_TOKEN = "witness-test-token-deadbeef";

function makeMemDb(): Database.Database {
  const db = new Database(":memory:");
  initWitnessTargetsDb(db);
  setWitnessTargetsDbForTests(db);
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
  registerWitnessTargetRoutes(app);
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

describe("validateProbeUrl", () => {
  test("accepts http", () => {
    expect(validateProbeUrl("http://example.com/")).toBe("http://example.com/");
  });

  test("accepts https with path + query", () => {
    expect(validateProbeUrl("https://example.com/health?x=1")).toBe(
      "https://example.com/health?x=1",
    );
  });

  test("lowercases the host", () => {
    expect(validateProbeUrl("https://EXAMPLE.com/Health")).toBe(
      "https://example.com/Health",
    );
  });

  test("rejects empty + non-string", () => {
    expect(() => validateProbeUrl("")).toThrow(/required/);
    // @ts-expect-error: deliberate bad input
    expect(() => validateProbeUrl(null)).toThrow(/required/);
  });

  test("rejects oversized URL", () => {
    const huge = "https://example.com/" + "a".repeat(1100);
    expect(() => validateProbeUrl(huge)).toThrow(/too long/);
  });

  test("rejects file://", () => {
    expect(() => validateProbeUrl("file:///etc/passwd")).toThrow(
      /http or https/,
    );
  });

  test("rejects javascript:", () => {
    expect(() => validateProbeUrl("javascript:alert(1)")).toThrow(
      /http or https/,
    );
  });

  test("rejects URLs with userinfo", () => {
    expect(() => validateProbeUrl("https://user:pass@example.com/")).toThrow(
      /userinfo/,
    );
  });

  test("rejects total garbage", () => {
    expect(() => validateProbeUrl("not a url")).toThrow(/valid URL/);
  });
});

describe("witness_targets store", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupApp();
  });
  afterEach(() => {
    teardown(ctx);
  });

  test("register + get round-trip", () => {
    const row = registerWitnessTarget({ url: "https://a.com/", label: "A" });
    expect(row.url).toBe("https://a.com/");
    expect(row.label).toBe("A");
    expect(row.revoked_at).toBeNull();

    const got = getWitnessTarget("https://a.com/");
    expect(got?.id).toBe(row.id);
  });

  test("UNIQUE on url collides", () => {
    registerWitnessTarget({ url: "https://a.com/" });
    expect(() => registerWitnessTarget({ url: "https://a.com/" })).toThrow(
      /UNIQUE/i,
    );
  });

  test("revoke marks revoked_at and listWitnessTargets({active:true}) excludes it", () => {
    registerWitnessTarget({ url: "https://a.com/" });
    registerWitnessTarget({ url: "https://b.com/" });
    expect(listWitnessTargets({ active: true })).toHaveLength(2);

    expect(revokeWitnessTarget("https://a.com/")).toBe(true);
    expect(listWitnessTargets({ active: true })).toHaveLength(1);
    expect(listWitnessTargets({})).toHaveLength(2);
  });

  test("revoke is idempotent (second call returns false)", () => {
    registerWitnessTarget({ url: "https://a.com/" });
    expect(revokeWitnessTarget("https://a.com/")).toBe(true);
    expect(revokeWitnessTarget("https://a.com/")).toBe(false);
  });

  test("getWitnessTarget returns null on bad URL without throwing", () => {
    expect(getWitnessTarget("not a url")).toBeNull();
  });
});

describe("witness_targets routes", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupApp();
  });
  afterEach(() => {
    teardown(ctx);
  });

  test("GET /witness/targets is PUBLIC and returns empty initially", async () => {
    const r = await callApp(ctx.app, "GET", "/witness/targets");
    expect(r.status).toBe(200);
    const body = r.body as { targets: unknown[]; fetched_at: number };
    expect(body.targets).toEqual([]);
    expect(typeof body.fetched_at).toBe("number");
  });

  test("GET /witness/targets returns active targets after registration", async () => {
    await callApp(ctx.app, "POST", "/admin/witness/targets", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { url: "https://a.com/health", label: "Alpha" },
    });
    await callApp(ctx.app, "POST", "/admin/witness/targets", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { url: "https://b.com/" },
    });

    const r = await callApp(ctx.app, "GET", "/witness/targets");
    expect(r.status).toBe(200);
    const body = r.body as { targets: Array<Record<string, unknown>> };
    expect(body.targets).toHaveLength(2);
    expect(body.targets[0]).toHaveProperty("url");
    expect(body.targets[0]).toHaveProperty("label");
    // Public projection MUST NOT leak internal fields.
    expect(body.targets[0]).not.toHaveProperty("id");
    expect(body.targets[0]).not.toHaveProperty("registered_at");
    expect(body.targets[0]).not.toHaveProperty("owner_token_id");
    expect(body.targets[0]).not.toHaveProperty("notes");
  });

  test("GET /witness/targets hides revoked targets", async () => {
    const created = await callApp(ctx.app, "POST", "/admin/witness/targets", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { url: "https://a.com/", label: "A" },
    });
    const id = (created.body as { target: { id: number } }).target.id;
    await callApp(ctx.app, "DELETE", `/admin/witness/targets/${id}`, {
      headers: { "x-admin-token": ADMIN_TOKEN },
    });

    const r = await callApp(ctx.app, "GET", "/witness/targets");
    const body = r.body as { targets: unknown[] };
    expect(body.targets).toEqual([]);
  });

  test("POST /admin/witness/targets requires admin token", async () => {
    const r = await callApp(ctx.app, "POST", "/admin/witness/targets", {
      body: { url: "https://a.com/" },
    });
    expect(r.status).toBe(401);
  });

  test("POST rejects missing url", async () => {
    const r = await callApp(ctx.app, "POST", "/admin/witness/targets", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { label: "no url" },
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/url is required/);
  });

  test("POST rejects bad scheme", async () => {
    const r = await callApp(ctx.app, "POST", "/admin/witness/targets", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { url: "javascript:alert(1)" },
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/http or https/);
  });

  test("POST rejects URL with credentials", async () => {
    const r = await callApp(ctx.app, "POST", "/admin/witness/targets", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { url: "https://user:pass@example.com/" },
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/userinfo/);
  });

  test("POST same URL twice returns 409 with existing row", async () => {
    await callApp(ctx.app, "POST", "/admin/witness/targets", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { url: "https://a.com/", label: "first" },
    });
    const r = await callApp(ctx.app, "POST", "/admin/witness/targets", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { url: "https://a.com/", label: "second" },
    });
    expect(r.status).toBe(409);
    const body = r.body as { existing: { label: string } };
    expect(body.existing.label).toBe("first");
  });

  test("DELETE rejects non-integer id", async () => {
    const r = await callApp(ctx.app, "DELETE", "/admin/witness/targets/notanumber", {
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    expect(r.status).toBe(400);
  });

  test("DELETE by id works", async () => {
    const created = await callApp(ctx.app, "POST", "/admin/witness/targets", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { url: "https://a.com/" },
    });
    const id = (created.body as { target: { id: number } }).target.id;
    const r = await callApp(ctx.app, "DELETE", `/admin/witness/targets/${id}`, {
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    expect(r.status).toBe(200);
    const body = r.body as { target: { url: string } };
    expect(body.target.url).toBe("https://a.com/");
  });

  test("DELETE unknown id 404", async () => {
    const r = await callApp(
      ctx.app,
      "DELETE",
      "/admin/witness/targets/99999",
      { headers: { "x-admin-token": ADMIN_TOKEN } },
    );
    expect(r.status).toBe(404);
  });

  test("GET /admin/witness/targets requires admin", async () => {
    const r = await callApp(ctx.app, "GET", "/admin/witness/targets");
    expect(r.status).toBe(401);
  });

  test("GET /admin/witness/targets shows revoked too", async () => {
    const created = await callApp(ctx.app, "POST", "/admin/witness/targets", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { url: "https://a.com/" },
    });
    const id = (created.body as { target: { id: number } }).target.id;
    await callApp(ctx.app, "DELETE", `/admin/witness/targets/${id}`, {
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    const r = await callApp(ctx.app, "GET", "/admin/witness/targets", {
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    expect(r.status).toBe(200);
    const body = r.body as { targets: Array<{ revoked_at: number | null }> };
    expect(body.targets).toHaveLength(1);
    expect(body.targets[0].revoked_at).not.toBeNull();
  });

  test("GET /admin/witness/targets?active=1 hides revoked", async () => {
    const created = await callApp(ctx.app, "POST", "/admin/witness/targets", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { url: "https://a.com/" },
    });
    const id = (created.body as { target: { id: number } }).target.id;
    await callApp(ctx.app, "DELETE", `/admin/witness/targets/${id}`, {
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    const r = await callApp(ctx.app, "GET", "/admin/witness/targets?active=1", {
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    const body = r.body as { targets: unknown[] };
    expect(body.targets).toEqual([]);
  });
});

describe("witness_targets routes without admin token configured", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupApp({ withToken: false });
  });
  afterEach(() => {
    teardown(ctx);
  });

  test("public GET still works", async () => {
    const r = await callApp(ctx.app, "GET", "/witness/targets");
    expect(r.status).toBe(200);
  });

  test("admin POST returns 503", async () => {
    const r = await callApp(ctx.app, "POST", "/admin/witness/targets", {
      body: { url: "https://a.com/" },
    });
    expect(r.status).toBe(503);
  });
});
