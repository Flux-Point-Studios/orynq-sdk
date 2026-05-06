/**
 * LIVE PREPROD integration test for `POST /metering/submit` with
 * `schema_version = "compute_metering_v2"`.
 *
 * Mirrors the existing v1 live preprod test:
 *   1. Spin up local express app pointed at preprod RPC.
 *   2. Build a v2 record with //Alice as the fleet operator (and pre-register
 *      Alice's pubkey in the in-memory fleet_operators DB).
 *   3. POST to local /metering/submit. Expect 200 + content_hash.
 *   4. Submit submit_receipt extrinsic on-chain with //Alice + the schema_hash
 *      = sha256("compute_metering_v2"). This proves end-to-end that the
 *      gateway-derived schema_hash matches what an on-chain submitter would
 *      pin.
 *   5. Poll orinq_getReceipt until the receipt appears or deadline.
 *
 * Gating: LIVE_PREPROD=1. Skipped on CI by default. Run locally with:
 *
 *   LIVE_PREPROD=1 npx vitest run \
 *     services/blob-gateway/src/__tests__/metering_v2_live_preprod.test.ts
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

import { config } from "../config.js";
import { meteringRouter } from "../routes/metering.js";
import {
  initWorkerBoundsDb,
  setWorkerBoundsDbForTests,
} from "../worker_bounds.js";
import {
  initFleetOperatorsDb,
  setFleetOperatorsDbForTests,
  registerFleetOperator,
} from "../fleet_operators.js";
import {
  initObserversDb,
  setObserversDbForTests,
} from "../observers.js";
import {
  canonicalCborForFleetOpSig,
  canonicalCborForWorkerSig,
  SCHEMA_HASH_HEX,
  SCHEMA_VERSION,
  type ComputeMeteringV2,
} from "../schemas/compute_metering_v2.js";

const PREPROD_WSS = "wss://materios.fluxpointstudios.com/preprod-rpc";
const LIVE = process.env.LIVE_PREPROD === "1";

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
  workerBoundsDb: Database.Database;
  fleetDb: Database.Database;
  observersDb: Database.Database;
}

async function setupApp(fleetPubkeyHex: string): Promise<AppCtx> {
  const storage = mkdtempSync(join(tmpdir(), "metering-v2-live-test-"));
  const prevStorage = config.storagePath;
  config.storagePath = storage;

  const workerBoundsDb = new Database(":memory:");
  initWorkerBoundsDb(workerBoundsDb);
  setWorkerBoundsDbForTests(workerBoundsDb);

  const fleetDb = new Database(":memory:");
  initFleetOperatorsDb(fleetDb);
  setFleetOperatorsDbForTests(fleetDb);
  // Pre-register the fleet operator we'll be using as Alice.
  registerFleetOperator({
    pubkey: fleetPubkeyHex,
    label: "live-preprod-test-fleet",
  });

  const observersDb = new Database(":memory:");
  initObserversDb(observersDb);
  setObserversDbForTests(observersDb);

  const fake = await startFakeSubmitter();
  const prevSubmitterUrl = config.sponsoredReceiptSubmitterUrl;
  config.sponsoredReceiptSubmitterUrl = `http://127.0.0.1:${fake.port}/submit`;

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(meteringRouter);

  return {
    app,
    storage,
    prevStorage,
    prevSubmitterUrl,
    fake,
    workerBoundsDb,
    fleetDb,
    observersDb,
  };
}

async function teardown(ctx: AppCtx): Promise<void> {
  config.storagePath = ctx.prevStorage;
  config.sponsoredReceiptSubmitterUrl = ctx.prevSubmitterUrl;
  await ctx.fake.stop();
  rmSync(ctx.storage, { recursive: true, force: true });
  ctx.workerBoundsDb.close();
  ctx.fleetDb.close();
  ctx.observersDb.close();
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

describeMaybe("POST /metering/submit v2 — LIVE preprod end-to-end", () => {
  let appCtx: AppCtx;
  let api: ApiPromise;
  let alicePubkeyHex: string;

  beforeAll(async () => {
    await cryptoWaitReady();
    const keyring = new Keyring({ type: "sr25519" });
    const alice = keyring.addFromUri("//Alice");
    alicePubkeyHex = u8aToHex(alice.publicKey, undefined, false);

    appCtx = await setupApp(alicePubkeyHex);
    const provider = new WsProvider(PREPROD_WSS, 5000);
    api = await ApiPromise.create({ provider, noInitWarn: true });
    const chain = (await api.rpc.system.chain()).toString();
    if (!/preprod/i.test(chain)) {
      throw new Error(
        `LIVE_PREPROD pointed at unexpected chain "${chain}" — refusing to run`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(`[live-preprod-v2] connected to "${chain}" via ${PREPROD_WSS}`);
  }, 60_000);

  afterAll(async () => {
    if (api) await api.disconnect();
    if (appCtx) await teardown(appCtx);
  });

  test(
    "valid v2 record with //Alice fleet → 200 → on-chain receipt appears",
    async () => {
      const keyring = new Keyring({ type: "sr25519" });
      const alice = keyring.addFromUri("//Alice");
      const workerPair = keyring.addFromUri("//ComputeWorkerLiveV2" + Date.now());

      const period_end_ms = Date.now() - 30_000;
      const period_start_ms = period_end_ms - 5 * 60_000;
      const issued_ms = period_start_ms - 60_000;

      const hardware_spec_no_sig = {
        cpu_cores: 4,
        ram_gb: 16,
        gpu_type: "none",
        gpu_count: 0,
        fleet_operator_pubkey: alicePubkeyHex,
        issued_ms,
      };

      const fleetPreimage = canonicalCborForFleetOpSig(
        "wkr-live-v2-" + Date.now().toString(36),
        {
          ...hardware_spec_no_sig,
          fleet_operator_signature: "00".repeat(64),
        },
      );
      const fleetSig = u8aToHex(alice.sign(fleetPreimage), undefined, false);

      const hardware_spec = {
        ...hardware_spec_no_sig,
        fleet_operator_signature: fleetSig,
      };

      const recordNoSig = {
        schema_version: SCHEMA_VERSION,
        worker_id: "wkr-live-v2-" + Date.now().toString(36),
        tenant_id: "ten-live-v2-" + Date.now().toString(36),
        period_start_ms,
        period_end_ms,
        metrics: {
          cpu_seconds: 12,
          ram_gb_hours: 0.1,
          disk_gb_hours: 0.05,
          net_bytes_in: 4096,
          net_bytes_out: 2048,
          gpu_seconds: 0,
        },
        hardware_spec,
        worker_pubkey: u8aToHex(workerPair.publicKey, undefined, false),
      } as const;

      const workerPreimage = canonicalCborForWorkerSig(recordNoSig);
      const workerSig = u8aToHex(workerPair.sign(workerPreimage), undefined, false);
      const record: ComputeMeteringV2 = {
        ...recordNoSig,
        worker_signature: workerSig,
      };

      // 1. POST to local /metering/submit
      const res = await postJson(appCtx.app, "/metering/submit", record);
      expect(res.status).toBe(200);
      const body = res.body as {
        ok: true;
        status: string;
        content_hash: string;
        schema_hash: string;
        operator: string;
        observer_present: boolean;
      };
      expect(body.ok).toBe(true);
      expect(body.status).toBe("accepted");
      expect(body.content_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(body.schema_hash).toBe(SCHEMA_HASH_HEX);
      expect(body.observer_present).toBe(false);

      // 2. Submit on-chain via //Alice (no live submitter accessible from test).
      const contentHashHex = body.content_hash;
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
        "0x" + body.schema_hash,
      );

      const txHash = await new Promise<string>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tx as any)
          .signAndSend(alice, ({ status, dispatchError }: { status: { isInBlock: boolean; asInBlock: { toHex(): string } }; dispatchError?: unknown }) => {
            if (dispatchError) {
              reject(new Error(`submit_receipt dispatchError: ${String(dispatchError)}`));
              return;
            }
            if (status.isInBlock) {
              resolve(status.asInBlock.toHex());
            }
          })
          .catch(reject);
      });
      expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);

      // 3. Poll for receipt appearance.
      const receipt = await pollUntil(
        async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const r = await (api.rpc as any).orinq.getReceipt(receiptId);
          if (!r || r.isNone) return undefined;
          return r;
        },
        {
          deadlineMs: RECEIPT_APPEAR_DEADLINE_MS,
          what: "receipt to appear via orinq_getReceipt",
        },
      );
      expect(receipt).toBeDefined();
    },
    180_000,
  );
});
