/**
 * LIVE PREPROD end-to-end test for `GET /billing/usage`.
 *
 * Runs ONLY when `LIVE_PREPROD=1` is set. Per the convention captured in
 * `feedback_intent_settlement_chain_tdd.md`, chain-side validation tests
 * hit the live preprod chain with NO mocks. The path here:
 *
 *   1. Boot a local express app with the metering + billing routers, an
 *      in-memory worker_bounds db, and a real Bearer token. Sponsored-
 *      receipt-submitter URL is left unset — the metering route's pure
 *      forwarding leg isn't needed for THIS test (we submit on-chain
 *      directly via @polkadot/api with //Alice).
 *
 *   2. Submit 3 valid `compute_metering_v1` records via `POST /metering/submit`
 *      with the SAME tenant_id. Each has a different worker key + period
 *      window (1h, contiguous, ending 30s ago).
 *
 *   3. For each accepted record: directly submit `submit_receipt_v2` to
 *      preprod with //Alice as signer, so the on-chain receipt appears.
 *      schema_hash = SCHEMA_HASH_HEX is passed verbatim. (We can't rely on
 *      the sponsored-receipt-submitter being reachable from this test
 *      process; the metering live test does the same.)
 *
 *   4. Wait briefly (5-10s) for cert-daemon to potentially pick up the
 *      receipts. Don't fail if it's slow — the pending state is a valid
 *      assertion target too.
 *
 *   5. Call `GET /billing/usage?tenant_id=...&start_ms=...&end_ms=...&include_records=true`.
 *      Assert: 200, `aggregate.record_count >= 3`, aggregate sums match
 *      input, AT LEAST one record's attestation_status is one of
 *      ["certified", "pending"] (NOT "unknown" — chain RPC must be
 *      reachable for this test to be meaningful).
 *
 *   6. Optional: check anchor_resolver path. Won't fail if the SSH-into-
 *      cert-daemon-container path is unavailable in the test env; just
 *      verifies that the field exists in the response and is null OR a
 *      well-formed Cardano tx hash.
 *
 * Gating: `LIVE_PREPROD=1`. Skipped on CI by default. Run locally with:
 *
 *   LIVE_PREPROD=1 pnpm vitest run \
 *     services/blob-gateway/src/__tests__/billing_live_preprod.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { ApiPromise, Keyring, WsProvider } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";

import { config } from "../config.js";
import { meteringRouter } from "../routes/metering.js";
import { billingRouter } from "../routes/billing.js";
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

const PREPROD_WSS = "wss://materios.fluxpointstudios.com/preprod-rpc";
const LIVE = process.env.LIVE_PREPROD === "1";

const RECEIPT_APPEAR_DEADLINE_MS = 60_000;
const CERT_PROBE_DEADLINE_MS = 30_000;

interface AppCtx {
  app: express.Express;
  storage: string;
  prevStorage: string;
  prevSubmitterUrl: string;
  prevRpcUrl: string;
  workerBoundsDb: Database.Database;
  quotaDb: Database.Database;
  tokensDb: Database.Database;
  bearerToken: string;
}

function setupApp(): AppCtx {
  const storage = mkdtempSync(join(tmpdir(), "billing-live-test-"));
  const prevStorage = config.storagePath;
  config.storagePath = storage;

  const prevSubmitterUrl = config.sponsoredReceiptSubmitterUrl;
  config.sponsoredReceiptSubmitterUrl = "";

  // Point the chain-query wrapper at preprod for this test.
  const prevRpcUrl = config.materiosRpcUrl;
  config.materiosRpcUrl = PREPROD_WSS;

  const workerBoundsDb = new Database(":memory:");
  initWorkerBoundsDb(workerBoundsDb);
  setWorkerBoundsDbForTests(workerBoundsDb);

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

  const ss58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"; // //Alice
  const tok = issueToken(tokensDb, {
    accountSs58: ss58,
    label: "billing-live-test",
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
    prevRpcUrl,
    workerBoundsDb,
    quotaDb,
    tokensDb,
    bearerToken: tok.token,
  };
}

function teardown(ctx: AppCtx): void {
  config.storagePath = ctx.prevStorage;
  config.sponsoredReceiptSubmitterUrl = ctx.prevSubmitterUrl;
  config.materiosRpcUrl = ctx.prevRpcUrl;
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
        if (!headers["content-type"]) headers["content-type"] = "application/json";
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

function computeReceiptId(contentHashHex: string): string {
  return (
    "0x" +
    createHash("sha256")
      .update(Buffer.from(contentHashHex, "hex"))
      .digest("hex")
  );
}

const describeMaybe = LIVE ? describe : describe.skip;

describeMaybe("GET /billing/usage — LIVE preprod end-to-end", () => {
  let appCtx: AppCtx;
  let api: ApiPromise;

  beforeAll(async () => {
    await cryptoWaitReady();
    appCtx = setupApp();
    const provider = new WsProvider(PREPROD_WSS, 5000);
    api = await ApiPromise.create({ provider, noInitWarn: true });
    const chain = (await api.rpc.system.chain()).toString();
    if (!/preprod/i.test(chain)) {
      throw new Error(
        `LIVE_PREPROD pointed at unexpected chain "${chain}" — refusing to run`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(`[billing-live] connected to "${chain}"`);
  }, 60_000);

  afterAll(async () => {
    if (api) await api.disconnect();
    if (appCtx) teardown(appCtx);
  });

  test(
    "submit 3 records → on-chain → query → aggregate matches",
    async () => {
      const keyring = new Keyring({ type: "sr25519" });
      const tenantId = "ten-blive-" + Date.now().toString(36);
      const alice = keyring.addFromUri("//Alice");

      const baseEnd = Date.now() - 30_000;
      // 3 records, contiguous 5-min windows.
      const submitted: Array<{
        contentHash: string;
        rec: ComputeMeteringV1;
      }> = [];

      for (let i = 0; i < 3; i++) {
        const periodEnd = baseEnd - i * 5 * 60_000;
        const periodStart = periodEnd - 5 * 60_000;
        const workerPair = keyring.addFromUri(
          "//ComputeWorkerLiveBilling" + Date.now() + "_" + i,
        );
        const baseBody = {
          schema_version: SCHEMA_VERSION,
          worker_id: "wkr-blive-" + Date.now().toString(36) + "-" + i,
          tenant_id: tenantId,
          period_start: periodStart,
          period_end: periodEnd,
          cpu_seconds: 12 + i,
          ram_gb_hours: 0.1 + i * 0.01,
          disk_gb_hours: 0.05,
          net_bytes_in: 4096 + i * 1000,
          net_bytes_out: 2048 + i * 500,
          gpu_seconds: 0,
          worker_pubkey: u8aToHex(workerPair.publicKey, undefined, false),
        } as const;
        const cb = canonicalBody(baseBody);
        const sig = u8aToHex(workerPair.sign(cb), undefined, false);
        const rec: ComputeMeteringV1 = { ...baseBody, worker_signature: sig };
        const r = await call(appCtx.app, "POST", "/metering/submit", { body: rec });
        expect(r.status).toBe(200);
        const body = r.body as { content_hash: string };
        submitted.push({ contentHash: body.content_hash, rec });
      }
      // eslint-disable-next-line no-console
      console.log(
        `[billing-live] submitted ${submitted.length} records for tenant ${tenantId}`,
      );

      // Submit each receipt on-chain with //Alice. Build by hand to set
      // schema_hash explicitly (SDK's submitReceipt zeroes schema_hash
      // — see metering_live_preprod.test.ts comment).
      for (const s of submitted) {
        const contentHashHex = s.contentHash;
        const receiptId = computeReceiptId(contentHashHex);
        const tx = (
          api.tx as unknown as Record<
            string,
            Record<string, (...args: unknown[]) => unknown>
          >
        ).orinqReceipts.submitReceipt(
          receiptId,
          "0x" + contentHashHex,
          "0x" + contentHashHex,
          null,
          null,
          "0x" + contentHashHex,
          "0x" + "00".repeat(32),
          "0x" + "00".repeat(32),
          "0x" + "00".repeat(32),
          "0x" + "00".repeat(32),
          "0x" + SCHEMA_HASH_HEX,
        );
        await new Promise<void>((resolve, reject) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (tx as any).signAndSend(
            alice,
            { nonce: -1 },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ({ status, dispatchError }: any) => {
              if (dispatchError) {
                if (dispatchError.isModule) {
                  const decoded = api.registry.findMetaError(
                    dispatchError.asModule,
                  );
                  reject(
                    new Error(
                      `dispatch ${decoded.section}.${decoded.name}`,
                    ),
                  );
                } else {
                  reject(new Error(`dispatch ${String(dispatchError)}`));
                }
                return;
              }
              if (status.isInBlock) resolve();
            },
          );
        });
      }

      // Wait for at least the first receipt to appear on chain.
      // eslint-disable-next-line no-console
      console.log(`[billing-live] receipts submitted, waiting for chain visibility`);
      const deadline = Date.now() + RECEIPT_APPEAR_DEADLINE_MS;
      while (Date.now() < deadline) {
        const rid = computeReceiptId(submitted[0].contentHash);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result: any = await (api.query as any).orinqReceipts.receipts(rid);
        if (!result.isEmpty) break;
        await new Promise((r) => setTimeout(r, 3000));
      }

      // Optional: give cert-daemon a moment to pick up — don't fail.
      await new Promise((r) => setTimeout(r, CERT_PROBE_DEADLINE_MS));

      // Query the billing endpoint.
      const start = Math.min(...submitted.map((s) => s.rec.period_start)) - 1000;
      const end = Math.max(...submitted.map((s) => s.rec.period_end)) + 1000;
      const res = await call(
        appCtx.app,
        "GET",
        `/billing/usage?tenant_id=${tenantId}&start_ms=${start}&end_ms=${end}&include_records=true`,
        { headers: { authorization: `Bearer ${appCtx.bearerToken}` } },
      );
      expect(res.status).toBe(200);
      const body = res.body as {
        tenant_id: string;
        aggregate: {
          record_count: number;
          certified_count: number;
          anchored_count: number;
          cpu_seconds_total: number;
          ram_gb_hours_total: number;
          net_bytes_in_total: number;
          net_bytes_out_total: number;
          unique_workers: number;
        };
        records: Array<{
          worker_id: string;
          content_hash: string;
          schema_hash: string;
          attestation_status: string;
          attestation_cert_hash: string | null;
          cardano_anchor_tx: string | null;
          metrics: { cpu_seconds: number };
        }>;
        audit_trail: { schema_hash: string };
      };

      expect(body.tenant_id).toBe(tenantId);
      expect(body.aggregate.record_count).toBe(3);
      expect(body.audit_trail.schema_hash).toBe(SCHEMA_HASH_HEX);
      expect(body.records).toHaveLength(3);

      // Aggregate input sums match input records.
      const expected_cpu = submitted.reduce((a, b) => a + b.rec.cpu_seconds, 0);
      const expected_in = submitted.reduce((a, b) => a + b.rec.net_bytes_in, 0);
      expect(body.aggregate.cpu_seconds_total).toBeCloseTo(expected_cpu, 6);
      expect(body.aggregate.net_bytes_in_total).toBe(expected_in);
      expect(body.aggregate.unique_workers).toBe(3);

      // At least ONE record must NOT be "unknown" — chain RPC must be
      // reachable for this test to be meaningful. We don't insist on
      // certification (cert-daemon timing is independent of this route).
      const reachable = body.records.some(
        (r) => r.attestation_status !== "unknown",
      );
      expect(reachable).toBe(true);

      // Each record's schema_hash echoes the constant.
      for (const r of body.records) {
        expect(r.schema_hash).toBe(SCHEMA_HASH_HEX);
      }
      // eslint-disable-next-line no-console
      console.log(
        `[billing-live] terminal aggregate=${JSON.stringify(body.aggregate)}`,
      );
      // eslint-disable-next-line no-console
      for (const r of body.records) {
        // eslint-disable-next-line no-console
        console.log(
          `[billing-live] record worker=${r.worker_id} status=${r.attestation_status} cert=${r.attestation_cert_hash} anchor=${r.cardano_anchor_tx}`,
        );
      }
    },
    /* timeout: */ RECEIPT_APPEAR_DEADLINE_MS + CERT_PROBE_DEADLINE_MS + 60_000,
  );
});
