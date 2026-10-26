import { createHash } from "node:crypto";
import { headerHash, midnightExtrinsic, orderedTrieRoot, type BlockHeader } from "@fluxpointstudios/orynq-sdk-anchors-midnight";

export interface OfflineBlockChain {
  landed: Record<string, { raw: string; height: number; block?: string }>;
  viewHead?: number;
  blockTimes?: Record<string, number>;
  viewAheadMs?: number;
}
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
export const offlineHeight = (chain: OfflineBlockChain) => Math.max(499, chain.viewHead ?? 499, ...Object.values(chain.landed).map(tx => tx.height));

// A coherent finalized prefix: each complete body commits to its actual extrinsics and every
// successor names the preceding header hash. `block` is a fork marker, never a forged hash.
export function offlineBlocks(chain: OfflineBlockChain, fork = false) {
  const blocks = new Map<number, { hash: string; header: BlockHeader; extrinsics: Uint8Array[] }>();
  let parent = "0f".repeat(32);
  for (let height = 499; height <= offlineHeight(chain); height++) {
    const txs = Object.values(chain.landed).filter(tx => tx.height === height && tx.raw);
    const extrinsics = txs.map(tx => midnightExtrinsic(Buffer.from(tx.raw, "hex")));
    const stateRoot = createHash("sha256").update(JSON.stringify({ height, fork: fork && height > 499, markers: txs.map(tx => tx.block ?? "") })).digest();
    const header: BlockHeader = { parentHash: Buffer.from(parent, "hex"), number: height, stateRoot, extrinsicsRoot: orderedTrieRoot(extrinsics), digest: [] };
    const hash = hex(headerHash(header));
    blocks.set(height, { hash, header, extrinsics }); parent = hash;
  }
  return blocks;
}
export const offlineBlockHash = (chain: OfflineBlockChain, height: number) => offlineBlocks(chain).get(height)?.hash;
export const offlineRpcHeader = (header: BlockHeader) => ({ parentHash: `0x${hex(header.parentHash)}`, number: `0x${header.number.toString(16)}`, stateRoot: `0x${hex(header.stateRoot)}`, extrinsicsRoot: `0x${hex(header.extrinsicsRoot)}`, digest: { logs: [] } });
