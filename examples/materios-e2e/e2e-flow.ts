#!/usr/bin/env npx tsx
/**
 * Materios End-to-End Flow
 *
 * One script that walks through the complete data anchoring lifecycle:
 *
 *   1. Create a process trace (simulate an AI agent session)
 *   2. Submit receipt to Materios chain
 *   3. Provision blob data for the cert daemon
 *   4. Wait for certification (2-of-N attestation)
 *   5. Wait for checkpoint anchor (L1 binding)
 *   6. Verify full chain of custody
 *
 * Usage:
 *   MATERIOS_RPC_URL=ws://... npx tsx e2e-flow.ts
 *   MATERIOS_RPC_URL=ws://... npx tsx e2e-flow.ts --submit-only
 *   MATERIOS_RPC_URL=ws://... npx tsx e2e-flow.ts --verify 0xabc123...
 *
 * Environment:
 *   MATERIOS_RPC_URL   WebSocket RPC URL (default: ws://127.0.0.1:9944)
 *   SIGNER_URI         Substrate signer (default: //Alice)
 *   BLOB_DIR           Path to write blob data (default: /data/materios-blobs)
 */

import {
  createTrace,
  addSpan,
  addEvent,
  closeSpan,
  finalizeTrace,
} from "@fluxpointstudios/orynq-sdk-process-trace";

import {
  MateriosProvider,
  submitReceipt,
  prepareBlobData,
  waitForCertification,
  waitForAnchor,
  verifyReceipt,
} from "@fluxpointstudios/orynq-sdk-anchors-materios";

