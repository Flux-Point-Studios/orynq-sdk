/**
 * Anchor submission logic for Cardano blockchain.
 *
 * Location: services/anchor-worker/src/anchor.ts
 */

import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { LucidEvolution, TxBuilder, UTxO } from "@lucid-evolution/lucid";
import {
  buildAnchorMetadata,
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

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Resolves true once txHash is in a block, or false after timeoutMs; a
 * timeoutMs of 0 looks it up once. A failed lookup counts as not found and is
 * named in the warning, so the queue never fails a request over it.
 */
export async function awaitOnChain(
  chain: Pick<AnchorChainProvider, "getTxInfo">,
  txHash: string,
  { pollMs, timeoutMs }: { pollMs: number; timeoutMs: number }
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      if ((await chain.getTxInfo(txHash)) !== null) return true;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }
  const cause = lastError === undefined ? "" : ` (last lookup failed: ${messageOf(lastError)})`;
  console.warn(
    `[anchor] ${txHash} not on chain after ${timeoutMs}ms${cause}; a re-post of what it anchored submits again`
  );
  return false;
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
    const txHash = signed.toHash();
    const spent = available
      .filter((u) => !next.some((n) => n.txHash === u.txHash && n.outputIndex === u.outputIndex))
      .map((u) => `${u.txHash}#${u.outputIndex}`);
    return {
      txHash,
      walletUtxos: next,
      submit: async () => {
        try {
          await signed.submit();
        } catch (error) {
          // The queue may still find this tx on chain and answer with it.
          console.warn(`[anchor] Submit of ${txHash} failed: ${messageOf(error)}`);
          throw error;
        }
        console.log(
          `[anchor] Transaction submitted: ${txHash} spending ${spent.join(",")} (${walletUtxos === undefined ? "fresh wallet read" : "chained"})`
        );
      },
    };
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

    // Everything the tx anchors but its timestamp, strings exactly as sent: a
    // request is only ever answered with a tx that anchors what it asked for.
    const key = createHash("sha256")
      .update(JSON.stringify({ ...entry, timestamp: undefined }))
      .digest("hex");
    const { txHash, chainPosition, deduplicated } = await deps.queue.submit(
      key,
      anchorTx(deps.lucid, payload)
    );
    console.log(
      deduplicated
        ? `[anchor] Request ${requestId} reuses ${txHash}: an identical anchor of manifest ${manifest.manifestHash} is already in flight or anchored`
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
