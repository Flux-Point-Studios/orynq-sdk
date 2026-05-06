/**
 * Integration tests for the admin endpoints that manage the
 * fleet_operators + observers registries used by compute_metering_v2.
 *
 * Real express server, real in-memory SQLite, real adminGuard. We test:
 *   - 401 when no/invalid x-admin-token
 *   - 200 + persisted row on POST
 *   - 409 on duplicate POST
 *   - 200 on DELETE happy path
 *   - 200 already-revoked on second DELETE (idempotent)
 *   - 404 on DELETE for unknown pubkey
 *   - 200 list with shape assertions
 *   - active=1 query filter
 *   - 503 when DAEMON_NOTIFY_TOKEN unset (route mounted but unconfigured)
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import Database from "better-sqlite3";

import { config } from "../config.js";
import {
  initFleetOperatorsDb,
  setFleetOperatorsDbForTests,
} from "../fleet_operators.js";
import {
  initObserversDb,
  setObserversDbForTests,
} from "../observers.js";
import { registerFleetOperatorRoutes } from "../routes/fleet_operators.js";
import { registerObserverRoutes } from "../routes/observers.js";

const ADMIN_TOKEN = "admin-test-token-deadbeef";
const PUB_A = "a".repeat(64);
const PUB_B = "b".repeat(64);
const PUB_C = "c".repeat(64);

interface Ctx {
  app: express.Express;
  fleetDb: Database.Database;
  observersDb: Database.Database;
  prevToken: string;
}

function setupApp(opts: { withToken?: boolean } = {}): Ctx {
  const fleetDb = new Database(":memory:");
  initFleetOperatorsDb(fleetDb);
  setFleetOperatorsDbForTests(fleetDb);

  const observersDb = new Database(":memory:");
  initObserversDb(observersDb);
  setObserversDbForTests(observersDb);

  const prevToken = config.daemonNotifyToken;
  config.daemonNotifyToken = opts.withToken === false ? "" : ADMIN_TOKEN;

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  registerFleetOperatorRoutes(app);
  registerObserverRoutes(app);

  return { app, fleetDb, observersDb, prevToken };
}

function teardown(ctx: Ctx): void {
  config.daemonNotifyToken = ctx.prevToken;
  ctx.fleetDb.close();
  ctx.observersDb.close();
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
      if (opts.body !== undefined) {
        init.body = JSON.stringify(opts.body);
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

// ===========================================================================
// fleet operators
// ===========================================================================

describe("/admin/fleet-operators — auth gating", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupApp();
  });
  afterEach(() => {
    teardown(ctx);
  });

  test("POST_without_token_returns_401", async () => {
    const res = await callApp(ctx.app, "POST", "/admin/fleet-operators", {
      body: { pubkey: PUB_A },
    });
    expect(res.status).toBe(401);
  });

  test("POST_with_wrong_token_returns_401", async () => {
    const res = await callApp(ctx.app, "POST", "/admin/fleet-operators", {
      headers: { "x-admin-token": "wrong" },
      body: { pubkey: PUB_A },
    });
    expect(res.status).toBe(401);
  });

  test("DELETE_without_token_returns_401", async () => {
    const res = await callApp(ctx.app, "DELETE", `/admin/fleet-operators/${PUB_A}`);
    expect(res.status).toBe(401);
  });

  test("GET_without_token_returns_401", async () => {
    const res = await callApp(ctx.app, "GET", "/admin/fleet-operators");
    expect(res.status).toBe(401);
  });
});

describe("/admin/fleet-operators — POST register", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupApp();
  });
  afterEach(() => {
    teardown(ctx);
  });

  test("POST_with_valid_pubkey_returns_200_with_persisted_row", async () => {
    const res = await callApp(ctx.app, "POST", "/admin/fleet-operators", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { pubkey: PUB_A, label: "fleet-acme" },
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe("created");
    const op = body.operator as Record<string, unknown>;
    expect(op.pubkey_hex).toBe(PUB_A);
    expect(op.label).toBe("fleet-acme");
    expect(op.revoked_at).toBeNull();
  });

  test("POST_with_0x_prefixed_pubkey_normalises", async () => {
    const res = await callApp(ctx.app, "POST", "/admin/fleet-operators", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { pubkey: "0x" + PUB_A.toUpperCase() },
    });
    expect(res.status).toBe(200);
    const body = res.body as { operator: { pubkey_hex: string } };
    expect(body.operator.pubkey_hex).toBe(PUB_A);
  });

  test("POST_with_missing_pubkey_returns_400", async () => {
    const res = await callApp(ctx.app, "POST", "/admin/fleet-operators", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { label: "no-key" },
    });
    expect(res.status).toBe(400);
  });

  test("POST_with_short_pubkey_returns_400", async () => {
    const res = await callApp(ctx.app, "POST", "/admin/fleet-operators", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { pubkey: "abcd" },
    });
    expect(res.status).toBe(400);
  });

  test("POST_duplicate_pubkey_returns_409", async () => {
    const r1 = await callApp(ctx.app, "POST", "/admin/fleet-operators", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { pubkey: PUB_A, label: "first" },
    });
    expect(r1.status).toBe(200);
    const r2 = await callApp(ctx.app, "POST", "/admin/fleet-operators", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { pubkey: PUB_A, label: "second" },
    });
    expect(r2.status).toBe(409);
    const body2 = r2.body as Record<string, unknown>;
    expect(body2.error).toMatch(/already registered/);
    expect(body2.existing).toBeDefined();
  });
});

describe("/admin/fleet-operators — DELETE revoke", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupApp();
  });
  afterEach(() => {
    teardown(ctx);
  });

  test("DELETE_unknown_pubkey_returns_404", async () => {
    const res = await callApp(
      ctx.app,
      "DELETE",
      `/admin/fleet-operators/${PUB_A}`,
      { headers: { "x-admin-token": ADMIN_TOKEN } },
    );
    expect(res.status).toBe(404);
  });

  test("DELETE_active_returns_200_with_revoked_at_set", async () => {
    await callApp(ctx.app, "POST", "/admin/fleet-operators", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { pubkey: PUB_A, label: "to-revoke" },
    });
    const res = await callApp(
      ctx.app,
      "DELETE",
      `/admin/fleet-operators/${PUB_A}`,
      { headers: { "x-admin-token": ADMIN_TOKEN } },
    );
    expect(res.status).toBe(200);
    const body = res.body as { status: string; operator: { revoked_at: number | null } };
    expect(body.status).toBe("revoked");
    expect(body.operator.revoked_at).not.toBeNull();
  });

  test("DELETE_already_revoked_returns_200_already_revoked", async () => {
    await callApp(ctx.app, "POST", "/admin/fleet-operators", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { pubkey: PUB_A },
    });
    await callApp(ctx.app, "DELETE", `/admin/fleet-operators/${PUB_A}`, {
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    const res = await callApp(
      ctx.app,
      "DELETE",
      `/admin/fleet-operators/${PUB_A}`,
      { headers: { "x-admin-token": ADMIN_TOKEN } },
    );
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe("already-revoked");
  });

  test("DELETE_invalid_pubkey_format_returns_400", async () => {
    const res = await callApp(
      ctx.app,
      "DELETE",
      "/admin/fleet-operators/not-hex",
      { headers: { "x-admin-token": ADMIN_TOKEN } },
    );
    expect(res.status).toBe(400);
  });
});

describe("/admin/fleet-operators — GET list", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupApp();
  });
  afterEach(() => {
    teardown(ctx);
  });

  test("GET_returns_empty_array_for_fresh_db", async () => {
    const res = await callApp(ctx.app, "GET", "/admin/fleet-operators", {
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    expect(res.status).toBe(200);
    expect((res.body as { operators: unknown[] }).operators).toEqual([]);
  });

  test("GET_returns_all_rows_including_revoked", async () => {
    for (const p of [PUB_A, PUB_B, PUB_C]) {
      await callApp(ctx.app, "POST", "/admin/fleet-operators", {
        headers: { "x-admin-token": ADMIN_TOKEN },
        body: { pubkey: p },
      });
    }
    await callApp(ctx.app, "DELETE", `/admin/fleet-operators/${PUB_A}`, {
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    const res = await callApp(ctx.app, "GET", "/admin/fleet-operators", {
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    expect(res.status).toBe(200);
    const ops = (res.body as { operators: Array<{ pubkey_hex: string; revoked_at: number | null }> }).operators;
    expect(ops).toHaveLength(3);
  });

  test("GET_active_query_filters_revoked", async () => {
    for (const p of [PUB_A, PUB_B]) {
      await callApp(ctx.app, "POST", "/admin/fleet-operators", {
        headers: { "x-admin-token": ADMIN_TOKEN },
        body: { pubkey: p },
      });
    }
    await callApp(ctx.app, "DELETE", `/admin/fleet-operators/${PUB_A}`, {
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    const res = await callApp(ctx.app, "GET", "/admin/fleet-operators?active=1", {
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    expect(res.status).toBe(200);
    const ops = (res.body as { operators: Array<{ pubkey_hex: string }> }).operators;
    expect(ops).toHaveLength(1);
    expect(ops[0]!.pubkey_hex).toBe(PUB_B);
  });
});

describe("/admin/fleet-operators — unconfigured (no admin token env)", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupApp({ withToken: false });
  });
  afterEach(() => {
    teardown(ctx);
  });

  test("POST_returns_503_when_admin_token_unset", async () => {
    const res = await callApp(ctx.app, "POST", "/admin/fleet-operators", {
      body: { pubkey: PUB_A },
    });
    expect(res.status).toBe(503);
  });

  test("DELETE_returns_503_when_admin_token_unset", async () => {
    const res = await callApp(
      ctx.app,
      "DELETE",
      `/admin/fleet-operators/${PUB_A}`,
    );
    expect(res.status).toBe(503);
  });

  test("GET_returns_503_when_admin_token_unset", async () => {
    const res = await callApp(ctx.app, "GET", "/admin/fleet-operators");
    expect(res.status).toBe(503);
  });
});

// ===========================================================================
// observers — same coverage shape
// ===========================================================================

describe("/admin/observers — auth gating", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupApp();
  });
  afterEach(() => {
    teardown(ctx);
  });

  test("POST_without_token_returns_401", async () => {
    const res = await callApp(ctx.app, "POST", "/admin/observers", {
      body: { pubkey: PUB_A },
    });
    expect(res.status).toBe(401);
  });

  test("DELETE_without_token_returns_401", async () => {
    const res = await callApp(ctx.app, "DELETE", `/admin/observers/${PUB_A}`);
    expect(res.status).toBe(401);
  });

  test("GET_without_token_returns_401", async () => {
    const res = await callApp(ctx.app, "GET", "/admin/observers");
    expect(res.status).toBe(401);
  });
});

describe("/admin/observers — POST + DELETE + GET", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupApp();
  });
  afterEach(() => {
    teardown(ctx);
  });

  test("POST_register_returns_200", async () => {
    const res = await callApp(ctx.app, "POST", "/admin/observers", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { pubkey: PUB_A, label: "watch-1" },
    });
    expect(res.status).toBe(200);
    expect(((res.body as { observer: { pubkey_hex: string } }).observer.pubkey_hex)).toBe(PUB_A);
  });

  test("POST_duplicate_returns_409", async () => {
    await callApp(ctx.app, "POST", "/admin/observers", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { pubkey: PUB_A },
    });
    const res = await callApp(ctx.app, "POST", "/admin/observers", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { pubkey: PUB_A },
    });
    expect(res.status).toBe(409);
  });

  test("POST_with_invalid_pubkey_returns_400", async () => {
    const res = await callApp(ctx.app, "POST", "/admin/observers", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { pubkey: "not-hex" },
    });
    expect(res.status).toBe(400);
  });

  test("DELETE_unknown_returns_404", async () => {
    const res = await callApp(
      ctx.app,
      "DELETE",
      `/admin/observers/${PUB_A}`,
      { headers: { "x-admin-token": ADMIN_TOKEN } },
    );
    expect(res.status).toBe(404);
  });

  test("DELETE_active_returns_200_revoked", async () => {
    await callApp(ctx.app, "POST", "/admin/observers", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { pubkey: PUB_A },
    });
    const res = await callApp(
      ctx.app,
      "DELETE",
      `/admin/observers/${PUB_A}`,
      { headers: { "x-admin-token": ADMIN_TOKEN } },
    );
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe("revoked");
  });

  test("DELETE_idempotent_returns_already_revoked", async () => {
    await callApp(ctx.app, "POST", "/admin/observers", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      body: { pubkey: PUB_A },
    });
    await callApp(ctx.app, "DELETE", `/admin/observers/${PUB_A}`, {
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    const res = await callApp(
      ctx.app,
      "DELETE",
      `/admin/observers/${PUB_A}`,
      { headers: { "x-admin-token": ADMIN_TOKEN } },
    );
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe("already-revoked");
  });

  test("GET_lists_active_filtered_correctly", async () => {
    for (const p of [PUB_A, PUB_B]) {
      await callApp(ctx.app, "POST", "/admin/observers", {
        headers: { "x-admin-token": ADMIN_TOKEN },
        body: { pubkey: p },
      });
    }
    await callApp(ctx.app, "DELETE", `/admin/observers/${PUB_A}`, {
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    const res = await callApp(ctx.app, "GET", "/admin/observers?active=true", {
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    expect(res.status).toBe(200);
    const obs = (res.body as { observers: Array<{ pubkey_hex: string }> }).observers;
    expect(obs).toHaveLength(1);
    expect(obs[0]!.pubkey_hex).toBe(PUB_B);
  });
});

describe("/admin/observers — unconfigured", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupApp({ withToken: false });
  });
  afterEach(() => {
    teardown(ctx);
  });

  test("POST_returns_503_when_admin_token_unset", async () => {
    const res = await callApp(ctx.app, "POST", "/admin/observers", {
      body: { pubkey: PUB_A },
    });
    expect(res.status).toBe(503);
  });
});