import { createHash } from "crypto";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RPC_URL = process.env.MATERIOS_RPC_URL || "ws://127.0.0.1:9944";
const SIGNER_URI = process.env.SIGNER_URI || "//Alice";
const BLOB_DIR = process.env.BLOB_DIR || "/data/materios-blobs";

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
  console.log("─".repeat(70));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n  Materios End-to-End Flow\n");
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
  hr();

  // --verify mode: skip to verification
  if (verifyOnly && verifyReceiptId) {
    await runVerification(provider, verifyReceiptId);
    await provider.disconnect();
    return;
  }

  // =========================================================================
  // Step 1: Create a process trace
  // =========================================================================
  log("STEP 1", "Creating process trace...");

  const run = await createTrace({
    agentId: "materios-e2e-demo",
    metadata: {
      model: "gpt-oss-20b",
      sessionId: `e2e-${Date.now()}`,
      purpose: "End-to-end Materios anchoring demo",
    },
  });

  const span = addSpan(run, { name: "game-state-snapshot" });

  await addEvent(run, span.id, {
    kind: "observation",
    content: "Player completed level 7 with score 42,850",
    visibility: "public",
  });

  await addEvent(run, span.id, {
    kind: "decision",
    content: "Awarding achievement: 'Speed Runner' — level cleared in under 60s",
    visibility: "public",
  });

  await addEvent(run, span.id, {
    kind: "output",
    content: JSON.stringify({
      player: "demo-player-001",
      level: 7,
      score: 42850,
      achievements: ["speed-runner"],
      timestamp: new Date().toISOString(),
    }),
    visibility: "public",
  });

  await closeSpan(run, span.id);
  const bundle = await finalizeTrace(run);

  log("STEP 1", `Root hash:     ${bundle.rootHash}`);
  log("STEP 1", `Manifest hash: ${bundle.manifestHash}`);
  log("STEP 1", `Events:        ${bundle.publicView?.totalEvents ?? "?"}`);
  hr();

  // =========================================================================
  // Step 2: Submit receipt to chain
  // =========================================================================
  log("STEP 2", "Submitting receipt to Materios chain...");

  const contentHash =
    "0x" +
    createHash("sha256")
      .update(Buffer.from(bundle.rootHash.replace(/^0x/, ""), "hex"))
      .digest("hex");

  const result = await submitReceipt(provider, {
    contentHash,
    rootHash: "0x" + bundle.rootHash.replace(/^0x/, ""),
    manifestHash: "0x" + bundle.manifestHash.replace(/^0x/, ""),
  });

  log("STEP 2", `Receipt ID:  ${result.receiptId}`);
  log("STEP 2", `Block:       ${result.blockHash} (#${result.blockNumber})`);
  hr();

  // =========================================================================
  // Step 3: Provision blob data for cert daemon
  // =========================================================================
  log("STEP 3", "Provisioning blob data for cert daemon...");

  const content = Buffer.from(
    JSON.stringify({
      rootHash: bundle.rootHash,
      manifestHash: bundle.manifestHash,
      events: bundle.publicView,
      timestamp: new Date().toISOString(),
    }),
  );

  const { manifest, chunks } = prepareBlobData(result.receiptId, content);
  const receiptDir = join(BLOB_DIR, result.receiptId);

  if (existsSync(BLOB_DIR)) {
    mkdirSync(receiptDir, { recursive: true });
    mkdirSync(join(receiptDir, "chunks"), { recursive: true });

    writeFileSync(
      join(receiptDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    for (const chunk of chunks) {
      writeFileSync(join(receiptDir, chunk.path), chunk.data);
    }
    log("STEP 3", `Blob data written to ${receiptDir}`);
    log("STEP 3", `Manifest: ${manifest.chunk_count} chunks, ${manifest.total_size} bytes`);
  } else {
    log("STEP 3", `BLOB_DIR ${BLOB_DIR} not found — skipping blob write.`);
    log("STEP 3", "Copy blob data to the cert daemon's PVC manually:");
    log("STEP 3", `  kubectl cp manifest.json <daemon-pod>:${receiptDir}/manifest.json`);
    console.log(JSON.stringify(manifest, null, 2));
  }
  hr();

  if (submitOnly) {
    log("DONE", "Receipt submitted. Use --verify to check status later:");
    log("DONE", `  npx tsx e2e-flow.ts --verify ${result.receiptId}`);
    await provider.disconnect();
    return;
  }

  // =========================================================================
  // Step 4: Wait for certification
  // =========================================================================
  log("STEP 4", "Waiting for cert daemon attestation...");
  log("STEP 4", "(The cert daemon committee must attest availability)");

  const cert = await waitForCertification(provider, result.receiptId, {
    intervalMs: 6_000,
    timeoutMs: 600_000,
    onPoll: (n, ms) => {
      if (n % 5 === 0) log("STEP 4", `  poll #${n} (${(ms / 1000).toFixed(0)}s elapsed)`);
    },
  });

  log("STEP 4", `Certified!`);
  log("STEP 4", `  Cert hash: ${cert.certHash}`);
  log("STEP 4", `  Leaf hash: ${cert.leafHash}`);
  hr();

  // =========================================================================
  // Step 5: Wait for checkpoint anchor
  // =========================================================================
  log("STEP 5", "Waiting for checkpoint anchor...");
  log("STEP 5", "(Checkpoint system batches certs into Merkle tree → L1)");

  const anchor = await waitForAnchor(provider, cert, {
    intervalMs: 10_000,
    timeoutMs: 1_200_000, // 20 min (checkpoint interval can be up to 60 min)
    scanWindow: 500,
    onPoll: (n, ms) => {
      if (n % 3 === 0) log("STEP 5", `  scanning... (${(ms / 1000).toFixed(0)}s elapsed)`);
    },
  });

  log("STEP 5", `Anchored!`);
  log("STEP 5", `  Anchor ID:  ${anchor.anchorId}`);
  log("STEP 5", `  Root hash:  ${anchor.rootHash}`);
  log("STEP 5", `  Block:      ${anchor.blockHash}`);
  log("STEP 5", `  Match type: ${anchor.exactMatch ? "exact (single-leaf)" : "multi-leaf"}`);
  hr();

  // =========================================================================
  // Step 6: Verify chain of custody
  // =========================================================================
  await runVerification(provider, result.receiptId);

  await provider.disconnect();
}

async function runVerification(provider: MateriosProvider, receiptId: string) {
  log("VERIFY", "Running chain-of-custody verification...");

  const verify = await verifyReceipt(provider, receiptId, {
    scanWindow: 1000,
  });

  hr();
  console.log("\n  Verification Report\n");

  for (const step of verify.steps) {
    const icon = step.passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    console.log(`  Step ${step.step}: ${step.title} — ${icon}`);
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
    console.log("    Receipt → Certified → Checkpoint leaf → Anchor root → On-chain");
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
