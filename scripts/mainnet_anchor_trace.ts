import { config } from "dotenv";
config({ path: ".env.local" });

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  createTrace,
  addSpan,
  addEvent,
  closeSpan,
  finalizeTrace,
  createManifest,
  getChunkPath,
  type TraceRun,
} from "@fluxpointstudios/poi-sdk-process-trace";

import {
  createAnchorEntryFromBundle,
  buildAnchorMetadata,
  serializeForCbor,
  createBlockfrostProvider,
  verifyAnchor,
  verifyAnchorManifest,
} from "@fluxpointstudios/poi-sdk-anchors-cardano";

const LABEL = 2222;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runAndRecordCommand(
  run: TraceRun,
  spanId: string,
  cmd: string,
  args: string[],
  cwd: string
) {
  // record the command intent
  await addEvent(run, spanId, {
    kind: "command",
    command: cmd,
    args,
    cwd,
    visibility: "public",
  });

  const child = spawn(cmd, args, { cwd, shell: false });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf-8")));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf-8")));

  const exitCode: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  const trunc = (s: string, max = 8000) => {
    const originalSize = s.length;
    if (s.length <= max) return { content: s, truncated: false, originalSize };
    return { content: s.slice(0, max), truncated: true, originalSize };
  };

  // record outputs (default visibility for output is private)
  if (stdout.length) {
    const t = trunc(stdout);
    await addEvent(run, spanId, {
      kind: "output",
      stream: "stdout",
      content: t.content,
      truncated: t.truncated,
      originalSize: t.originalSize,
    });
  }
  if (stderr.length) {
    const t = trunc(stderr);
    await addEvent(run, spanId, {
      kind: "output",
      stream: "stderr",
      content: t.content,
      truncated: t.truncated,
      originalSize: t.originalSize,
    });
  }

  // record exit code as an observation (don't mutate earlier command event)
  await addEvent(run, spanId, {
    kind: "observation",
    observation: "command_exit",
    data: { exitCode, cmd, args },
    visibility: "public",
  });

  return exitCode;
}

