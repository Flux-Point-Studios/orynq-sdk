/**
 * Tests for GET /trace/:contentHash — first-party trace-detail explorer
 * page (task #271).
 *
 * Acceptance:
 *   - malformed contentHash → 400
 *   - unknown contentHash (no manifest) → 404
 *   - known contentHash → 200 with rendered HTML containing the trace
 *     summary, receipt-cert info, anchor info, and event timeline.
 *
 * Strategy:
 *   - Persist a manifest on disk via storage.ts so the route's `getManifest`
 *     loads it without HTTP loopback.
 *   - Stub the chain RPC + events-indexer fetches via a controllable
 *     test double so we exercise both the "no on-chain receipt" and
 *     "fully attested + anchored" rendering paths without touching prod.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

import express from "express";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { config } from "../../config.js";
import { saveManifest, saveBatch } from "../../storage.js";
import { traceRouter, __test__setFetchImpl, __test__resetFetchImpl } from "../trace.js";

interface RpcResponse {
  result?: unknown;
  error?: unknown;
}

type FakeFetch = (url: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

function makeApp(): express.Express {
  const app = express();
  app.use(traceRouter);
  return app;
}

async function get(
  app: express.Express,
  path: string,
): Promise<{ status: number; text: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to bind test server"));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      fetch(url)
        .then(async (res) => {
          const text = await res.text();
          server.close();
          resolve({
            status: res.status,
            text,
            contentType: res.headers.get("content-type") ?? "",
          });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

/** Build an installed JSON-RPC mock that answers `orinq_*` calls. */
function buildRpcFetch(answers: Record<string, RpcResponse>): FakeFetch {
  return async (url, init) => {
    if (init && init.method === "POST" && typeof init.body === "string") {
      const body = JSON.parse(init.body) as { method: string };
      const ans = answers[body.method] ?? { result: null };
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "2.0", id: 1, ...ans }),
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, ...ans }),
      };
    }
    if (url.includes("/preprod-events/receipt-attestors")) {
      const idMatch = /receiptId=(0x[0-9a-fA-F]+)/.exec(url);
      const id = idMatch ? idMatch[1] : "";
      const ev = answers[`events:receipt-attestors:${id}`];
      if (ev) {
        return {
          ok: true,
          status: 200,
          json: async () => ev.result,
          text: async () => JSON.stringify(ev.result),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ certified: false, reason: "not found" }),
        text: async () => JSON.stringify({ certified: false }),
      };
    }
    if (url.includes("/batches/")) {
      const match = /\/batches\/([0-9a-fA-Fx]+)/.exec(url);
      const id = match ? match[1] : "";
      const ev = answers[`batches:${id}`];
      if (ev) {
        return {
          ok: true,
          status: 200,
          json: async () => ev.result,
          text: async () => JSON.stringify(ev.result),
        };
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: "Batch not found" }),
        text: async () => `{"error":"Batch not found"}`,
      };
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => "",
    };
  };
}

