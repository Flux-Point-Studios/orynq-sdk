/**
 * Tests for the sponsored-receipt submitter hook.
 *
 * The hook fires from routes/blobs.ts when a Bearer/api-key-authed upload
 * completes. We do NOT mock fetch — we spin up a real HTTP server on a
 * random port, wire the gateway config to point at it, and assert on
 * the request received (headers + body). If the gateway's behaviour is
 * wrong, these tests fail against real network behaviour, not mocks.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { AddressInfo } from "node:net";

type Captured = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

interface FakeSubmitter {
  server: Server;
  port: number;
  captured: Captured[];
  setStatus(code: number, body?: string): void;
  setDelay(ms: number): void;
  stop(): Promise<void>;
}

async function startFakeSubmitter(): Promise<FakeSubmitter> {
  let responseStatus = 202;
  let responseBody = '{"accepted":true}';
  let delayMs = 0;
  const captured: Captured[] = [];

  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      captured.push({
        method: req.method || "",
        url: req.url || "",
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString("utf-8"),
      });
      const send = () => {
        res.statusCode = responseStatus;
        res.setHeader("content-type", "application/json");
        res.end(responseBody);
      };
      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    server,
    port,
    captured,
    setStatus(code, body) {
      responseStatus = code;
      if (body !== undefined) responseBody = body;
    },
    setDelay(ms) {
      delayMs = ms;
    },
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("sponsored-receipts notify hook", () => {
  let fake: FakeSubmitter;

  beforeEach(async () => {
    fake = await startFakeSubmitter();
    vi.resetModules();
  });

  afterEach(async () => {
    await fake.stop();
    delete process.env.SPONSORED_RECEIPT_SUBMITTER_URL;
    delete process.env.SPONSORED_RECEIPT_SUBMITTER_TOKEN;
    delete process.env.SPONSORED_RECEIPT_NOTIFY_TIMEOUT_MS;
  });

  test("notify_disabled_when_url_unset", async () => {
    // No URL env → the helper is a no-op and must not hit the network.
    const { notifySponsoredReceiptSubmitter } = await import("../sponsored-receipts.js");
    await notifySponsoredReceiptSubmitter({
      contentHash: "a".repeat(64),
      operator: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      authTier: "bearer",
    });
    expect(fake.captured).toHaveLength(0);
  });

  test("notify_posts_payload_and_source_to_submitter", async () => {
    process.env.SPONSORED_RECEIPT_SUBMITTER_URL = `http://127.0.0.1:${fake.port}/submit`;
    const { notifySponsoredReceiptSubmitter } = await import("../sponsored-receipts.js");

    await notifySponsoredReceiptSubmitter({
      contentHash: "a".repeat(64),
      operator: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      authTier: "bearer",
      rootHash: "b".repeat(64),
      manifestHash: "c".repeat(64),
    });

    expect(fake.captured).toHaveLength(1);
    const req = fake.captured[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/submit");
    expect(req.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(req.body);
    expect(body).toEqual({
      contentHash: "a".repeat(64),
      operator: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      authTier: "bearer",
      rootHash: "b".repeat(64),
      manifestHash: "c".repeat(64),
      source: "blob-gateway",
    });
  });

  test("notify_includes_authorization_bearer_when_token_set", async () => {
    process.env.SPONSORED_RECEIPT_SUBMITTER_URL = `http://127.0.0.1:${fake.port}/submit`;
    process.env.SPONSORED_RECEIPT_SUBMITTER_TOKEN = "test-shared-secret-abc123";
    const { notifySponsoredReceiptSubmitter } = await import("../sponsored-receipts.js");

    await notifySponsoredReceiptSubmitter({
      contentHash: "a".repeat(64),
      operator: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      authTier: "bearer",
    });

    expect(fake.captured).toHaveLength(1);
    expect(fake.captured[0].headers["authorization"]).toBe(
      "Bearer test-shared-secret-abc123",
    );
  });

  test("notify_omits_authorization_header_when_token_empty", async () => {
    process.env.SPONSORED_RECEIPT_SUBMITTER_URL = `http://127.0.0.1:${fake.port}/submit`;
    const { notifySponsoredReceiptSubmitter } = await import("../sponsored-receipts.js");

    await notifySponsoredReceiptSubmitter({
      contentHash: "a".repeat(64),
      operator: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      authTier: "bearer",
    });

    expect(fake.captured).toHaveLength(1);
    expect(fake.captured[0].headers["authorization"]).toBeUndefined();
  });

  test("notify_swallows_non_2xx_responses_and_still_resolves", async () => {
    process.env.SPONSORED_RECEIPT_SUBMITTER_URL = `http://127.0.0.1:${fake.port}/submit`;
    fake.setStatus(500, '{"error":"intentional"}');
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { notifySponsoredReceiptSubmitter } = await import("../sponsored-receipts.js");

    // Must NOT throw.
    await expect(
      notifySponsoredReceiptSubmitter({
        contentHash: "a".repeat(64),
        operator: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
        authTier: "bearer",
      }),
    ).resolves.toBeUndefined();

    expect(fake.captured).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
    const warning = warnSpy.mock.calls[0][0] as string;
    expect(warning).toContain("non-2xx");
    expect(warning).toContain("500");
    warnSpy.mockRestore();
  });

  test("notify_swallows_connection_refused_and_logs_warning", async () => {
    // Point at an open port that nothing is listening on.
    await fake.stop();
    process.env.SPONSORED_RECEIPT_SUBMITTER_URL = `http://127.0.0.1:${fake.port}/submit`;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { notifySponsoredReceiptSubmitter } = await import("../sponsored-receipts.js");

    await expect(
      notifySponsoredReceiptSubmitter({
        contentHash: "a".repeat(64),
        operator: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
        authTier: "bearer",
      }),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalled();
    const warning = warnSpy.mock.calls[0][0] as string;
    expect(warning).toContain("fetch error");
    warnSpy.mockRestore();
    // Restart fake for afterEach.stop() to not double-close.
    fake = await startFakeSubmitter();
  });

  test("notify_respects_timeout_and_aborts_slow_submitter", async () => {
    process.env.SPONSORED_RECEIPT_SUBMITTER_URL = `http://127.0.0.1:${fake.port}/submit`;
    process.env.SPONSORED_RECEIPT_NOTIFY_TIMEOUT_MS = "200";
    fake.setDelay(2000); // submitter is intentionally slow
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { notifySponsoredReceiptSubmitter } = await import("../sponsored-receipts.js");

    const t0 = Date.now();
    await notifySponsoredReceiptSubmitter({
      contentHash: "a".repeat(64),
      operator: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      authTier: "bearer",
    });
    const elapsed = Date.now() - t0;

    // Must abort well before the submitter's 2000ms delay.
    expect(elapsed).toBeLessThan(1500);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("isSponsoredTier_matches_bearer_and_api_key_tiers_only", async () => {
    const { isSponsoredTier } = await import("../sponsored-receipts.js");
    expect(isSponsoredTier("bearer")).toBe(true);
    expect(isSponsoredTier("api-key")).toBe(true);
    expect(isSponsoredTier("api-key-legacy-ss58")).toBe(true);
    expect(isSponsoredTier("sig-only")).toBe(false);
    expect(isSponsoredTier("registered-validator")).toBe(false);
    expect(isSponsoredTier(undefined)).toBe(false);
    expect(isSponsoredTier("")).toBe(false);
  });
});