async function main() {
  // Dynamic import for ESM-only lucid-cardano
  const { Lucid, Blockfrost } = await import("lucid-cardano");

  const projectId = process.env.BLOCKFROST_PROJECT_ID_MAINNET;
  const mnemonic = process.env.CARDANO_MNEMONIC;

  if (!projectId) throw new Error("Missing BLOCKFROST_PROJECT_ID_MAINNET");
  if (!mnemonic) throw new Error("Missing CARDANO_MNEMONIC");

  console.log("🚀 Starting mainnet anchor trace test...\n");

  // 1) Create trace + run a real local command
  const run = await createTrace({ agentId: "local-mainnet-smoke" });
  const span = addSpan(run, { name: "local-command-smoke", visibility: "public" });

  // cross-platform command: use Node itself
  const cmd = process.execPath;
  const args = ["-v"];
  const cwd = process.cwd();

  console.log(`📝 Recording command: ${cmd} ${args.join(" ")}`);
  const code = await runAndRecordCommand(run, span.id, cmd, args, cwd);
  await closeSpan(run, span.id, code === 0 ? "completed" : "failed");

  const bundle = await finalizeTrace(run);
  console.log("✅ Trace finalized");

  // 2) Create manifest + chunks (off-chain artifact)
  const { manifest, chunks } = await createManifest(bundle, { chunkSize: 200_000 });

  // anchors-cardano requires bundle.manifestHash present
  bundle.manifestHash = manifest.manifestHash;

  // write artifact locally so you can inspect it
  const outDir = path.join(process.cwd(), "out-mainnet-trace");
  await fs.mkdir(path.join(outDir, "chunks"), { recursive: true });
  await fs.writeFile(
    path.join(outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );
  for (const chunk of chunks) {
    await fs.writeFile(
      path.join(outDir, getChunkPath(chunk.info)),
      chunk.content,
      "utf-8"
    );
  }
  console.log("✅ Manifest and chunks written to:", outDir);

  // 3) Build anchor metadata (label 2222)
  const entry = createAnchorEntryFromBundle(bundle, {
    agentId: "local-mainnet-smoke",
    includeMerkleRoot: true,
    // storageUri optional for this test. add later when you host the artifact.
  });

  const txMeta = buildAnchorMetadata(entry);
  const cbor = serializeForCbor(txMeta) as Record<string | number, unknown>;
  const metadataValue = cbor[LABEL] ?? cbor[String(LABEL)];
  if (!metadataValue)
    throw new Error("Failed to extract label 2222 value for attachMetadata()");

  console.log("✅ Anchor metadata built");

  // 4) Submit tx via Lucid + Blockfrost
  console.log("\n🔗 Connecting to Cardano mainnet via Blockfrost...");
  const lucid = await Lucid.new(
    new Blockfrost("https://cardano-mainnet.blockfrost.io/api/v0", projectId),
    "Mainnet"
  );

  // selectWalletFromSeed expects the mnemonic string directly
  lucid.selectWalletFromSeed(mnemonic);

  const addr = await lucid.wallet.address();
  console.log("💳 Wallet address:", addr);

  // Check balance first
  const utxos = await lucid.wallet.getUtxos();
  const totalLovelace = utxos.reduce(
    (sum, u) => sum + (u.assets.lovelace || 0n),
    0n
  );
  console.log(`💰 Wallet balance: ${Number(totalLovelace) / 1_000_000} ADA`);

  if (totalLovelace < 3_000_000n) {
    throw new Error(
      `Insufficient funds. Need at least 3 ADA, have ${Number(totalLovelace) / 1_000_000} ADA`
    );
  }

  console.log("\n📤 Building and submitting transaction...");
  const tx = await lucid
    .newTx()
    .payToAddress(addr, { lovelace: 2_000_000n }) // self-output; change comes back too
    .attachMetadata(LABEL, metadataValue)
    .complete();

  const signed = await tx.sign().complete();
  const txHash = await signed.submit();

  console.log("\n" + "=".repeat(60));
  console.log("✅ Submitted mainnet tx:", txHash);
  console.log("=".repeat(60));
  console.log("📍 Address:", addr);
  console.log("🔐 rootHash:", bundle.rootHash);
  console.log("📋 manifestHash:", bundle.manifestHash);
  console.log("🌳 merkleRoot:", bundle.merkleRoot);
  console.log("📁 Artifact dir:", outDir);
  console.log("=".repeat(60));

  // 5) Verify on-chain (Blockfrost indexing can lag; retry a bit)
  console.log("\n⏳ Waiting for Blockfrost to index the transaction...");
  const verifier = createBlockfrostProvider({ projectId, network: "mainnet" });

  for (let i = 0; i < 12; i++) {
    const vRoot = await verifyAnchor(verifier, txHash, bundle.rootHash);
    const vMan = await verifyAnchorManifest(verifier, txHash, bundle.manifestHash!);

    if (vRoot.valid && vMan.valid) {
      console.log("\n" + "=".repeat(60));
      console.log("✅ ON-CHAIN VERIFICATION SUCCESSFUL!");
      console.log("=".repeat(60));
      console.log("verifyAnchor result:", JSON.stringify(vRoot, null, 2));
      console.log("verifyAnchorManifest result:", JSON.stringify(vMan, null, 2));
      return;
    }

    console.log(`   Attempt ${i + 1}/12 - waiting 5s...`);
    await sleep(5000);
  }

  console.log(
    "\n⚠️ Submitted tx, but Blockfrost verification didn't confirm within retry window."
  );
  console.log("Re-run verification later with:");
  console.log(`  txHash: ${txHash}`);
  console.log(`  rootHash: ${bundle.rootHash}`);
  console.log(`  manifestHash: ${bundle.manifestHash}`);
}

main().catch((e) => {
  console.error("❌ Error:", e);
  process.exit(1);
});