describe("GET /trace/:contentHash", () => {
  let tmpDir: string;
  let originalStoragePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "trace-route-test-"));
    originalStoragePath = config.storagePath;
    (config as { storagePath: string }).storagePath = tmpDir;
  });

  afterEach(() => {
    (config as { storagePath: string }).storagePath = originalStoragePath;
    __test__resetFetchImpl();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("returns 400 for malformed contentHash (not 64 hex)", async () => {
    __test__setFetchImpl(buildRpcFetch({}));
    const app = makeApp();
    const resp = await get(app, "/trace/notahex");
    expect(resp.status).toBe(400);
    expect(resp.text.toLowerCase()).toContain("invalid content hash");
  });

  test("returns 400 for contentHash with uppercase letters (must be lowercase hex)", async () => {
    __test__setFetchImpl(buildRpcFetch({}));
    const app = makeApp();
    // 64 chars but contains uppercase
    const badHash = "A".repeat(64);
    const resp = await get(app, `/trace/${badHash}`);
    expect(resp.status).toBe(400);
  });

  test("returns 404 when no manifest exists for a well-formed contentHash", async () => {
    __test__setFetchImpl(buildRpcFetch({}));
    const app = makeApp();
    const unknownHash = "f".repeat(64);
    const resp = await get(app, `/trace/${unknownHash}`);
    expect(resp.status).toBe(404);
    // 404 still returns minimal HTML (not JSON) — same content-type
    // surface as the 200 path for consistency.
    expect(resp.text.toLowerCase()).toContain("not found");
  });

  test("returns 200 HTML rendering all data points for a real trace manifest with cert + anchor", async () => {
    // Trace manifest mirrors @orynq/process-trace TraceManifest shape.
    const contentHash = "c7506e6092c5d609e6cea05f98ddc81122bef8fe8448a9675189446dadc383a2";
    const receiptId = "0xc7dc93ba23aa1c0f95e5e5d8586bf3998e7de5b8e01bf60adf442b04198a0ca5";
    const certHash = "0x431b3b3ca216366bd7e53095d66d89e3e301695c320bc5286c7b9c997dadc227";

    await saveManifest(contentHash, {
      formatVersion: "v1",
      runId: "run-test-271",
      agentId: "agent-test-271",
      rootHash: contentHash,
      merkleRoot: contentHash,
      manifestHash: "5fe798feef0a421cebd8263e0f88be49fc65f6e9f8654a594237f35368f0fa77",
      totalEvents: 17,
      totalSpans: 3,
      startedAt: "2026-05-21T14:00:00.000Z",
      endedAt: "2026-05-21T14:05:00.000Z",
      durationMs: 300000,
      chunks: [
        { index: 0, sha256: "aa".repeat(32), size: 512 },
        { index: 1, sha256: "bb".repeat(32), size: 1024 },
      ],
      publicView: {
        publicSpans: [],
      },
    });

    // Cardano anchor — Materios POI label 2222. The route looks up the
    // batch by rootHash (which IS the contentHash here for the
    // single-receipt case).
    const cardanoTx = "1f14de860adc83cfdc344a5a19a6fe324e3dc555d25b2cdde30932afdd7e0a28";
    await saveBatch(contentHash, {
      anchorId: "0x" + contentHash,
      rootHash: contentHash,
      leafCount: 1,
      leafHashes: [receiptId],
      blockRangeStart: 91131,
      blockRangeEnd: 91131,
      cardanoTxHash: cardanoTx,
      cardanoNetwork: "preprod",
      cardanoBlockHeight: 12345678,
      cardanoMetadataLabel: 2222,
      submitter: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      timestamp: "2026-05-21T14:10:00Z",
      source: "daemon",
    });

    __test__setFetchImpl(
      buildRpcFetch({
        // contentHash → receipt IDs
        orinq_getReceiptsByContent: { result: [receiptId] },
        // receipt detail (byte arrays mirror live shape)
        orinq_getReceipt: {
          result: {
            schema_hash: Array(32).fill(0),
            content_hash: Array.from(Buffer.from(contentHash, "hex")),
            base_root_sha256: Array.from(Buffer.from(contentHash, "hex")),
            zk_root_poseidon: null,
            poseidon_params_hash: null,
            base_manifest_hash: Array.from(
              Buffer.from("5fe798feef0a421cebd8263e0f88be49fc65f6e9f8654a594237f35368f0fa77", "hex"),
            ),
            safety_manifest_hash: Array(32).fill(0),
            monitor_config_hash: Array(32).fill(0),
            attestation_evidence_hash: Array(32).fill(0),
            storage_locator_hash: Array(32).fill(0),
            availability_cert_hash: Array.from(Buffer.from(certHash.slice(2), "hex")),
            created_at_millis: 1779379200000,
            submitter: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
          },
        },
        orinq_getReceiptStatus: { result: "Certified" },
        // Events indexer: 3-signer cert
        [`events:receipt-attestors:${receiptId}`]: {
          result: {
            certified: true,
            cert_hash: certHash,
            certified_at_block: 91131,
            certified_at_hash: "0xd708d1cda06c56fb353fae74acb0d270607298ba41ab58a6988dd796866b5b60",
            receipt_id: receiptId,
            signer_count: 3,
            signers: [
              { attester: "5CDKbyJZ8vgXYY8Cajhh9vCqpa5YDhicLWPMihQ4bb3HH8NS", reward_base: "1000000" },
              { attester: "5CtBFsSx8HzX272AGNb764sv4sBLQUwb6GfHQjk8YdbMPW2d", reward_base: "1000000" },
              { attester: "5Ge7JQmazsKLiEVmAZAVFQDHFVArpBnvc9zmxb1ujpzLJDQr", reward_base: "1000000" },
            ],
            total_reward_base: "3000000",
          },
        },
      }),
    );

    const app = makeApp();
    const resp = await get(app, `/trace/${contentHash}`);
    expect(resp.status).toBe(200);
    expect(resp.contentType.toLowerCase()).toContain("text/html");

    const html = resp.text;

    // Header: full contentHash visible.
    expect(html).toContain(contentHash);

    // Trace summary: source/event/span counts + duration.
    expect(html).toContain("agent-test-271");
    expect(html).toContain("run-test-271");
    expect(html).toMatch(/17[^0-9]/); // totalEvents
    expect(html).toMatch(/2[^0-9]/);  // chunk count
    expect(html).toContain("v1");      // formatVersion

    // Receipt card: receipt_id + signer SS58s + signer count.
    expect(html).toContain(receiptId);
    expect(html).toContain("5CDKbyJZ8vgXYY8Cajhh9vCqpa5YDhicLWPMihQ4bb3HH8NS");
    expect(html).toContain("5CtBFsSx8HzX272AGNb764sv4sBLQUwb6GfHQjk8YdbMPW2d");
    expect(html).toContain("5Ge7JQmazsKLiEVmAZAVFQDHFVArpBnvc9zmxb1ujpzLJDQr");
    expect(html).toContain("FINALIZED");
    // M-of-N threshold rendered (e.g. "3 / N").
    expect(html).toMatch(/3\s*\/\s*\d+/);

    // Anchor card: Cardano tx hash + cexplorer link + label + network.
    expect(html).toContain(cardanoTx);
    expect(html).toContain("preprod.cexplorer.io/tx/" + cardanoTx);
    expect(html).toContain("2222");
    expect(html).toContain("preprod");

    // Event timeline: at least one entry referencing the cert.
    expect(html).toContain("certified_at_block");
    expect(html).toContain("91131");

    // Viewport meta + no external script/stylesheet refs.
    expect(html).toContain('name="viewport"');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:\/\//);

    // CORS open for read.
    // (Tested via content — header check is below.)
  });

  test("returns 200 with PENDING state when manifest exists but no on-chain receipt", async () => {
    const contentHash = "1".padEnd(64, "1");
    await saveManifest(contentHash, {
      formatVersion: "v1",
      runId: "run-pending",
      agentId: "agent-pending",
      rootHash: contentHash,
      merkleRoot: contentHash,
      totalEvents: 1,
      totalSpans: 1,
      startedAt: "2026-05-21T14:00:00.000Z",
      endedAt: "2026-05-21T14:00:01.000Z",
      durationMs: 1000,
      chunks: [{ index: 0, sha256: "aa".repeat(32), size: 32 }],
      publicView: { publicSpans: [] },
    });

    __test__setFetchImpl(
      buildRpcFetch({
        orinq_getReceiptsByContent: { result: [] },
      }),
    );

    const app = makeApp();
    const resp = await get(app, `/trace/${contentHash}`);
    expect(resp.status).toBe(200);
    expect(resp.text).toContain("PENDING");
    expect(resp.text).toContain(contentHash);
    expect(resp.text).toContain("agent-pending");
  });

  test("sets CORS header allowing public GET", async () => {
    __test__setFetchImpl(buildRpcFetch({}));
    const app = makeApp();
    const unknownHash = "f".repeat(64);
    // Even on a 404 the CORS header should be present so a client knows
    // not to retry from a different origin.
    const path = `/trace/${unknownHash}`;
    const respText = await new Promise<{ status: number; cors: string }>((resolve, reject) => {
      const server = app.listen(0, () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          server.close();
          reject(new Error("bind fail"));
          return;
        }
        fetch(`http://127.0.0.1:${addr.port}${path}`)
          .then((res) => {
            server.close();
            resolve({
              status: res.status,
              cors: res.headers.get("access-control-allow-origin") ?? "",
            });
          })
          .catch((err) => {
            server.close();
            reject(err);
          });
      });
    });
    expect(respText.cors).toBe("*");
  });
});
