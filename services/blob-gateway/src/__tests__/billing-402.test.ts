/**
 * Unit tests for the Phase 2.A pay-per-use middleware.
 *
 * Covers:
 * - classifyEndpoint mapping (pure function) — every route in index.ts
 *   has an explicit class entry (M1 / #222).
 * - Unrecognized non-GET writes emit `billing.unclassified_route` warn
 *   (M1 / #222).
 * - phase = "off" bypass
 * - phase = "measurement" logs would_402 without blocking
 * - phase = "live" returns 402 with x402 headers when balance < price
 * - phase = "live" + sufficient balance lets request through
 * - pallet-not-present (price=null) bypasses regardless of phase
 * - PerByte pricing uses Content-Length header (chunk_upload)
 * - H1 (#221): self-pay 402 responses MUST NOT leak the unverified
 *   claimed-SS58 or its on-chain balance — the response body and the
 *   X-402-Payment-Required header reflect `null` for `payer`/`balance`,
 *   and the structured log uses `payer_ss58_claimed` (not `payer_ss58`).
 * - M2 (#223): decodePricingModel emits a structured warn when both
 *   codec and JSON shape miss, and still returns 0n (fail-safe).
 * - M3 (#224): an internal exception inside the middleware fails open
 *   (the request passes through, console.error logged once).
 * - L4 (#225): every static-literal endpoint class matches /^[a-z0-9_]+$/.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import { config } from "../config.js";
import { decodePricingModel } from "../billing/chain_query.js";
import { resetWarnThrottleForTests } from "../middleware/warn-throttle.js";
import {
  billingMiddlewareErrorTotal,
  resetMetricsForTests,
} from "../metrics.js";

// Mock api-tokens so identifyPayer doesn't need a real DB.
vi.mock("../api-tokens.js", () => ({
  getApiTokensDb: vi.fn(() => null),
  verifyToken: vi.fn(() => ({ valid: false, reason: "not configured" })),
}));

// #227: reset hot-path warn-throttle + Prom counter state between tests
// so each test sees a clean slate. The throttle reset matters for the
// classifyEndpoint/decodePricingModel warn tests (suppressed-after-first
// would otherwise be order-dependent); the metrics reset matters for the
// M3-error → billing_middleware_error_total assertion.
beforeEach(() => {
  resetWarnThrottleForTests();
  resetMetricsForTests();
});

import { billing402Middleware, __test__ } from "../middleware/billing-402.js";
import type { BillingMiddlewareDeps } from "../middleware/billing-402.js";

type Phase = "off" | "measurement" | "live";

async function withPhase<T>(
  phase: Phase,
  fn: () => Promise<T> | T,
): Promise<T> {
  // CRITICAL: the original implementation used a sync try/finally around
  // an async `fn()`, which restored the prev phase BEFORE the awaited
  // request completed — so the middleware always saw phase="off" by the
  // time it ran. The async form below holds the override across the
  // entire awaited call, which is what every test below assumes.
  const prev = config.billingEnforcementPhase;
  (config as { billingEnforcementPhase: Phase }).billingEnforcementPhase = phase;
  try {
    return await fn();
  } finally {
    (config as { billingEnforcementPhase: Phase }).billingEnforcementPhase = prev;
  }
}

/**
 * Spin up a tiny express app around the middleware and execute one
 * request. Returns the wire-level status + body + headers — same shape
 * a real HTTP client would see.
 */
async function harness(opts: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  deps?: BillingMiddlewareDeps;
}): Promise<{
  status: number;
  body: unknown;
  headers: Record<string, string>;
  text: string;
}> {
  const app = express();
  app.use(express.json());
  app.use(billing402Middleware(opts.deps));
  // Reflect handler — any non-402 request lands here and returns 200.
  app.use((_req, res) => res.status(200).json({ ok: true }));

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr === "string" || !addr) {
        server.close();
        return reject(new Error("no port"));
      }
      const url = `http://127.0.0.1:${addr.port}${opts.path}`;
      fetch(url, {
        method: opts.method,
        headers: opts.headers,
        body: opts.body,
      })
        .then(async (res) => {
          const text = await res.text();
          let body: unknown;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = text;
          }
          const hdrs: Record<string, string> = {};
          res.headers.forEach((v, k) => {
            hdrs[k] = v;
          });
          server.close();
          resolve({ status: res.status, body, headers: hdrs, text });
        })
        .catch((e) => {
          server.close();
          reject(e);
        });
    });
  });
}

