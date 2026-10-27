import * as L from "@midnight-ntwrk/ledger-v8";
import { verifyExecution } from "./execution.js";
import { verifyFinality, type FinalityCheckpoint } from "./grandpa.js";
import { fromHex, toHex } from "./scale.js";
import { finalityRpc, type MidnightSource } from "./source.js";
import { headerFromRpc, headerHash, includedTransactionIndex, orderedTrieRoot, type RpcHeader } from "./substrate.js";

// Checkpoints belong to the caller's trust configuration, never to the receipt being checked.
export async function verifyFinalizedTransaction(txHash: string, { source, checkpoints }: {
  source: MidnightSource; checkpoints: readonly FinalityCheckpoint[];
}) {
  if (!/^[0-9a-f]{64}$/.test(txHash)) throw new Error("Invalid transaction hash");
  const found = await source.indexer.transactions(txHash);
  if (found.length !== 1) throw new Error("Expected exactly one located transaction");
  const located = found[0]!;
  const bytes = fromHex(located.raw, "transaction");
  const tx = L.Transaction.deserialize("signature", "proof", "binding", bytes);
  if (tx.transactionHash() !== txHash || toHex(tx.serialize()) !== toHex(bytes)) throw new Error("Transaction bytes differ from their hash or canonical encoding");
  const block = { height: located.block.height, hash: located.block.hash };
  if (!/^[0-9a-f]{64}$/.test(block.hash) || !Number.isSafeInteger(block.height) || block.height < 0) throw new Error("Invalid block locator");
  const response = await source.node.call<{ block: { header: RpcHeader; extrinsics: string[] } }>("chain_getBlock", [`0x${block.hash}`]);
  const header = headerFromRpc(response.block.header);
  if (toHex(headerHash(header)) !== block.hash || header.number !== block.height) throw new Error("Block header contradicts its locator");
  const extrinsics = response.block.extrinsics.map(value => fromHex(value, "extrinsic"));
  if (toHex(orderedTrieRoot(extrinsics)) !== toHex(header.extrinsicsRoot)) throw new Error("Block body differs from its authenticated root");
  const extrinsicIndex = includedTransactionIndex(extrinsics, bytes);
  if (extrinsicIndex === null) throw new Error("Transaction is absent from the block body");
  const finality = await verifyFinality({ rpc: finalityRpc(source), block, checkpoints });
  if (!finality.finalized) throw new Error(`Unverified finality: ${finality.reason}`);
  const execution = await verifyExecution(source.node, { blockHash: block.hash, header, extrinsicIndex, txHash });
  return { bytes, block, finality, timestamp: execution.timestamp, extrinsicIndex };
}
