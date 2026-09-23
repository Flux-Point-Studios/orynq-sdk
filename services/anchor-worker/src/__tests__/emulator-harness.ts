/**
 * Real lucid-evolution tx building against its Emulator, which behaves like
 * Blockfrost over a node: wallet reads show only block-confirmed UTxOs
 * (including ones a mempool tx has spent), while submission validates against
 * the ledger plus the mempool. `chain.getTxInfo` answers from the same blocks.
 */
import { expect } from "vitest";
import {
  CML,
  Emulator,
  Lucid,
  generateEmulatorAccount,
  type UTxO,
} from "@lucid-evolution/lucid";
import {
  createChainedSubmitQueue,
  POI_METADATA_LABEL,
  type AnchorChainProvider,
  type ChainedSubmitQueueOptions,
} from "@fluxpointstudios/orynq-sdk-anchors-cardano";

import { awaitOnChain, createProcessTraceAnchorer, type ManifestData } from "../anchor.js";

export interface SubmittedTx {
  txHash: string;
  inputs: string[];
  isAnchor: boolean;
}

export async function emulatorHarness(queueOptions: Partial<ChainedSubmitQueueOptions> = {}) {
  const account = generateEmulatorAccount({ lovelace: 500_000_000n });
  const emulator = new Emulator([account]);

  const submitted: SubmittedTx[] = [];
  const unconfirmed: string[] = [];
  const confirmed = new Set<string>();

  const submitTx = emulator.submitTx.bind(emulator);
  emulator.submitTx = async (cbor: string) => {
    const txHash = await submitTx(cbor);
    const tx = CML.Transaction.from_cbor_hex(cbor);
    const inputs = tx.body().inputs();
    submitted.push({
      txHash,
      inputs: Array.from({ length: inputs.len() }, (_, i) => {
        const input = inputs.get(i);
        return `${input.transaction_id().to_hex()}#${input.index()}`;
      }),
      isAnchor: tx.auxiliary_data()?.metadata()?.get(BigInt(POI_METADATA_LABEL)) !== undefined,
    });
    unconfirmed.push(txHash);
    return txHash;
  };
  const awaitBlock = emulator.awaitBlock.bind(emulator);
  emulator.awaitBlock = (height?: number) => {
    awaitBlock(height);
    for (const txHash of unconfirmed.splice(0)) confirmed.add(txHash);
  };

  const chain: Pick<AnchorChainProvider, "getTxInfo"> = {
    getTxInfo: async (txHash) =>
      confirmed.has(txHash)
        ? {
            txHash,
            blockHash: "00".repeat(32),
            blockHeight: emulator.blockHeight,
            slot: emulator.slot,
            timestamp: new Date(emulator.now()).toISOString(),
            confirmations: 1,
          }
        : null,
  };

  const lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromSeed(account.seedPhrase);

  const queue = createChainedSubmitQueue<UTxO>({
    maxChainLength: 100,
    cacheTtlMs: 90_000,
    maxPending: 1_000,
    dedupeTtlMs: 3_600_000,
    dedupeMaxEntries: 1_000,
    awaitConfirmation: (txHash) => awaitOnChain(chain, txHash, { pollMs: 5, timeoutMs: 2_000 }),
    ...queueOptions,
  });

  const notified: Array<{ requestId: string; txHash: string; network: string }> = [];
  const anchor = createProcessTraceAnchorer({
    lucid,
    queue,
    network: "preprod",
    notifySubmitted: async (requestId, txHash, network) => {
      notified.push({ requestId, txHash, network });
    },
  });

  return { account, emulator, lucid, anchor, submitted, notified };
}

const blockProducers: Array<ReturnType<typeof setInterval>> = [];

/** Produces a block every 20ms, as a live chain would. */
export function produceBlocks(emulator: Emulator): void {
  blockProducers.push(setInterval(() => emulator.awaitBlock(), 20));
}

export function stopProducingBlocks(): void {
  for (const producer of blockProducers.splice(0)) clearInterval(producer);
}

export function manifest(i: number, rootByte = "a"): ManifestData {
  const suffix = i.toString(16).padStart(2, "0");
  return {
    rootHash: `sha256:${rootByte.repeat(62)}${suffix}`,
    manifestHash: `sha256:${"b".repeat(62)}${suffix}`,
    totalEvents: i,
  };
}

export function expectEachSpendsThePreviousChange(txs: SubmittedTx[]): void {
  for (let i = 1; i < txs.length; i++) {
    expect(txs[i]!.inputs).toEqual([`${txs[i - 1]!.txHash}#0`]);
  }
  const inputs = txs.flatMap((tx) => tx.inputs);
  expect(new Set(inputs).size).toBe(inputs.length);
}
