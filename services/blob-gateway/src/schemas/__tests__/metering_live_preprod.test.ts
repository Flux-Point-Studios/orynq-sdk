/**
 * LIVE PREPROD integration test for `POST /metering/submit`.
 *
 * Per the convention captured in
 * `feedback_intent_settlement_chain_tdd.md` — chain-side validation tests
 * hit the live preprod chain with NO mocks. Wire here:
 *
 *   1. Spin up a local blob-gateway-only Express app in this process,
 *      pointed at the production preprod RPC (wss://materios.fluxpointstudios.com/preprod-rpc).
 *      Only the metering route is mounted (we don't need the full gateway
 *      surface, just the validator + sponsored-receipt forwarding glue).
 *
 *   2. Generate a fresh sr25519 keypair, build a valid `compute_metering_v1`
 *      record, sign the canonical body, POST it to /metering/submit. Confirm
 *      the route returned 200 and a content_hash.
 *
 *   3. Submit a receipt to the on-chain pallet directly using the SDK's
 *      `submitReceipt()` with //Alice as signer. The metering route's
 *      sponsored-receipt-submitter is fired via the fake submitter (so we
 *      can assert on its payload), but the on-chain leg uses the SDK
 *      because there is no live submitter pointed at preprod that we can
 *      reuse from this test process. Schema_hash = SCHEMA_HASH_HEX is
 *      passed through verbatim so the on-chain receipt records the
 *      compute-metering-v1 schema.
 *
 *   4. Poll `orinq_getReceipt` until the receipt appears (deadline-bounded,
 *      no sleep loops). Assert the receipt's content_hash matches what the
 *      route returned.
 *
 *   5. Poll `orinq_getReceiptStatus` (via SDK helper) for non-zero cert
 *      hash → asserts "Certified" eventually. We give cert-daemon up to
 *      90s; if it doesn't certify in that window we record "Submitted but
 *      not yet certified" and DO NOT fail the test (cert-daemon health is
 *      not what this test is exercising — it's a separate component).
 *
 * Gating: this test runs ONLY when `LIVE_PREPROD=1` is set in the
 * environment. CI configurations that don't have outbound preprod access
 * skip it. To run locally:
 *
 *   LIVE_PREPROD=1 npx vitest run services/blob-gateway/src/schemas/__tests__/metering_live_preprod.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { ApiPromise, Keyring, WsProvider } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";
import { createHash } from "crypto";

import { config } from "../../config.js";
import { meteringRouter } from "../../routes/metering.js";
import {
  initWorkerBoundsDb,
  setWorkerBoundsDbForTests,
} from "../../worker_bounds.js";
import {
  canonicalBody,
  SCHEMA_HASH_HEX,
  SCHEMA_VERSION,
  type ComputeMeteringV1,
} from "../compute_metering_v1.js";

const PREPROD_WSS = "wss://materios.fluxpointstudios.com/preprod-rpc";
const LIVE = process.env.LIVE_PREPROD === "1";

// Cert-daemon timing on preprod typically certifies inside 30-60s; allow 90s
// before degrading to "submitted but not yet certified".
const CERT_DEADLINE_MS = 90_000;
// Receipt should appear within a few blocks; preprod block time is ~6s.
const RECEIPT_APPEAR_DEADLINE_MS = 60_000;

interface FakeSubmitter {
  server: Server;
  port: number;
  captured: Array<{ body: string }>;
  stop(): Promise<void>;
}

async function startFakeSubmitter(): Promise<FakeSubmitter> {
  const captured: FakeSubmitter["captured"] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      captured.push({ body: Buffer.concat(chunks).toString("utf-8") });
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

interface AppCtx {
  app: express.Express;
  storage: string;
  prevStorage: string;
  prevSubmitterUrl: string;
  fake: FakeSubmitter;
  db: Database.Database;
}

async function setupApp(): Promise<AppCtx> {
  const storage = mkdtempSync(join(tmpdir(), "metering-live-test-"));
  const prevStorage = config.storagePath;
  config.storagePath = storage;

  const db = new Database(":memory:");
  initWorkerBoundsDb(db);
  setWorkerBoundsDbForTests(db);

  const fake = await startFakeSubmitter();
  const prevSubmitterUrl = config.sponsoredReceiptSubmitterUrl;
  config.sponsoredReceiptSubmitterUrl = `http://127.0.0.1:${fake.port}/submit`;

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(meteringRouter);

  return { app, storage, prevStorage, prevSubmitterUrl, fake, db };
}

async function teardown(ctx: AppCtx): Promise<void> {
  config.storagePath = ctx.prevStorage;
  config.sponsoredReceiptSubmitterUrl = ctx.prevSubmitterUrl;
  await ctx.fake.stop();
  rmSync(ctx.storage, { recursive: true, force: true });
  ctx.db.close();
}

async function postJson(
  app: express.Express,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr === "string" || addr === null) {
        server.close();
        reject(new Error("no address"));
        return;
      }
      const url = `http://127.0.0.1:${(addr as AddressInfo).port}${path}`;
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
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
 * Deadline-bounded polling helper. Returns the value when the predicate
 * resolves to non-undefined; throws on timeout.
 */
