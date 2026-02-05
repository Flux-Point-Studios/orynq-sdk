/**
 * Self-Hosted Anchoring Example
 *
 * This example demonstrates how to:
 * 1. Create a process trace for an AI agent session
 * 2. Build anchor metadata from the trace
 * 3. Submit the anchor to Cardano using your own wallet
 * 4. Verify the anchor on-chain
 *
 * Usage:
 *   BLOCKFROST_PROJECT_ID=preprodXXX WALLET_SEED="your seed phrase" npx ts-node self-anchor.ts
 */

import {
  createTrace,
  addSpan,
  addEvent,
  closeSpan,
  finalizeTrace,
} from "@fluxpointstudios/poi-sdk-process-trace";

import {
  createAnchorEntryFromBundle,
  buildAnchorMetadata,
  serializeForCbor,
  createBlockfrostProvider,
  verifyAnchor,
  POI_METADATA_LABEL,
} from "@fluxpointstudios/poi-sdk-anchors-cardano";

import { Lucid, Blockfrost } from "lucid-cardano";

// Configuration from environment
const BLOCKFROST_PROJECT_ID = process.env.BLOCKFROST_PROJECT_ID;
const WALLET_SEED = process.env.WALLET_SEED;
const NETWORK = process.env.NETWORK || "preprod";

if (!BLOCKFROST_PROJECT_ID || !WALLET_SEED) {
  console.error("Missing required environment variables:");
  console.error("  BLOCKFROST_PROJECT_ID - Your Blockfrost API key");
  console.error("  WALLET_SEED - Your wallet seed phrase");
  process.exit(1);
}

async function main() {
  console.log("=== Self-Hosted Anchoring Example ===\n");

  // =========================================================================
  // Step 1: Create a process trace
  // =========================================================================
  console.log("Step 1: Creating process trace...");

  const run = await createTrace({
    agentId: "example-agent",
    metadata: {
      model: "claude-3-opus",
      sessionId: `session-${Date.now()}`,
    },
  });

  // Add a span for this work unit
  const span = addSpan(run, { name: "code-analysis" });

  // Record some events (simulating an AI agent working)
  await addEvent(run, span.id, {
    kind: "observation",
    content: "User requested analysis of authentication module",
    visibility: "public",
  });

  await addEvent(run, span.id, {
    kind: "decision",
    content: "Will perform security audit focusing on injection vulnerabilities",
    visibility: "public",
  });

  await addEvent(run, span.id, {
    kind: "command",
    command: "analyze_code",
    args: { target: "src/auth/*.ts" },
    visibility: "private", // Keep internal commands private
  });

  await addEvent(run, span.id, {
    kind: "output",
    content: "Analysis complete. Found 0 critical issues, 2 warnings.",
    visibility: "public",
  });

  await closeSpan(run, span.id);

  // Finalize the trace to compute cryptographic hashes
  const bundle = await finalizeTrace(run);

  console.log("  Root Hash:", bundle.rootHash);
  console.log("  Manifest Hash:", bundle.manifestHash);
  console.log("  Merkle Root:", bundle.merkleRoot);
  console.log("  Total Events:", bundle.publicView?.totalEvents);
  console.log("");

  // =========================================================================
  // Step 2: Build anchor metadata
  // =========================================================================
  console.log("Step 2: Building anchor metadata...");

  const entry = createAnchorEntryFromBundle(bundle, {
    agentId: "example-agent",
    // storageUri: "ipfs://QmYourCID", // Add if you're storing the full trace
  });

  const anchorResult = buildAnchorMetadata(entry);
  const cborMetadata = serializeForCbor(anchorResult);

  console.log("  Metadata label:", POI_METADATA_LABEL);
  console.log("  Entry type:", entry.type);
  console.log("");

  // =========================================================================
  // Step 3: Submit to Cardano
  // =========================================================================
  console.log("Step 3: Submitting to Cardano...");

  const blockfrostUrl =
    NETWORK === "mainnet"
      ? "https://cardano-mainnet.blockfrost.io/api/v0"
      : "https://cardano-preprod.blockfrost.io/api/v0";

  const lucid = await Lucid.new(
    new Blockfrost(blockfrostUrl, BLOCKFROST_PROJECT_ID),
    NETWORK === "mainnet" ? "Mainnet" : "Preprod"
  );

  lucid.selectWalletFromSeed(WALLET_SEED);

  const address = await lucid.wallet.address();
  console.log("  Wallet address:", address);

  // Check balance
  const utxos = await lucid.wallet.getUtxos();
  const balance = utxos.reduce((sum, u) => sum + u.assets.lovelace, 0n);
  console.log("  Balance:", Number(balance) / 1_000_000, "ADA");

  if (balance < 2_000_000n) {
    console.error("\n  ERROR: Insufficient balance. Need at least 2 ADA.");
    console.error("  Get test ADA from: https://docs.cardano.org/cardano-testnets/tools/faucet/");
    process.exit(1);
  }

  // Build and submit transaction
  const tx = await lucid
    .newTx()
    .attachMetadata(POI_METADATA_LABEL, cborMetadata[POI_METADATA_LABEL])
    .complete();

  const signedTx = await tx.sign().complete();
  const txHash = await signedTx.submit();

  console.log("  Transaction submitted!");
  console.log("  TxHash:", txHash);

  const explorerUrl =
    NETWORK === "mainnet"
      ? `https://cardanoscan.io/transaction/${txHash}`
      : `https://preprod.cardanoscan.io/transaction/${txHash}`;
  console.log("  Explorer:", explorerUrl);
  console.log("");

  // =========================================================================
  // Step 4: Wait for confirmation and verify
  // =========================================================================
  console.log("Step 4: Waiting for confirmation...");

  try {
    await Promise.race([
      lucid.awaitTx(txHash),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), 120_000)
      ),
    ]);
    console.log("  Transaction confirmed!");
  } catch (e) {
    console.log("  Confirmation timeout (tx may still confirm later)");
  }

  console.log("");
  console.log("Step 5: Verifying anchor on-chain...");

  const provider = createBlockfrostProvider({
    projectId: BLOCKFROST_PROJECT_ID,
    network: NETWORK as "mainnet" | "preprod" | "preview",
  });

  // Wait a moment for indexing
  await new Promise((r) => setTimeout(r, 5000));

  const verification = await verifyAnchor(provider, txHash, bundle.rootHash);

  if (verification.verified) {
    console.log("  Anchor VERIFIED on-chain!");
    console.log("  On-chain root hash:", verification.anchor?.rootHash);
  } else {
    console.log("  Verification pending (explorer may take 30-60s to index)");
    console.log("  Check manually:", explorerUrl);
  }

  console.log("\n=== Done! ===");
  console.log("\nYour AI process trace is now anchored to Cardano.");
  console.log("Anyone can verify this proof using the txHash and rootHash.");
}

main().catch(console.error);
