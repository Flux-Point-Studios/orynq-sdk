/**
 * Anchor submission logic for Cardano blockchain.
 *
 * Location: services/anchor-worker/src/anchor.ts
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { LucidEvolution, TxBuilder, UTxO } from "@lucid-evolution/lucid";
import {
  buildAnchorMetadata,
  extractRawHash,
  POI_METADATA_LABEL,
  serializeForCbor,
  type AnchorChainProvider,
  type AnchorEntry,
  type CardanoNetwork,
  type ChainedBuild,
  type ChainedSubmitQueue,
} from "@fluxpointstudios/orynq-sdk-anchors-cardano";
import { T_BACKEND_INTERNAL_URL, ANCHOR_WORKER_TOKEN } from "./env.js";

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

export type AnchorProcessTrace = (
  requestId: string,
  manifest: ManifestData,
  storageUri?: string
) => Promise<AnchorResult>;

/**
 * serializeForCbor returns runtime-valid metadata typed loosely; lucid types
 * attachMetadata strictly and does not export the type, so name it here.
 */
type TxMetadata = Parameters<TxBuilder["attachMetadata"]>[1];

/**
 * Notify t-backend that the anchor transaction has been submitted.
 */
export async function notifySubmitted(
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
 * Resolves once txHash is in a block. After timeoutMs it logs and resolves
 * anyway: the tip was most likely dropped, and the wallet read that follows
 * is then the right thing to do.
 */
export async function awaitOnChain(
  chain: Pick<AnchorChainProvider, "getTxInfo">,
  txHash: string,
  { pollMs, timeoutMs }: { pollMs: number; timeoutMs: number }
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      if ((await chain.getTxInfo(txHash)) !== null) return;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }
  const cause =
    lastError === undefined
      ? ""
      : ` (last lookup failed: ${lastError instanceof Error ? lastError.message : String(lastError)})`;
  console.warn(
    `[anchor] ${txHash} not on chain after ${timeoutMs}ms${cause}; reading the wallet from the provider anyway`
  );
}

function anchorTx(lucid: LucidEvolution, payload: TxMetadata): ChainedBuild<UTxO> {
  return async (walletUtxos) => {
    const available = walletUtxos ?? (await lucid.utxosAt(await lucid.wallet().address()));
    // The seed wallet both selects and signs from its overridden UTxOs; left
    // empty, it would re-read the provider and pick inputs the mempool spent.
    lucid.overrideUTxOs(available);
    const [next, , unsigned] = await lucid
      .newTx()
      .attachMetadata(POI_METADATA_LABEL, payload)
      .chain();
    const signed = await unsigned.sign.withWallet().complete();
    const txHash = await signed.submit();
    const spent = available
      .filter((u) => !next.some((n) => n.txHash === u.txHash && n.outputIndex === u.outputIndex))
      .map((u) => `${u.txHash}#${u.outputIndex}`);
    console.log(
      `[anchor] Transaction submitted: ${txHash} spending ${spent.join(",")} (${walletUtxos === undefined ? "fresh wallet read" : "chained"})`
    );
    return { txHash, walletUtxos: next };
  };
}

export function createProcessTraceAnchorer(deps: {
  /** Wallet selected; builds only through `queue`, which owns its UTxO override. */
  lucid: LucidEvolution;
  queue: ChainedSubmitQueue<UTxO>;
  network: CardanoNetwork;
  notifySubmitted: (requestId: string, txHash: string, network: CardanoNetwork) => Promise<void>;
}): AnchorProcessTrace {
  return async function anchorProcessTrace(requestId, manifest, storageUri) {
    const entry: AnchorEntry = {
      type: "process-trace",
      version: "1.0",
      rootHash: manifest.rootHash,
      manifestHash: manifest.manifestHash,
      timestamp: new Date().toISOString(),
    };
    if (manifest.merkleRoot) entry.merkleRoot = manifest.merkleRoot;
    if (typeof manifest.totalEvents === "number") entry.itemCount = manifest.totalEvents;
    if (manifest.agentId) entry.agentId = manifest.agentId;
    if (storageUri) entry.storageUri = storageUri;

    // serializeForCbor chunks strings past Cardano's 64-byte metadata limit.
    const payload = serializeForCbor(buildAnchorMetadata(entry))[
      POI_METADATA_LABEL
    ] as TxMetadata;

    // The root is part of the key so a request is never answered with a tx
    // whose metadata carries someone else's root under the same manifestHash.
    const key = `${extractRawHash(manifest.manifestHash)}:${extractRawHash(manifest.rootHash)}`;
    const { txHash, chainPosition, deduplicated } = await deps.queue.submit(
      key,
      anchorTx(deps.lucid, payload)
    );
    console.log(
      deduplicated
        ? `[anchor] Request ${requestId} reuses ${txHash}: manifest ${manifest.manifestHash} is already in flight or anchored`
        : `[anchor] Request ${requestId} anchored in ${txHash} (chain position ${chainPosition})`
    );

    await deps.notifySubmitted(requestId, txHash, deps.network);

    return {
      txHash,
      network: deps.network,
      label: POI_METADATA_LABEL,
      rootHash: manifest.rootHash,
      manifestHash: manifest.manifestHash,
      merkleRoot: manifest.merkleRoot,
    };
  };
}
