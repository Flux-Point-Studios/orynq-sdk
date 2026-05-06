#!/usr/bin/env npx tsx
/**
 * Materios Load Test — Congestion Pricing Proof
 *
 * Submits receipts under various traffic patterns to demonstrate
 * the MOTRA adaptive fee mechanism (EMA-smoothed congestion pricing).
 *
 * Modes:
 *   baseline  — N receipts, 6s apart, single signer (no congestion)
 *   burst     — N receipts, 1s apart, single signer (mild congestion)
 *   parallel  — 4 signers submitting concurrently (heavy congestion)
 *   monitor   — Poll motra_getParams, no submissions
 *
 * Usage:
 *   MATERIOS_RPC_URL=ws://127.0.0.1:9944 npx tsx loadtest.ts --mode parallel --count 20
 *   MATERIOS_RPC_URL=ws://127.0.0.1:9944 npx tsx loadtest.ts --mode monitor --duration 120
 *
 * Options:
 *   --mode <mode>              baseline | burst | parallel | monitor
 *   --count <n>                Number of receipts to submit (default: 10)
 *   --interval <ms>            Interval between submissions in ms (default: mode-dependent)
 *   --duration <seconds>       Monitor duration in seconds (default: 60)
 *   --log-receipts <path>      Write receipt IDs to JSON file
 *   --with-blobs <dir>         Write blob data for cert daemon (enables certification)
 *   --gateway <url>            Upload blobs to gateway instead of writing to disk
 *   --gateway-key <key>        API key for blob gateway authentication
 *   --motra-warmup             Wait for MOTRA balance before submitting
 */

// When running from workspace, resolve directly to built dist.
// In a published package, consumers would import from "@fluxpointstudios/orynq-sdk-anchors-materios".
import {
  MateriosProvider,
  submitReceipt,
  prepareBlobData,
  uploadBlobs,
  isCertified,
  waitForMotra,
  queryMotraBalance,
  computeBaseRoot,
} from "../../packages/anchors-materios/dist/index.js";

import type { BlobGatewayConfig } from "../../packages/anchors-materios/dist/index.js";

import { createHash, randomBytes } from "crypto";
import { writeFileSync, mkdirSync } from "fs";

