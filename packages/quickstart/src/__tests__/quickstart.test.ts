/**
 * @summary Quickstart contract tests.
 *
 * These tests pin the solo-dev sub-5-min DX contract:
 *
 *   1. `loadOrCreateIdentity()` is pure-local (no network), generates a fresh
 *      sr25519 keypair from a fresh mnemonic when the config file does not
 *      exist, and reloads byte-for-byte the same address on subsequent calls.
 *   2. `firstTraceBundle()` produces a deterministic-shape `TraceBundle` in
 *      under 1 second for a tiny payload — confirms the local-trace step
 *      itself never blocks the 5-minute budget.
 *   3. `buildExplorerUrls()` returns the trifecta of human-friendly URLs
 *      (gateway blob status, Polkadot.js apps explorer, raw RPC genesis)
 *      that solo devs need to *see* their trace after submission.
 *
 * Network-bound tests (faucet drip + on-chain submit) live in
 * `quickstart.live.test.ts` and are gated by `ORYNQ_RUN_LIVE_TESTS=1`. They
 * exercise the real preprod gateway when present, but never block CI for
 * solo devs running `pnpm test` on their laptop.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { loadOrCreateIdentity, firstTraceBundle, buildExplorerUrls } from "../index.js";
import type { OrynqIdentity, TraceBundleLite } from "../index.js";

beforeAll(async () => {
  await cryptoWaitReady();
});

describe("loadOrCreateIdentity", () => {
  it("generates a fresh identity when no config file exists, then reloads the same address", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "orynq-qs-test-"));
    const configPath = join(tmpDir, "config.json");
    try {
      // First call: generate
      const id1: OrynqIdentity = await loadOrCreateIdentity({ configPath });
      expect(id1.address).toMatch(/^[15][a-zA-Z0-9]{45,47}$/);
      expect(id1.mnemonic.split(" ").length).toBeGreaterThanOrEqual(12);
      expect(id1.generatedAt).toBeTruthy();
      expect(existsSync(configPath)).toBe(true);

      // Second call: reload
      const id2: OrynqIdentity = await loadOrCreateIdentity({ configPath });
      expect(id2.address).toBe(id1.address);
      expect(id2.mnemonic).toBe(id1.mnemonic);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("writes the config file with 0600 permissions on POSIX systems", async () => {
    if (process.platform === "win32") return; // chmod is no-op on Windows
    const tmpDir = mkdtempSync(join(tmpdir(), "orynq-qs-test-"));
    const configPath = join(tmpDir, "config.json");
    try {
      await loadOrCreateIdentity({ configPath });
      const { statSync } = await import("fs");
      const mode = statSync(configPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects a config file with malformed contents instead of silently regenerating", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "orynq-qs-test-"));
    const configPath = join(tmpDir, "config.json");
    try {
      const { writeFileSync } = await import("fs");
      writeFileSync(configPath, "not-json-at-all");
      await expect(loadOrCreateIdentity({ configPath })).rejects.toThrow(/identity/i);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("firstTraceBundle", () => {
  it("produces a finalised bundle with stable shape in under 1s", async () => {
    const start = Date.now();
    const bundle: TraceBundleLite = await firstTraceBundle({
      agentId: "qs-test-agent",
      summary: "hello from quickstart tests",
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(bundle.rootHash).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bundle.content.length).toBeGreaterThan(0);
  });

  it("produces deterministic hashes for fixed inputs given a fixed timestamp", async () => {
    const fixed = new Date("2026-05-14T12:00:00.000Z");
    const a = await firstTraceBundle({
      agentId: "fixed-agent",
      summary: "fixed",
      now: () => fixed,
      runId: "00000000-0000-4000-8000-000000000000",
      spanId: "11111111-1111-4111-8111-111111111111",
      eventId: "22222222-2222-4222-8222-222222222222",
    });
    const b = await firstTraceBundle({
      agentId: "fixed-agent",
      summary: "fixed",
      now: () => fixed,
      runId: "00000000-0000-4000-8000-000000000000",
      spanId: "11111111-1111-4111-8111-111111111111",
      eventId: "22222222-2222-4222-8222-222222222222",
    });
    expect(a.rootHash).toBe(b.rootHash);
    expect(a.merkleRoot).toBe(b.merkleRoot);
    expect(a.manifestHash).toBe(b.manifestHash);
  });
});

describe("buildExplorerUrls", () => {
  it("returns the four explorer surfaces solo devs need to *see* their trace", () => {
    const urls = buildExplorerUrls({
      contentHash: "0x" + "ab".repeat(32),
      blockHash: "0x" + "cd".repeat(32),
      gatewayBaseUrl: "https://materios.fluxpointstudios.com/blobs",
      rpcUrl: "wss://materios.fluxpointstudios.com/rpc",
    });
    // The SDK's upload path is `${baseUrl}/blobs/<hash>/manifest`. The
    // status URL preserves that shape so it routes through the same
    // nginx mount.
    expect(urls.blobStatus).toBe(
      "https://materios.fluxpointstudios.com/blobs/blobs/" + "ab".repeat(32) + "/status",
    );
    expect(urls.explorer).toContain("polkadot.js.org/apps");
    expect(urls.explorer).toContain(encodeURIComponent("wss://materios.fluxpointstudios.com/rpc"));
    expect(urls.explorer).toContain("cd".repeat(32));
    // /chain-info and /health live on the root express app, not the
    // /blobs router — we strip the /blobs prefix for those.
    expect(urls.chainInfo).toBe("https://materios.fluxpointstudios.com/chain-info");
    expect(urls.gatewayHealth).toBe("https://materios.fluxpointstudios.com/health");
  });

  it("when baseUrl omits /blobs, the same origin is used for both blob + root URLs", () => {
    const urls = buildExplorerUrls({
      contentHash: "ab".repeat(32),
      blockHash: "cd".repeat(32),
      gatewayBaseUrl: "https://my-gateway.example.com",
      rpcUrl: "wss://my-rpc.example.com",
    });
    expect(urls.blobStatus).toBe(
      "https://my-gateway.example.com/blobs/" + "ab".repeat(32) + "/status",
    );
    expect(urls.chainInfo).toBe("https://my-gateway.example.com/chain-info");
    expect(urls.gatewayHealth).toBe("https://my-gateway.example.com/health");
  });

  it("strips 0x from the gateway URL path but preserves 0x on the polkadot.js apps URL", () => {
    const urls = buildExplorerUrls({
      contentHash: "0x" + "ab".repeat(32),
      blockHash: "0x" + "cd".repeat(32),
      gatewayBaseUrl: "https://gw.example.com",
      rpcUrl: "wss://rpc.example.com",
    });
    // Gateway paths are bare hex (no 0x), to avoid double-prefix
    // collisions in the route matcher.
    expect(urls.blobStatus).not.toContain("/0x");
    // Polkadot.js apps explorer wants the 0x prefix. The query path is
    //   #/explorer/query/0x<blockhash>
    expect(urls.explorer).toContain("/explorer/query/0x" + "cd".repeat(32));
  });
});
