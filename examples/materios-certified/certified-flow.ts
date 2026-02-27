#!/usr/bin/env npx tsx
/**
 * Materios Certified Receipt Flow
 *
 * Demonstrates the full self-service certification pipeline:
 *   1. Upload blobs to gateway
 *   2. Submit receipt on-chain
 *   3. Wait for daemon certification
 *   4. Wait for checkpoint anchor
 *   5. Verify receipt (including multi-leaf batches)
 *
 * Usage:
 *   MATERIOS_RPC_URL=ws://... npx tsx certified-flow.ts
 *   MATERIOS_RPC_URL=ws://... npx tsx certified-flow.ts --submit-only
 *   MATERIOS_RPC_URL=ws://... npx tsx certified-flow.ts --verify 0xabc123...
 *
 * Environment:
 *   MATERIOS_RPC_URL       WebSocket RPC URL (default: ws://127.0.0.1:9944)
 *   SIGNER_URI             Substrate signer (default: //Alice)
 *   BLOB_GATEWAY_URL       Blob gateway URL (default: http://54.151.99.31/blobs)
 *   BLOB_GATEWAY_API_KEY   Optional API key for blob gateway
 */

import {
  MateriosProvider,
  submitCertifiedReceipt,
  getCertificationStatus,
  verifyReceipt,
} from "../../packages/anchors-materios/dist/index.js";

import type {
  CertifiedReceiptOptions,
  BlobGatewayConfig,
} from "../../packages/anchors-materios/dist/index.js";

import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RPC_URL = process.env.MATERIOS_RPC_URL || "ws://127.0.0.1:9944";
const SIGNER_URI = process.env.SIGNER_URI || "//Alice";
const GATEWAY_URL = process.env.BLOB_GATEWAY_URL || "http://54.151.99.31/blobs";
const GATEWAY_API_KEY = process.env.BLOB_GATEWAY_API_KEY || "";