// ---------------------------------------------------------------------------
// CLI Arguments
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(name: string, defaultVal: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const MODE = getArg("mode", "baseline") as "baseline" | "burst" | "parallel" | "monitor";
const COUNT = parseInt(getArg("count", "10"), 10);
const DURATION = parseInt(getArg("duration", "60"), 10);
const LOG_RECEIPTS = getArg("log-receipts", "");
const WITH_BLOBS = getArg("with-blobs", "");  // directory path for blob output
const GATEWAY_URL = getArg("gateway", "");     // blob gateway URL (replaces --with-blobs)
const GATEWAY_KEY = getArg("gateway-key", ""); // blob gateway API key
const MOTRA_WARMUP = args.includes("--motra-warmup");

// Build gateway config if --gateway is set
const BLOB_GATEWAY: BlobGatewayConfig | null = GATEWAY_URL
  ? { baseUrl: GATEWAY_URL, apiKey: GATEWAY_KEY || undefined }
  : null;
const RPC_URL = process.env.MATERIOS_RPC_URL || "ws://127.0.0.1:9944";

const DEFAULT_INTERVALS: Record<string, number> = {
  baseline: 6000,
  burst: 1000,
  parallel: 2000,
  monitor: 6000,
};
const INTERVAL = parseInt(getArg("interval", String(DEFAULT_INTERVALS[MODE] || 6000)), 10);

// Parallel mode signers (dev accounts)
const SIGNERS = ["//Alice", "//Bob", "//Charlie", "//Dave"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CongestionSample {
  timestamp: string;
  block: number;
  congestionRate: string;
  minFee: string;
  targetFullness: string;
}

interface ReceiptLog {
  receiptId: string;
  block: number;
  signer: string;
  congestionRate: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(tag: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${tag.padEnd(8)} ${msg}`);
}

/**
 * Build a self-consistent receipt envelope: generates the content bytes that
 * will be uploaded to the gateway AND derives the on-chain hashes from those
 * exact bytes. `rootHash` is the canonical chunk-Merkle root the cert daemon
 * will recompute when it pulls the chunks back — this is what makes the
 * receipt pass strict ROOT_VERIFIED.
 */
function generatePayload(): {
  content: Buffer;
  contentHash: string;
  rootHash: string;
  manifestHash: string;
} {
  // 1-4 KB of pseudo-random content per receipt, deterministic w.r.t. time.
  const size = 1024 + Math.floor(Math.random() * 3072);
  const content = randomBytes(size);
  const contentHash =
    "0x" + createHash("sha256").update(content).digest("hex");
  const rootHash = computeBaseRoot(content);
  // Manifest hash placeholder — cert daemon doesn't verify this; only the
  // sponsored-receipt flow + uploadBlobs path compute the real storage
  // locator hash.
  const manifestHash =
    "0x" +
    createHash("sha256")
      .update(Buffer.from("manifest-" + contentHash))
      .digest("hex");
  return { content, contentHash, rootHash, manifestHash };
}

async function queryCongestion(provider: MateriosProvider): Promise<CongestionSample> {
  const api = provider.getApi();
  const best = (await api.rpc.chain.getHeader()).number.toNumber();

  let congestionRate = "0";
  let minFee = "0";
  let targetFullness = "0";

  try {
    // Use raw provider.send since motra_getParams is a custom RPC not decorated by @polkadot/api
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = await (api as any)._rpcCore.provider.send("motra_getParams", []);
    congestionRate = String(json.congestion_rate ?? "0");
    minFee = String(json.min_fee ?? "0");
    targetFullness = String(json.target_fullness ?? json.target_fullness_ppm ?? "0");
  } catch {
    // motra_getParams may not be available — fall back to zero
  }

  return {
    timestamp: new Date().toISOString(),
    block: best,
    congestionRate,
    minFee,
    targetFullness,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeBlobData(
  receiptId: string,
  contentHash: string,
  content: Buffer,
): Promise<void> {
  if (!WITH_BLOBS && !BLOB_GATEWAY) return;

  const { manifest, chunks } = prepareBlobData(receiptId, content);

  // If gateway is configured, upload via HTTP instead of writing to disk.
  // The gateway keys blobs by contentHash, NOT receiptId.
  if (BLOB_GATEWAY) {
    const result = await uploadBlobs(
      contentHash.replace(/^0x/, ""),
      manifest,
      chunks,
      BLOB_GATEWAY,
    );
    if (!result.success) {
      log("BLOB", `Gateway upload failed for ${receiptId.slice(0, 18)}...: ${result.error}`);
    }
    return;
  }

  // Fallback: write to local filesystem (--with-blobs <dir>)
  // Strip 0x prefix for directory name (cert daemon strips 0x in local lookup)
  const cleanId = receiptId.replace(/^0x/, "");
  const receiptDir = `${WITH_BLOBS}/${cleanId}`;
  mkdirSync(`${receiptDir}/chunks`, { recursive: true });

  // Add file:// URLs to manifest chunks for cert daemon compatibility
  for (const chunk of manifest.chunks) {
    chunk.url = `file://${receiptDir}/${chunk.path}`;
  }

  writeFileSync(`${receiptDir}/manifest.json`, JSON.stringify(manifest, null, 2));
  for (const chunk of chunks) {
    writeFileSync(`${receiptDir}/${chunk.path}`, chunk.data);
  }
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function runSequential(mode: "baseline" | "burst") {
  log("MODE", `${mode} — ${COUNT} receipts, ${INTERVAL}ms interval`);

  const provider = new MateriosProvider({ rpcUrl: RPC_URL, signerUri: "//Alice" });
  await provider.connect();

  if (MOTRA_WARMUP) {
    log("WARMUP", "Waiting for MOTRA balance...");
    const balance = await waitForMotra(provider);
    log("WARMUP", `MOTRA balance: ${balance}`);
  }

  const receipts: ReceiptLog[] = [];
  const congestion: CongestionSample[] = [];
  let failures = 0;

  try {
    for (let i = 0; i < COUNT; i++) {
      const payload = generatePayload();

      try {
        const result = await submitReceipt(provider, {
          contentHash: payload.contentHash,
          rootHash: payload.rootHash,
          manifestHash: payload.manifestHash,
        });
        const sample = await queryCongestion(provider);
        congestion.push(sample);

        const entry: ReceiptLog = {
          receiptId: result.receiptId,
          block: result.blockNumber,
          signer: "//Alice",
          congestionRate: sample.congestionRate,
          timestamp: sample.timestamp,
        };
        receipts.push(entry);

        await writeBlobData(
          result.receiptId,
          payload.contentHash,
          payload.content,
        );

        log("SUBMIT", `#${i + 1} receipt=${result.receiptId.slice(0, 18)}... block=#${result.blockNumber} congestion=${sample.congestionRate}`);
      } catch (err: unknown) {
        failures++;
        const msg = err instanceof Error ? err.message : String(err);
        log("FAIL", `#${i + 1} ${msg}`);
      }

      if (i < COUNT - 1) await sleep(INTERVAL);
    }
  } finally {
    printSummary(receipts, congestion, failures);
    saveReceipts(receipts);
    await provider.disconnect();
  }
}

async function runParallel() {
  log("MODE", `parallel — ${COUNT} receipts, ${SIGNERS.length} signers, ${INTERVAL}ms interval`);

  // Create one provider per signer to avoid nonce collisions
  const providers: MateriosProvider[] = [];
  for (const uri of SIGNERS) {
    const p = new MateriosProvider({ rpcUrl: RPC_URL, signerUri: uri });
    await p.connect();
    providers.push(p);
  }

  if (MOTRA_WARMUP) {
    log("WARMUP", "Waiting for MOTRA balance on all signers...");
    for (let i = 0; i < providers.length; i++) {
      const balance = await waitForMotra(providers[i]);
      log("WARMUP", `${SIGNERS[i]} MOTRA balance: ${balance}`);
    }
  }

  const receipts: ReceiptLog[] = [];
  const congestion: CongestionSample[] = [];
  let failures = 0;

  try {
    const batches = Math.ceil(COUNT / SIGNERS.length);

    for (let batch = 0; batch < batches; batch++) {
      const promises = providers.map(async (provider, idx) => {
        const globalIdx = batch * SIGNERS.length + idx;
        if (globalIdx >= COUNT) return;

        const payload = generatePayload();
        try {
          const result = await submitReceipt(provider, {
            contentHash: payload.contentHash,
            rootHash: payload.rootHash,
            manifestHash: payload.manifestHash,
          });
          await writeBlobData(
            result.receiptId,
            payload.contentHash,
            payload.content,
          );
          return {
            receiptId: result.receiptId,
            block: result.blockNumber,
            signer: SIGNERS[idx],
            globalIdx,
          };
        } catch (err: unknown) {
          failures++;
          const msg = err instanceof Error ? err.message : String(err);
          log("FAIL", `#${globalIdx + 1} (${SIGNERS[idx]}) ${msg}`);
          return null;
        }
      });

      const results = await Promise.all(promises);

      // Query congestion once per batch
      const sample = await queryCongestion(providers[0]);
      congestion.push(sample);

      for (const r of results) {
        if (!r) continue;
        const entry: ReceiptLog = {
          receiptId: r.receiptId,
          block: r.block,
          signer: r.signer,
          congestionRate: sample.congestionRate,
          timestamp: sample.timestamp,
        };
        receipts.push(entry);
        log("SUBMIT", `#${r.globalIdx + 1} (${r.signer}) receipt=${r.receiptId.slice(0, 18)}... block=#${r.block} congestion=${sample.congestionRate}`);
      }

      if (batch < batches - 1) await sleep(INTERVAL);
    }
  } finally {
    printSummary(receipts, congestion, failures);
    saveReceipts(receipts);
    for (const p of providers) await p.disconnect();
  }
}

async function runMonitor() {
  log("MODE", `monitor — ${DURATION}s, polling every ${INTERVAL}ms`);

  const provider = new MateriosProvider({ rpcUrl: RPC_URL, signerUri: "//Alice" });
  await provider.connect();

  const samples: CongestionSample[] = [];
  const start = Date.now();

  try {
    while ((Date.now() - start) < DURATION * 1000) {
      const sample = await queryCongestion(provider);
      samples.push(sample);
      log("MONITOR", `block=#${sample.block} congestion=${sample.congestionRate} min_fee=${sample.minFee} target_fullness=${sample.targetFullness}`);
      await sleep(INTERVAL);
    }
  } finally {
    console.log("\n--- Congestion Trace ---");
    console.log("Block\tCongestion Rate");
    for (const s of samples) {
      console.log(`${s.block}\t${s.congestionRate}`);
    }
    await provider.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printSummary(receipts: ReceiptLog[], congestion: CongestionSample[], failures: number) {
  console.log("\n" + "=".repeat(70));
  console.log("  Load Test Summary");
  console.log("=".repeat(70));
  console.log(`  Mode:       ${MODE}`);
  console.log(`  Submitted:  ${receipts.length} receipts`);
  console.log(`  Failures:   ${failures}`);

  if (congestion.length > 0) {
    const rates = congestion.map((s) => parseInt(s.congestionRate) || 0);
    const maxRate = Math.max(...rates);
    const minRate = Math.min(...rates);
    const avgRate = rates.reduce((a, b) => a + b, 0) / rates.length;

    console.log(`\n  Congestion Rate:`);
    console.log(`    Min:  ${minRate}`);
    console.log(`    Max:  ${maxRate}`);
    console.log(`    Avg:  ${avgRate.toFixed(0)}`);

    if (maxRate > 0) {
      console.log(`\n  Congestion pricing ACTIVATED (rate > 0)`);
    } else {
      console.log(`\n  No congestion detected (rate stayed at 0)`);
    }

    console.log(`\n  Congestion Trace:`);
    console.log(`  Block\t\tRate`);
    for (const s of congestion) {
      console.log(`  ${s.block}\t\t${s.congestionRate}`);
    }
  }

  console.log("=".repeat(70));

  if (BLOB_GATEWAY && receipts.length > 0) {
    console.log(`\n  Blobs uploaded to gateway: ${GATEWAY_URL}`);
    console.log(`  Run cert status check with:`);
    console.log(`    npx tsx verify-receipts.ts ${LOG_RECEIPTS || '<receipt-ids.json>'}`);
  } else if (WITH_BLOBS && receipts.length > 0) {
    console.log(`\n  Blob data written to: ${WITH_BLOBS}`);
    console.log(`  Run cert status check with:`);
    console.log(`    npx tsx verify-receipts.ts ${LOG_RECEIPTS || '<receipt-ids.json>'}`);
  }
}

function saveReceipts(receipts: ReceiptLog[]) {
  if (!LOG_RECEIPTS) return;
  const ids = receipts.map((r) => r.receiptId);
  writeFileSync(LOG_RECEIPTS, JSON.stringify(ids, null, 2));
  log("SAVE", `${ids.length} receipt IDs written to ${LOG_RECEIPTS}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n  Materios Load Test — ${MODE.toUpperCase()}\n`);

  switch (MODE) {
    case "baseline":
    case "burst":
      await runSequential(MODE);
      break;
    case "parallel":
      await runParallel();
      break;
    case "monitor":
      await runMonitor();
      break;
    default:
      console.error(`Unknown mode: ${MODE}. Use: baseline, burst, parallel, monitor`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
