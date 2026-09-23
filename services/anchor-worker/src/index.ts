/**
 * Anchor Worker Service - Express server for processing trace anchoring.
 *
 * Location: services/anchor-worker/src/index.ts
 */

import { Blockfrost, Lucid, type Network, type UTxO } from "@lucid-evolution/lucid";
import {
  createBlockfrostProvider,
  createChainedSubmitQueue,
  getBlockfrostBaseUrl,
  type CardanoNetwork,
} from "@fluxpointstudios/orynq-sdk-anchors-cardano";
import {
  ANCHOR_WORKER_TOKEN,
  BLOCKFROST_PROJECT_ID,
  CARDANO_NETWORK,
  PORT,
  WALLET_SEED_PHRASE,
  validateEnv,
} from "./env.js";
import { awaitOnChain, createProcessTraceAnchorer, notifySubmitted } from "./anchor.js";
import { createApp } from "./app.js";

validateEnv();

const LUCID_NETWORK: Record<CardanoNetwork, Network> = {
  mainnet: "Mainnet",
  preprod: "Preprod",
  preview: "Preview",
};

const lucid = await Lucid(
  new Blockfrost(getBlockfrostBaseUrl(CARDANO_NETWORK), BLOCKFROST_PROJECT_ID!),
  LUCID_NETWORK[CARDANO_NETWORK]
);
lucid.selectWallet.fromSeed(WALLET_SEED_PHRASE!);

const chain = createBlockfrostProvider({
  projectId: BLOCKFROST_PROJECT_ID!,
  network: CARDANO_NETWORK,
});

// The queue lives in this process: run one worker per wallet, or replicas race
// for the same UTxOs again.
const queue = createChainedSubmitQueue<UTxO>({
  // Bounds how many acknowledged anchors one dropped tx can take with it.
  maxChainLength: 10,
  // Idle this long (about four preprod blocks), the chain has landed; re-read the
  // wallet so a top-up or an outside spend is seen.
  cacheTtlMs: 90_000,
  // About what drains within t-backend's 30s client timeout (a chain of ten plus
  // one block wait); later callers get 503 at once instead of timing out.
  // t-backend records a 503 as ERROR without retrying it.
  maxPending: 20,
  // A re-send of an anchor seen on chain within this window gets its txHash
  // instead of paying for a second tx.
  dedupeTtlMs: 6 * 60 * 60 * 1000,
  dedupeMaxEntries: 10_000,
  awaitConfirmation: (txHash) => awaitOnChain(chain, txHash, { pollMs: 5_000, timeoutMs: 120_000 }),
});

const app = createApp({
  token: ANCHOR_WORKER_TOKEN!,
  network: CARDANO_NETWORK,
  anchor: createProcessTraceAnchorer({ lucid, queue, network: CARDANO_NETWORK, notifySubmitted }),
});

app.listen(PORT, () => {
  console.log(`[anchor-worker] Service started on port ${PORT} (network=${CARDANO_NETWORK})`);
  console.log(`[anchor-worker] Health check: http://localhost:${PORT}/health`);
});