const args = process.argv.slice(2);
const submitOnly = args.includes("--submit-only");
const verifyOnly = args.includes("--verify");
const verifyReceiptId = verifyOnly ? args[args.indexOf("--verify") + 1] : null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(step: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${step} ${msg}`);
}

function hr() {
  console.log("-".repeat(70));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n  Materios Certified Receipt Flow\n");
  hr();

  // Connect to Materios
  log("INIT", `Connecting to ${RPC_URL}...`);
  const provider = new MateriosProvider({
    rpcUrl: RPC_URL,
    signerUri: SIGNER_URI,
  });
  await provider.connect();

  const api = provider.getApi();
  const chain = await api.rpc.system.chain();
  const chainId = api.genesisHash.toHex();
  const best = (await api.rpc.chain.getHeader()).number.toNumber();
  log("INIT", `Chain: ${chain} | Genesis: ${chainId.slice(0, 18)}...`);
  log("INIT", `Best block: #${best}`);
  log("INIT", `Gateway: ${GATEWAY_URL}`);
  hr();

  // --verify mode: skip to verification
  if (verifyOnly && verifyReceiptId) {
    await runVerification(provider, verifyReceiptId);
    await provider.disconnect();
    return;
  }

  // =========================================================================
  // Step 1: Prepare content
  // =========================================================================
  log("STEP 1", "Preparing content...");

  const content = Buffer.from(
    JSON.stringify({
      type: "certified-receipt-demo",
      timestamp: new Date().toISOString(),
      data: "Hello from the self-service certification pipeline!",
      session: `certified-${Date.now()}`,
    }),
  );

  const contentHash =
    "0x" + createHash("sha256").update(content).digest("hex");
  const rootHash =
    "0x" +
    createHash("sha256")
      .update(Buffer.from(contentHash.replace(/^0x/, ""), "hex"))
      .digest("hex");
  const manifestHash =
    "0x" +
    createHash("sha256")
      .update(Buffer.from("manifest-" + contentHash))
      .digest("hex");

  log("STEP 1", `Content: ${content.length} bytes`);
  log("STEP 1", `Content hash: ${contentHash.slice(0, 18)}...`);
  hr();

  // =========================================================================
  // Step 2: Submit certified receipt (blobs + on-chain + certification)
  // =========================================================================
  log("STEP 2", "Submitting certified receipt...");
  log("STEP 2", "(Uploads blobs -> submits on-chain -> waits for cert daemon)");

  const blobGateway: BlobGatewayConfig = {
    baseUrl: GATEWAY_URL,
    apiKey: GATEWAY_API_KEY || undefined,
  };

  const opts: CertifiedReceiptOptions = {
    blobGateway,
    waitForAnchor: !submitOnly,
    certificationPollOpts: {
      intervalMs: 6000,
      timeoutMs: 600000, // 10 min
      onPoll: (attempt, elapsed) => {
        if (attempt % 5 === 0) {
          log("STEP 2", `  Waiting for certification... poll #${attempt} (${Math.round(elapsed / 1000)}s)`);
        }
      },
    },
    anchorPollOpts: {
      intervalMs: 10000,
      timeoutMs: 1200000, // 20 min (checkpoint interval can be long)
      scanWindow: 500,
      onPoll: (attempt, elapsed) => {
        if (attempt % 3 === 0) {
          log("STEP 2", `  Waiting for anchor... poll #${attempt} (${Math.round(elapsed / 1000)}s)`);
        }
      },
    },
  };

  const result = await submitCertifiedReceipt(
    provider,
    { contentHash, rootHash, manifestHash },
    content,
    opts,
  );

  hr();
  console.log("\n  --- Result ---\n");
  console.log(`  Receipt ID:  ${result.receiptId}`);
  console.log(`  Block:       ${result.blockHash} (#${result.blockNumber})`);
  if (result.certHash) {
    console.log(`  Cert Hash:   ${result.certHash}`);
  }
  if (result.leafHash) {
    console.log(`  Leaf Hash:   ${result.leafHash}`);
  }
  if (result.anchor) {
    console.log(`  Anchor ID:   ${result.anchor.anchorId}`);
    console.log(`  Root Hash:   ${result.anchor.rootHash}`);
    console.log(`  Match Type:  ${result.anchor.exactMatch ? "exact (single-leaf)" : "multi-leaf"}`);
  }
  console.log("");
  hr();

  if (submitOnly) {
    log("DONE", "Receipt submitted and certified. Use --verify to check anchor later:");
    log("DONE", `  npx tsx certified-flow.ts --verify ${result.receiptId}`);
    await provider.disconnect();
    return;
  }

  // =========================================================================
  // Step 3: Check certification status
  // =========================================================================
  log("STEP 3", "Checking certification status...");

  const status = await getCertificationStatus(provider, result.receiptId, blobGateway);
  log("STEP 3", `Status: ${status.status}`);
  if (status.details) log("STEP 3", `Details: ${status.details}`);
  hr();

  // =========================================================================
  // Step 4: Full verification
  // =========================================================================
  await runVerification(provider, result.receiptId, blobGateway);

  await provider.disconnect();
}

async function runVerification(
  provider: MateriosProvider,
  receiptId: string,
  blobGateway?: BlobGatewayConfig,
) {
  log("VERIFY", "Running chain-of-custody verification...");

  const verify = await verifyReceipt(provider, receiptId, {
    scanWindow: 1000,
    blobGateway,
  });

  hr();
  console.log("\n  Verification Report\n");

  for (const step of verify.steps) {
    const icon = step.passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    console.log(`  Step ${step.step}: ${step.title} -- ${icon}`);
    for (const [k, v] of Object.entries(step.details)) {
      const val = String(v);
      console.log(`    ${k}: ${val.length > 60 ? val.slice(0, 60) + "..." : val}`);
    }
  }

  console.log("");
  hr();

  const statusColor =
    verify.status === "FULLY_VERIFIED"
      ? "\x1b[32m"
      : verify.status === "PARTIALLY_VERIFIED"
        ? "\x1b[33m"
        : "\x1b[31m";
  console.log(`\n  Result: ${statusColor}${verify.status}\x1b[0m\n`);

  if (verify.status === "FULLY_VERIFIED") {
    console.log("  The receipt has a complete, verifiable chain of custody:");
    console.log("    Receipt -> Blobs uploaded -> Certified -> Checkpoint leaf -> Anchor root -> On-chain");
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("\nError:", err.message || err);
  process.exit(1);
});
