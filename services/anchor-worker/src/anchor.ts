/**
 * Anchor submission logic for Cardano blockchain.
 *
 * Location: services/anchor-worker/src/anchor.ts
 */

import { Lucid, Blockfrost } from "lucid-cardano";
import {
  buildAnchorMetadata,
  serializeForCbor,
  type AnchorEntry,
} from "@fluxpointstudios/poi-sdk-anchors-cardano";
import {
  BLOCKFROST_PROJECT_ID,
  CARDANO_NETWORK,
  WALLET_SEED_PHRASE,
  T_BACKEND_INTERNAL_URL,
  ANCHOR_WORKER_TOKEN,
  AWAIT_TX_TIMEOUT,
} from "./env.js";

/**
 * PoI metadata label for Cardano transactions.
 */
const POI_METADATA_LABEL = 2222;

/**
 * Lucid instance singleton.
 */
let lucidInstance: Awaited<ReturnType<typeof Lucid.new>> | null = null;

/**
 * Get or create Lucid instance.
 */
async function getLucid(): Promise<Awaited<ReturnType<typeof Lucid.new>>> {
  if (lucidInstance) {
    return lucidInstance;
  }

  const networkMap: Record<string, string> = {
    mainnet: "https://cardano-mainnet.blockfrost.io/api/v0",
    preprod: "https://cardano-preprod.blockfrost.io/api/v0",
    preview: "https://cardano-preview.blockfrost.io/api/v0",
  };

  const baseUrl = networkMap[CARDANO_NETWORK];
  if (!baseUrl) {
    throw new Error(`Unsupported network: ${CARDANO_NETWORK}`);
  }

  lucidInstance = await Lucid.new(
    new Blockfrost(baseUrl, BLOCKFROST_PROJECT_ID!),
    CARDANO_NETWORK === "mainnet" ? "Mainnet" : "Preprod"
  );

  lucidInstance.selectWalletFromSeed(WALLET_SEED_PHRASE!);

  return lucidInstance;
}

/**
 * Result of anchor submission.
 */
export interface AnchorResult {
  txHash: string;
  network: string;
  label: number;
  rootHash: string;
  manifestHash: string;
  merkleRoot?: string;
}

/**
 * Manifest data structure from request.
 */
export interface ManifestData {
  rootHash: string;
  manifestHash: string;
  merkleRoot?: string;
  totalEvents?: number;
  agentId?: string;
}

/**
 * Notify t-backend that the anchor transaction has been submitted.
 */
async function notifySubmitted(
  requestId: string,
  txHash: string,
  network: string
): Promise<void> {
  try {
    const url = `${T_BACKEND_INTERNAL_URL}/anchors/internal/${requestId}/submitted`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": ANCHOR_WORKER_TOKEN!,
      },
      body: JSON.stringify({ txHash, network }),
    });

    if (!response.ok) {
      console.error(
        `[anchor] Callback to t-backend failed: ${response.status} ${response.statusText}`
      );
    }
  } catch (error) {
    // Best-effort callback - log but don't fail the anchor operation
    console.error("[anchor] Callback to t-backend error:", error);
  }
}

/**
 * Anchor a process trace to the Cardano blockchain.
 *
 * @param requestId - Request ID for callback tracking
 * @param manifest - Manifest data containing hashes
 * @param storageUri - Optional storage URI for the trace
 * @returns Anchor result with transaction hash and metadata
 */
export async function anchorProcessTrace(
  requestId: string,
  manifest: ManifestData,
  storageUri?: string
): Promise<AnchorResult> {
  const lucid = await getLucid();

  // Build AnchorEntry from manifest
  const entry: AnchorEntry = {
    type: "process-trace",
    version: "1.0",
    rootHash: manifest.rootHash,
    manifestHash: manifest.manifestHash,
    timestamp: new Date().toISOString(),
  };

  // Add optional fields using ?? for falsy handling
  if (manifest.merkleRoot ?? undefined) {
    entry.merkleRoot = manifest.merkleRoot;
  }

  if ((manifest.totalEvents ?? undefined) !== undefined) {
    entry.itemCount = manifest.totalEvents;
  }

  if (manifest.agentId ?? undefined) {
    entry.agentId = manifest.agentId;
  }

  if (storageUri ?? undefined) {
    entry.storageUri = storageUri;
  }

  // Build metadata using the anchors-cardano package
  const anchorResult = buildAnchorMetadata(entry);

  // Serialize for CBOR - handles 64-byte string limit by chunking long strings
  const cborMetadata = serializeForCbor(anchorResult);
  const metadataPayload = cborMetadata[POI_METADATA_LABEL];

  // Build and sign transaction
  // NO explicit self-payment output - let Lucid handle change automatically
  const tx = await lucid
    .newTx()
    .attachMetadata(POI_METADATA_LABEL, metadataPayload)
    .complete();

  const signedTx = await tx.sign().complete();
  const txHash = await signedTx.submit();

  console.log(`[anchor] Transaction submitted: ${txHash}`);

  // Callback to t-backend immediately after submit
  await notifySubmitted(requestId, txHash, CARDANO_NETWORK);

  // Best-effort awaitTx with short timeout - don't fail on slow mempool
  try {
    await Promise.race([
      lucid.awaitTx(txHash),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("awaitTx timeout")),
          AWAIT_TX_TIMEOUT
        )
      ),
    ]);
    console.log(`[anchor] Transaction confirmed: ${txHash}`);
  } catch (error) {
    // Log but don't fail - tx is already submitted
    console.log(
      `[anchor] awaitTx timeout or error (tx still submitted): ${error}`
    );
  }

  return {
    txHash,
    network: CARDANO_NETWORK,
    label: POI_METADATA_LABEL,
    rootHash: manifest.rootHash,
    manifestHash: manifest.manifestHash,
    merkleRoot: manifest.merkleRoot,
  };
}