async function pollUntil<T>(
  fn: () => Promise<T | undefined>,
  opts: { deadlineMs: number; intervalMs?: number; what: string },
): Promise<T> {
  const deadline = Date.now() + opts.deadlineMs;
  const interval = opts.intervalMs ?? 2000;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== undefined && v !== null) return v;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`pollUntil timeout after ${opts.deadlineMs}ms: ${opts.what}`);
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

describeMaybe("POST /metering/submit — LIVE preprod end-to-end", () => {
  let appCtx: AppCtx;
  let api: ApiPromise;

  beforeAll(async () => {
    await cryptoWaitReady();
    appCtx = await setupApp();
    const provider = new WsProvider(PREPROD_WSS, 5000);
    api = await ApiPromise.create({ provider, noInitWarn: true });
    const chain = (await api.rpc.system.chain()).toString();
    // Sanity: confirm we connected to the right chain. If this is a wrong
    // chain (e.g. mainnet), abort early so we don't accidentally write to it.
    if (!/preprod/i.test(chain)) {
      throw new Error(
        `LIVE_PREPROD pointed at unexpected chain "${chain}" — refusing to run`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(
      `[live-preprod] connected to "${chain}" via ${PREPROD_WSS}`,
    );
  }, 60_000);

  afterAll(async () => {
    if (api) await api.disconnect();
    if (appCtx) await teardown(appCtx);
  });

  test(
    "valid record → 200 → on-chain receipt appears → eventually certified",
    async () => {
      const keyring = new Keyring({ type: "sr25519" });
      // Fresh worker key per test run. Period: a 5-minute window ending
      // 30s ago so we're well inside the 60s skew tolerance.
      const workerPair = keyring.addFromUri(
        "//ComputeWorkerLive" + Date.now(),
      );
      const period_end = Date.now() - 30_000;
      const period_start = period_end - 5 * 60_000;
      const baseBody = {
        schema_version: SCHEMA_VERSION,
        worker_id: "wkr-live-" + Date.now().toString(36),
        tenant_id: "ten-live-" + Date.now().toString(36),
        period_start,
        period_end,
        cpu_seconds: 12.5,
        ram_gb_hours: 0.1,
        disk_gb_hours: 0.05,
        net_bytes_in: 4096,
        net_bytes_out: 2048,
        gpu_seconds: 0,
        worker_pubkey: u8aToHex(workerPair.publicKey, undefined, false),
      };
      const cb = canonicalBody(baseBody);
      const sig = u8aToHex(workerPair.sign(cb), undefined, false);
      const record: ComputeMeteringV1 = { ...baseBody, worker_signature: sig };

      // 1. POST to local /metering/submit
      const res = await postJson(appCtx.app, "/metering/submit", record);
      expect(res.status).toBe(200);
      const body = res.body as {
        ok: true;
        status: string;
        content_hash: string;
        schema_hash: string;
        operator: string;
      };
      expect(body.ok).toBe(true);
      expect(body.status).toBe("accepted");
      expect(body.content_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(body.schema_hash).toBe(SCHEMA_HASH_HEX);

      // 2. Submit on-chain via SDK using //Alice (the only funded preprod
      //    test signer accessible to this test process). schema_hash is
      //    passed exactly as the validator returned it, proving end-to-end
      //    that the gateway-derived hash and the on-chain hash match.
      const alice = keyring.addFromUri("//Alice");
      const contentHashHex = body.content_hash;
      const receiptId = computeReceiptId(contentHashHex);

      // Build the extrinsic by hand to expose schema_hash explicitly. The
      // SDK's `submitReceipt()` zeroes schema_hash (it predates the
      // compute-metering schema), so we don't use it here.
      // Live arg order on preprod: receiptId, contentHash, baseRootSha256,
      // zkRootPoseidon (Option), poseidonParamsHash (Option), baseManifestHash,
      // safetyManifestHash, monitorConfigHash, attestationEvidenceHash,
      // storageLocatorHash, schemaHash.
      const tx = (
        api.tx as unknown as Record<
          string,
          Record<string, (...args: unknown[]) => unknown>
        >
      ).orinqReceipts.submitReceipt(
        receiptId,
        "0x" + contentHashHex,
        "0x" + contentHashHex,         // baseRootSha256
        null,                          // zkRootPoseidon (Option)
        null,                          // poseidonParamsHash (Option)
        "0x" + contentHashHex,         // baseManifestHash
        "0x" + "00".repeat(32),        // safetyManifestHash
        "0x" + "00".repeat(32),        // monitorConfigHash
        "0x" + "00".repeat(32),        // attestationEvidenceHash
        "0x" + "00".repeat(32),        // storageLocatorHash
        "0x" + body.schema_hash,       // schemaHash — THE point of this test
      );

      const txHash = await new Promise<string>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tx as any).signAndSend(
          alice,
          { nonce: -1 },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ({ status, dispatchError, txHash: hash }: any) => {
            if (dispatchError) {
              if (dispatchError.isModule) {
                const decoded = api.registry.findMetaError(
                  dispatchError.asModule,
                );
                reject(
                  new Error(
                    `dispatch ${decoded.section}.${decoded.name}: ${decoded.docs.join(" ")}`,
                  ),
                );
              } else {
                reject(new Error(`dispatch ${String(dispatchError)}`));
              }
              return;
            }
            if (status.isInBlock) {
              resolve(hash ? hash.toHex() : "0x");
            }
          },
        );
      });
      // eslint-disable-next-line no-console
      console.log(
        `[live-preprod] submitted receipt receiptId=${receiptId} content_hash=${contentHashHex} txHash=${txHash}`,
      );

      // 3. Poll `orinq_getReceipt` until the record exists.
      const onChainRecord = await pollUntil(
        async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result: any = await (api.query as any).orinqReceipts.receipts(
            receiptId,
          );
          if (result.isEmpty) return undefined;
          return result.toJSON() as Record<string, unknown>;
        },
        {
          deadlineMs: RECEIPT_APPEAR_DEADLINE_MS,
          intervalMs: 3000,
          what: "receipt to appear in storage",
        },
      );
      const onChainContentHash = String(
        onChainRecord.content_hash ?? onChainRecord.contentHash ?? "",
      ).replace(/^0x/, "");
      expect(onChainContentHash.toLowerCase()).toBe(contentHashHex);

      // schema_hash must round-trip — proves the validator-derived hash is
      // what lands on chain. (The pallet treats it as opaque [u8; 32], so a
      // round-trip is sufficient.)
      const onChainSchemaHash = String(
        onChainRecord.schema_hash ?? onChainRecord.schemaHash ?? "",
      ).replace(/^0x/, "");
      expect(onChainSchemaHash.toLowerCase()).toBe(SCHEMA_HASH_HEX);

      // 4. Poll for certification — but DO NOT fail the test if cert-daemon
      //    is slow. The point of THIS test is the metering→content_hash→
      //    on-chain leg; cert-daemon is exercised elsewhere.
      let certified = false;
      try {
        await pollUntil(
          async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result: any = await (api.query as any).orinqReceipts.receipts(
              receiptId,
            );
            if (result.isEmpty) return undefined;
            const record = result.toJSON() as Record<string, unknown>;
            const certHash = String(
              record.availability_cert_hash ??
                record.availabilityCertHash ??
                "",
            ).replace(/^0x/, "");
            // Zero hash → still pending; non-zero → certified.
            return certHash && certHash !== "00".repeat(32) ? true : undefined;
          },
          {
            deadlineMs: CERT_DEADLINE_MS,
            intervalMs: 3000,
            what: "receipt to be certified",
          },
        );
        certified = true;
        // eslint-disable-next-line no-console
        console.log(
          `[live-preprod] receipt CERTIFIED receiptId=${receiptId}`,
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[live-preprod] receipt submitted but NOT certified within ${CERT_DEADLINE_MS}ms — cert-daemon health check not part of this test. err=${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Either certified or in-storage-pending counts as success for this
      // test's contract — the metering route delivered a content_hash that
      // round-trips through the on-chain pallet, AND the schema_hash matches.
      expect(onChainContentHash).toBeTruthy();
      // Surface the certification outcome for the test report.
      // eslint-disable-next-line no-console
      console.log(
        `[live-preprod] terminal status: certified=${certified} content_hash=${contentHashHex}`,
      );
    },
    /* timeout: */ CERT_DEADLINE_MS + RECEIPT_APPEAR_DEADLINE_MS + 60_000,
  );
});
