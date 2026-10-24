import { DEFAULT_MAX_SET_CHANGES, decodeAnchorTransaction, finalityRpc, headerFromRpc, headerHash, midnightTransactionIn, orderedTrieRoot, verifyBlockEffects, verifyFinality, type BlockRef, type ExecutionOutcome, type FinalityCheckpoint, type MidnightSource, type RpcHeader } from "@fluxpointstudios/orynq-sdk-anchors-midnight";

export interface FollowerBlock {
  block: BlockRef;
  parentHash: string;
  timestamp: number;
  runtimeSpecVersion: number;
  sends: { extrinsicIndex: number; bytes: Uint8Array; txHash: string; status: ExecutionOutcome }[];
}
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

export async function verifyFollowerBlock(options: { source: MidnightSource; block: BlockRef; checkpoints: readonly FinalityCheckpoint[]; maxSetChanges?: number }): Promise<FollowerBlock> {
  const block = { ...options.block };
  if (!/^[a-f0-9]{64}$/.test(block.hash) || !Number.isSafeInteger(block.height) || block.height < 1) throw new Error("Invalid follower block reference");
  if (options.maxSetChanges !== undefined && (!Number.isSafeInteger(options.maxSetChanges) || options.maxSetChanges < 0 || options.maxSetChanges > DEFAULT_MAX_SET_CHANGES)) throw new Error("Invalid follower finality budget");
  const response = await options.source.node.call<{ block: { header: RpcHeader; extrinsics: string[] } } | null>("chain_getBlock", [`0x${block.hash}`]);
  if (!response?.block) throw new Error("Follower block is unavailable");
  const header = headerFromRpc(response.block.header);
  if (hex(headerHash(header)) !== block.hash || header.number !== block.height) throw new Error("Follower block header differs from its reference");
  const body = response.block.extrinsics;
  if (!Array.isArray(body) || body.length > 65_536) throw new Error("Invalid follower block body");
  let size = 0;
  const extrinsics = body.map(encoded => {
    if (typeof encoded !== "string" || !/^0x(?:[a-f0-9]{2})+$/.test(encoded)) throw new Error("Invalid follower extrinsic encoding");
    size += (encoded.length - 2) / 2;
    if (size > 16 * 1024 * 1024) throw new Error("Follower block body exceeds its byte limit");
    return new Uint8Array(Buffer.from(encoded.slice(2), "hex"));
  });
  if (hex(orderedTrieRoot(extrinsics)) !== hex(header.extrinsicsRoot)) throw new Error("Follower block body differs from its extrinsics root");
  const finality = await verifyFinality({ rpc: finalityRpc(options.source), block, checkpoints: options.checkpoints, ...(options.maxSetChanges === undefined ? {} : { maxSetChanges: options.maxSetChanges }) });
  if (!finality.finalized) throw new Error(`Follower block finality is unverified: ${finality.reason}`);
  const effects = await verifyBlockEffects(options.source.node, { blockHash: block.hash, header });
  const sends: FollowerBlock["sends"] = [];
  for (const [extrinsicIndex, extrinsic] of extrinsics.entries()) {
    const bytes = midnightTransactionIn(extrinsic);
    if (!bytes) continue;
    const { txHash } = decodeAnchorTransaction(bytes, []);
    sends.push({ extrinsicIndex, bytes, txHash, status: effects.outcome(extrinsicIndex, txHash) });
  }
  effects.assertApplications(sends);
  return { block, parentHash: hex(header.parentHash), timestamp: effects.timestamp, runtimeSpecVersion: effects.runtimeSpecVersion, sends };
}