// ---------------------------------------------------------------------------
// classifyEndpoint — pure function
// ---------------------------------------------------------------------------

describe("classifyEndpoint", () => {
  function req(method: string, path: string): express.Request {
    return { method, path } as express.Request;
  }

  test("health endpoints are free", () => {
    expect(__test__.classifyEndpoint(req("GET", "/health"))).toBe("free");
    expect(__test__.classifyEndpoint(req("GET", "/status"))).toBe("free");
    expect(__test__.classifyEndpoint(req("GET", "/status/whatever"))).toBe("free");
  });

  test("public reads are free", () => {
    expect(
      __test__.classifyEndpoint(req("GET", "/blobs/abc/manifest")),
    ).toBe("free");
    expect(
      __test__.classifyEndpoint(req("GET", "/blobs/abc/chunks/0")),
    ).toBe("free");
    expect(__test__.classifyEndpoint(req("GET", "/locators/x"))).toBe("free");
    expect(__test__.classifyEndpoint(req("GET", "/chain-info"))).toBe("free");
    expect(__test__.classifyEndpoint(req("GET", "/chunks/r/0"))).toBe("free");
    expect(__test__.classifyEndpoint(req("GET", "/faucet/status"))).toBe("free");
    expect(__test__.classifyEndpoint(req("GET", "/batches/abc"))).toBe("free");
    expect(__test__.classifyEndpoint(req("GET", "/blobs/abc/status"))).toBe(
      "free",
    );
  });

  test("billing/usage is its own class so we can price it", () => {
    expect(
      __test__.classifyEndpoint(req("GET", "/billing/usage")),
    ).toBe("billing_usage_query");
  });

  test("write paths map to correct classes", () => {
    expect(
      __test__.classifyEndpoint(req("POST", "/blobs/abc/manifest")),
    ).toBe("manifest_post");
    expect(
      __test__.classifyEndpoint(req("PUT", "/blobs/abc/chunks/3")),
    ).toBe("chunk_upload");
    expect(
      __test__.classifyEndpoint(req("PATCH", "/blobs/abc/certified")),
    ).toBe("manifest_certified_patch");
    expect(
      __test__.classifyEndpoint(req("POST", "/metering/submit")),
    ).toBe("receipt_submit");
    expect(__test__.classifyEndpoint(req("PUT", "/batches/xyz"))).toBe(
      "batch_metadata",
    );
    expect(__test__.classifyEndpoint(req("POST", "/batches/xyz"))).toBe(
      "batch_metadata",
    );
  });

  test("TEE evidence routes map to their own classes (M1 / #222)", () => {
    expect(
      __test__.classifyEndpoint(req("POST", "/v2/attestation_evidence")),
    ).toBe("tee_evidence_submit");
    expect(
      __test__.classifyEndpoint(
        req("POST", "/v2/attestation_evidence/42/mark_submitted"),
      ),
    ).toBe("tee_evidence_mark_submitted");
    // GET pending is daemon-only, classified as admin (not user-billable).
    expect(
      __test__.classifyEndpoint(req("GET", "/v2/attestation_evidence/pending")),
    ).toBe("admin");
  });

  test("operator-onboarding paths are free", () => {
    expect(__test__.classifyEndpoint(req("POST", "/heartbeats"))).toBe("free");
    expect(__test__.classifyEndpoint(req("POST", "/faucet/drip"))).toBe("free");
  });

  test("operator + admin routes get admin class (M1 / #222)", () => {
    expect(
      __test__.classifyEndpoint(req("POST", "/operators/register")),
    ).toBe("admin");
    expect(
      __test__.classifyEndpoint(req("POST", "/operators/create-invite")),
    ).toBe("admin");
    expect(
      __test__.classifyEndpoint(
        req("PATCH", "/operators/5xyz.../session-keys"),
      ),
    ).toBe("admin");
    expect(
      __test__.classifyEndpoint(req("POST", "/admin/api-keys/aabb/binding")),
    ).toBe("admin");
    expect(
      __test__.classifyEndpoint(req("DELETE", "/admin/api-keys/aabb/binding")),
    ).toBe("admin");
    expect(__test__.classifyEndpoint(req("GET", "/admin/observers"))).toBe(
      "admin",
    );
    expect(__test__.classifyEndpoint(req("POST", "/admin/observers"))).toBe(
      "admin",
    );
    expect(
      __test__.classifyEndpoint(req("POST", "/admin/fleet-operators")),
    ).toBe("admin");
    expect(
      __test__.classifyEndpoint(
        req("POST", "/admin/attestation-evidence-attestors"),
      ),
    ).toBe("admin");
    expect(__test__.classifyEndpoint(req("POST", "/auth/token"))).toBe(
      "admin",
    );
    expect(__test__.classifyEndpoint(req("GET", "/auth/tokens"))).toBe(
      "admin",
    );
  });

  test("unrecognized non-GET routes warn (M1 / #222) and default to free", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        __test__.classifyEndpoint(req("POST", "/something-not-in-routes")),
      ).toBe("free");
      // exactly one warn line, structured JSON, with method/path/log fields.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const arg = warnSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(arg);
      expect(parsed.log).toBe("billing.unclassified_route");
      expect(parsed.method).toBe("POST");
      expect(parsed.path).toBe("/something-not-in-routes");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("unrecognized GETs default to free without a warn (read-by-default contract)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        __test__.classifyEndpoint(req("GET", "/something-not-in-routes")),
      ).toBe("free");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("L4 (#225): every classifyEndpoint return matches /^[a-z0-9_]+$/", () => {
    // Exhaust every observed return in this suite. The assertion lives
    // inside classifyEndpoint itself — if any literal slipped past the
    // /[a-z0-9_]+/ guard the call below would throw.
    const samples: [string, string][] = [
      ["GET", "/health"],
      ["GET", "/status"],
      ["GET", "/blobs/x/manifest"],
      ["GET", "/blobs/x/status"],
      ["GET", "/blobs/x/chunks/0"],
      ["GET", "/chunks/r/0"],
      ["GET", "/locators/x"],
      ["GET", "/batches/x"],
      ["GET", "/billing/usage"],
      ["GET", "/chain-info"],
      ["GET", "/faucet/status"],
      ["GET", "/heartbeats/status"],
      ["GET", "/operators/foo/session-keys"],
      ["GET", "/operators/status/foo"],
      ["GET", "/v2/attestation_evidence/pending"],
      ["POST", "/blobs/x/manifest"],
      ["PUT", "/blobs/x/chunks/0"],
      ["PATCH", "/blobs/x/certified"],
      ["POST", "/metering/submit"],
      ["POST", "/batches/x"],
      ["PUT", "/batches/x"],
      ["POST", "/v2/attestation_evidence"],
      ["POST", "/v2/attestation_evidence/1/mark_submitted"],
      ["POST", "/heartbeats"],
      ["POST", "/faucet/drip"],
      ["POST", "/operators/register"],
      ["POST", "/operators/create-invite"],
      ["PATCH", "/operators/foo/session-keys"],
      ["POST", "/admin/api-keys/x/binding"],
      ["DELETE", "/admin/api-keys/x/binding"],
      ["GET", "/admin/observers"],
      ["POST", "/admin/observers"],
      ["DELETE", "/admin/observers/x"],
      ["POST", "/admin/fleet-operators"],
      ["DELETE", "/admin/fleet-operators/x"],
      ["GET", "/admin/fleet-operators"],
      ["POST", "/admin/attestation-evidence-attestors"],
      ["DELETE", "/admin/attestation-evidence-attestors/x"],
      ["GET", "/admin/attestation-evidence-attestors"],
      ["POST", "/auth/token"],
      ["DELETE", "/auth/token/x"],
      ["GET", "/auth/tokens"],
      ["GET", "/auth/token/x/usage"],
    ];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const [m, p] of samples) {
        const c = __test__.classifyEndpoint(req(m, p));
        expect(c).toMatch(/^[a-z0-9_]+$/);
      }
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Middleware behavior across phases — DI'd stubs
// ---------------------------------------------------------------------------

function stubDeps(
  priceFn: (
    endpointClass: string,
    requestBytes: number,
  ) => Promise<{ endpointClass: string; price: bigint | null }>,
  balanceFn: (ss58: string) => Promise<{ ss58: string; balance: bigint | null }>,
): { deps: BillingMiddlewareDeps; price: ReturnType<typeof vi.fn>; balance: ReturnType<typeof vi.fn> } {
  const price = vi.fn(priceFn);
  const balance = vi.fn(balanceFn);
  return {
    deps: { queryEndpointPrice: price, queryBillingBalance: balance },
    price,
    balance,
  };
}

describe("billing402Middleware: phase = off", () => {
  test("bypasses entirely, no chain reads", async () => {
    const { deps, price, balance } = stubDeps(
      async () => ({ endpointClass: "receipt_submit", price: 1n }),
      async (ss58) => ({ ss58, balance: 0n }),
    );
    const res = await withPhase("off", () =>
      harness({ method: "POST", path: "/metering/submit", deps }),
    );
    expect(res.status).toBe(200);
    expect(price).not.toHaveBeenCalled();
    expect(balance).not.toHaveBeenCalled();
  });
});

describe("billing402Middleware: pallet not present", () => {
  test("phase=live bypasses when pallet not on chain", async () => {
    const { deps } = stubDeps(
      async () => ({ endpointClass: "receipt_submit", price: null }),
      async (ss58) => ({ ss58, balance: null }),
    );
    const res = await withPhase("live", () =>
      harness({ method: "POST", path: "/metering/submit", deps }),
    );
    expect(res.status).toBe(200);
  });
});

describe("billing402Middleware: phase = live, free endpoint", () => {
  test("free endpoint never queries chain", async () => {
    const { deps, price, balance } = stubDeps(
      async () => ({ endpointClass: "free", price: 1n }),
      async (ss58) => ({ ss58, balance: 0n }),
    );
    const res = await withPhase("live", () =>
      harness({ method: "GET", path: "/health", deps }),
    );
    expect(res.status).toBe(200);
    expect(price).not.toHaveBeenCalled();
    expect(balance).not.toHaveBeenCalled();
  });

  test("admin endpoint never queries chain (M1 / #222)", async () => {
    const { deps, price, balance } = stubDeps(
      async () => ({ endpointClass: "admin", price: 1n }),
      async (ss58) => ({ ss58, balance: 0n }),
    );
    const res = await withPhase("live", () =>
      harness({ method: "POST", path: "/admin/api-keys/x/binding", deps }),
    );
    expect(res.status).toBe(200);
    expect(price).not.toHaveBeenCalled();
    expect(balance).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Full 402-emission integration tests (BONUS — previously deferred in PR #43)
// ---------------------------------------------------------------------------

describe("billing402Middleware: phase = live + chain stub", () => {
  test("balance < price → 402 with structured body + x402 headers", async () => {
    const { deps } = stubDeps(
      async () => ({ endpointClass: "receipt_submit", price: 1000n }),
      async (ss58) => ({ ss58, balance: 50n }),
    );
    const res = await withPhase("live", () =>
      harness({
        method: "POST",
        path: "/metering/submit",
        headers: {
          "x-402-payment-signature": "0xsig",
          "x-402-payer-ss58": "5SelfPayer",
        },
        deps,
      }),
    );
    expect(res.status).toBe(402);
    const body = res.body as Record<string, unknown>;
    expect(body.error).toBe("payment_required");
    expect(body.endpoint_class).toBe("receipt_submit");
    expect(body.price).toBe("1000");
    expect(body.currency).toBe("MATRA");
    // H1 (#221): self-pay path MUST NOT reflect unverified balance / SS58.
    expect(body.balance).toBeNull();
    expect(body.payer).toBeNull();
    expect(typeof body.request_id).toBe("string");
    expect(typeof body.expires).toBe("number");
    // x402 headers present
    expect(res.headers["www-authenticate"]).toContain("X-402");
    expect(res.headers["www-authenticate"]).toContain("receipt_submit");
    expect(res.headers["x-402-payment-required"]).toBeTruthy();
    const x402 = JSON.parse(res.headers["x-402-payment-required"] as string);
    expect(x402.scheme).toBe("materios-x402");
    expect(x402.endpointClass).toBe("receipt_submit");
    expect(x402.pricing.amount).toBe("1000");
    expect(x402.pricing.token).toBe("MATRA");
    // H1 (#221): header also scrubbed of unverified payer.
    expect(x402.payer).toBeUndefined();
  });

  test("balance = null (no payer headers) → 402, balance + payer null", async () => {
    const { deps } = stubDeps(
      async () => ({ endpointClass: "receipt_submit", price: 1000n }),
      async (ss58) => ({ ss58, balance: null }),
    );
    const res = await withPhase("live", () =>
      harness({ method: "POST", path: "/metering/submit", deps }),
    );
    expect(res.status).toBe(402);
    const body = res.body as Record<string, unknown>;
    expect(body.balance).toBeNull();
    expect(body.payer).toBeNull();
    expect(body.price).toBe("1000");
  });

  test("balance >= price → request passes through (200)", async () => {
    const { deps } = stubDeps(
      async () => ({ endpointClass: "receipt_submit", price: 1000n }),
      async (ss58) => ({ ss58, balance: 10_000n }),
    );
    const res = await withPhase("live", () =>
      harness({
        method: "POST",
        path: "/metering/submit",
        headers: {
          "x-402-payment-signature": "0xsig",
          "x-402-payer-ss58": "5SelfPayer",
        },
        deps,
      }),
    );
    expect(res.status).toBe(200);
  });

  test("measurement phase: balance < price logs would_402, request passes", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { deps } = stubDeps(
      async () => ({ endpointClass: "receipt_submit", price: 1000n }),
      async (ss58) => ({ ss58, balance: 50n }),
    );
    try {
      const res = await withPhase("measurement", () =>
        harness({
          method: "POST",
          path: "/metering/submit",
          headers: {
            "x-402-payment-signature": "0xsig",
            "x-402-payer-ss58": "5SelfPayer",
          },
          deps,
        }),
      );
      expect(res.status).toBe(200);
      // Find the structured billing.decision log line.
      const billingLines = logSpy.mock.calls
        .map((c) => c[0])
        .filter(
          (s): s is string =>
            typeof s === "string" && s.includes("billing.decision"),
        )
        .map((s) => JSON.parse(s));
      expect(billingLines.length).toBeGreaterThan(0);
      const last = billingLines[billingLines.length - 1];
      expect(last.phase).toBe("measurement");
      expect(last.would_402).toBe(true);
      expect(last.acted_402).toBe(false);
      // H1 (#221): self-pay claimed SS58 lives in payer_ss58_claimed,
      // NEVER payer_ss58 (which is reserved for verified api-key).
      expect(last.payer_ss58).toBeNull();
      expect(last.payer_ss58_claimed).toBe("5SelfPayer");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("PerByte endpoint: Content-Length flows through to queryEndpointPrice", async () => {
    const { deps, price } = stubDeps(
      async (endpointClass, requestBytes) => ({
        endpointClass,
        // emulate PerByte unit_price = 2 MATRA-base / byte.
        price: BigInt(requestBytes) * 2n,
      }),
      async (ss58) => ({ ss58, balance: 1_000_000n }),
    );
    const res = await withPhase("live", () =>
      harness({
        method: "PUT",
        path: "/blobs/abcd/chunks/0",
        headers: {
          "x-402-payment-signature": "0xsig",
          "x-402-payer-ss58": "5SelfPayer",
          "content-type": "application/octet-stream",
          "content-length": "128",
        },
        body: Buffer.alloc(128),
        deps,
      }),
    );
    // 128 * 2 = 256 < 1_000_000 → passes.
    expect(res.status).toBe(200);
    expect(price).toHaveBeenCalled();
    const [endpointClass, requestBytes] = price.mock.calls[0] ?? [];
    expect(endpointClass).toBe("chunk_upload");
    expect(requestBytes).toBe(128);
  });
});

// ---------------------------------------------------------------------------
// H1 (#221) — payer / balance leak protection
// ---------------------------------------------------------------------------

describe("H1 (#221): self-pay 402 does not leak claimed SS58 balance", () => {
  test("response body excludes the SS58 and the balance string", async () => {
    // Pick a balance strictly less than the price so the middleware
    // emits a 402 — and pick a value that's hard to confuse with any
    // other number in the response (price=1000, expires=unix-seconds).
    const SENTINEL_BALANCE = 12345n;
    const { deps } = stubDeps(
      async () => ({ endpointClass: "receipt_submit", price: 1_000_000_000n }),
      async (ss58) => ({ ss58, balance: SENTINEL_BALANCE }),
    );
    const res = await withPhase("live", () =>
      harness({
        method: "POST",
        path: "/metering/submit",
        headers: {
          "x-402-payment-signature": "0xsig",
          "x-402-payer-ss58": "5FakePayerDoesNotExist",
        },
        deps,
      }),
    );
    expect(res.status).toBe(402);
    // The whole response text must not contain the SS58 or the balance
    // — both 402 body and headers are wire-visible.
    expect(res.text).not.toContain("5FakePayerDoesNotExist");
    expect(res.text).not.toContain(SENTINEL_BALANCE.toString());
    // And the X-402 header (which is in res.headers but the harness
    // already serialized headers to lowercase) MUST also be scrubbed.
    const x402 = res.headers["x-402-payment-required"];
    expect(x402).toBeTruthy();
    expect(x402).not.toContain("5FakePayerDoesNotExist");
  });

  test("billing.decision log uses payer_ss58_claimed (not payer_ss58)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { deps } = stubDeps(
      async () => ({ endpointClass: "receipt_submit", price: 1000n }),
      async (ss58) => ({ ss58, balance: 50n }),
    );
    try {
      await withPhase("live", () =>
        harness({
          method: "POST",
          path: "/metering/submit",
          headers: {
            "x-402-payment-signature": "0xsig",
            "x-402-payer-ss58": "5ClaimedPayer",
          },
          deps,
        }),
      );
      const billingLines = logSpy.mock.calls
        .map((c) => c[0])
        .filter(
          (s): s is string =>
            typeof s === "string" && s.includes("billing.decision"),
        )
        .map((s) => JSON.parse(s));
      const last = billingLines[billingLines.length - 1];
      expect(last.payer_ss58).toBeNull();
      expect(last.payer_ss58_claimed).toBe("5ClaimedPayer");
      expect(last.payer_kind).toBe("self");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("payerLogFields splits api-key (verified) vs self (claimed)", () => {
    expect(
      __test__.payerLogFields({ kind: "api-key", ss58: "5Treasury" }),
    ).toEqual({ payer_ss58: "5Treasury", payer_ss58_claimed: null });
    expect(__test__.payerLogFields({ kind: "self", ss58: "5Claimed" })).toEqual({
      payer_ss58: null,
      payer_ss58_claimed: "5Claimed",
    });
    expect(__test__.payerLogFields({ kind: "none", ss58: null })).toEqual({
      payer_ss58: null,
      payer_ss58_claimed: null,
    });
  });
});

// ---------------------------------------------------------------------------
// M2 (#223) — unknown PricingModel variant emits warn + returns 0n
// ---------------------------------------------------------------------------

describe("decodePricingModel: unknown variant (M2 / #223)", () => {
  test("future enum variant logs warn and returns 0n fail-safe", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Mocked "future" PricingModel: not codec-shaped (no isPerCall) and
      // not a JSON dict matching PerCall/PerByte.
      const future = {
        // Hypothetical PricingModel::PerCallPerByte { base, per_byte }
        PerCallPerByte: { base: 100, per_byte: 5 },
      };
      const out = decodePricingModel(future, 1024);
      expect(out).toBe(0n);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const arg = warnSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(arg);
      expect(parsed.log).toBe("billing.unknown_pricing_variant");
      expect(parsed.raw_keys).toEqual(["PerCallPerByte"]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("known PerCall variant does NOT emit warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = decodePricingModel({ PerCall: 42 }, 0);
      expect(out).toBe(42n);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("known PerByte JSON variant does NOT emit warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = decodePricingModel({ PerByte: { unit_price: 5 } }, 10);
      expect(out).toBe(50n);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// M3 (#224) — async-error wrap fails open
// ---------------------------------------------------------------------------

describe("M3 (#224): internal error fails open", () => {
  test("thrown queryEndpointPrice does not 500 the request", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps: BillingMiddlewareDeps = {
      queryEndpointPrice: vi.fn(async () => {
        throw new Error("simulated boom");
      }),
      queryBillingBalance: vi.fn(async (ss58) => ({ ss58, balance: null })),
    };
    try {
      const res = await withPhase("live", () =>
        harness({ method: "POST", path: "/metering/submit", deps }),
      );
      // Fail-open: request passed through to the 200 reflect-handler.
      expect(res.status).toBe(200);
      // And the error was logged exactly once.
      const lines = errSpy.mock.calls
        .map((c) => c[0])
        .filter(
          (s): s is string =>
            typeof s === "string" && s.includes("billing-402 internal error"),
        );
      expect(lines.length).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("#227: fail-open increments billing_middleware_error_total{phase=live}", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps: BillingMiddlewareDeps = {
      queryEndpointPrice: vi.fn(async () => {
        throw new Error("simulated boom");
      }),
      queryBillingBalance: vi.fn(async (ss58) => ({ ss58, balance: null })),
    };
    try {
      // Baseline: counter should be zero (resetMetricsForTests in
      // top-level beforeEach already zeroed it).
      const baseline = await readCounter("live");
      expect(baseline).toBe(0);

      // Trigger one fail-open in `live` mode.
      const res = await withPhase("live", () =>
        harness({ method: "POST", path: "/metering/submit", deps }),
      );
      expect(res.status).toBe(200);

      const afterOne = await readCounter("live");
      expect(afterOne).toBe(1);

      // Trigger a second fail-open in `live` — counter advances.
      const res2 = await withPhase("live", () =>
        harness({ method: "POST", path: "/metering/submit", deps }),
      );
      expect(res2.status).toBe(200);
      const afterTwo = await readCounter("live");
      expect(afterTwo).toBe(2);

      // Trigger a fail-open in `measurement` — separate label series.
      const res3 = await withPhase("measurement", () =>
        harness({ method: "POST", path: "/metering/submit", deps }),
      );
      expect(res3.status).toBe(200);
      // `live` label unchanged …
      expect(await readCounter("live")).toBe(2);
      // … and `measurement` got its own increment.
      expect(await readCounter("measurement")).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});

/**
 * Read the current value of `billing_middleware_error_total{phase=…}`.
 * prom-client `Counter.get()` returns the full series; we filter to the
 * single label-set we care about.
 */
async function readCounter(phase: "off" | "measurement" | "live"): Promise<number> {
  const snapshot = await billingMiddlewareErrorTotal.get();
  const match = snapshot.values.find((v) => v.labels.phase === phase);
  return match ? match.value : 0;
}

// ---------------------------------------------------------------------------
// identifyPayer
// ---------------------------------------------------------------------------

describe("identifyPayer", () => {
  function req(headers: Record<string, string>): express.Request {
    return { headers, method: "POST", path: "/x" } as unknown as express.Request;
  }

  test("self-pay headers identified", () => {
    const p = __test__.identifyPayer(
      req({
        "x-402-payment-signature": "0xsig",
        "x-402-payer-ss58": "5SelfPayer",
      }),
    );
    expect(p.kind).toBe("self");
    expect(p.ss58).toBe("5SelfPayer");
  });

  test("missing headers → kind=none", () => {
    const p = __test__.identifyPayer(req({}));
    expect(p.kind).toBe("none");
    expect(p.ss58).toBeNull();
  });

  test("self-pay sig without payer-ss58 falls through to none", () => {
    const p = __test__.identifyPayer(
      req({ "x-402-payment-signature": "0xsig" }),
    );
    expect(p.kind).toBe("none");
  });
});
