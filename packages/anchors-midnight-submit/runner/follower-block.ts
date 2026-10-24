import { createHash } from "node:crypto";
import { DEFAULT_MAX_SET_CHANGES, checkpointId, decodeAnchorTransaction, finalityRpc, headerFromRpc, headerHash, midnightTransactionIn, orderedTrieRoot, verifyBlockEffects, verifyFinality, type BlockRef, type ExecutionOutcome, type FinalityCheckpoint, type MidnightNetwork, type MidnightSource, type RpcHeader } from "@fluxpointstudios/orynq-sdk-anchors-midnight";

export interface FollowerBlock {
  network: MidnightNetwork;
  policyDigest: string;
  block: BlockRef;
  parentHash: string;
  timestamp: number;
  runtimeSpecVersion: number;
  sends: { extrinsicIndex: number; bytes: Uint8Array; txHash: string; status: ExecutionOutcome }[];
}
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

export function followerPolicyDigest(checkpoints: readonly FinalityCheckpoint[], maxSetChanges = DEFAULT_MAX_SET_CHANGES): string {
  if (!Number.isSafeInteger(maxSetChanges) || maxSetChanges < 0 || maxSetChanges > DEFAULT_MAX_SET_CHANGES) throw new Error("Invalid follower finality budget");
  return createHash("sha256").update(JSON.stringify([checkpoints.map(checkpointId), maxSetChanges])).digest("hex");
}

export async function verifyFollowerBlock(options: { source: MidnightSource; block: BlockRef; checkpoints: readonly FinalityCheckpoint[]; maxSetChanges?: number }): Promise<FollowerBlock> {
  const block = { ...options.block };
  const network = options.source.network;
  if (network !== "mainnet" && network !== "preprod") throw new Error("Follower source must name its network");
  const checkpoints = structuredClone(options.checkpoints), maxSetChanges = options.maxSetChanges ?? DEFAULT_MAX_SET_CHANGES;
  const policyDigest = followerPolicyDigest(checkpoints, maxSetChanges);
  const body = await readBody(options.source, block);
  const finality = await verifyFinality({ rpc: finalityRpc(options.source), block, checkpoints, maxSetChanges });
  if (!finality.finalized) throw new Error(`Follower block finality is unverified: ${finality.reason}`);
  return readEffects(options.source, body, network, policyDigest);
}

async function readBody(source: MidnightSource, block: BlockRef) {
  if (!/^[a-f0-9]{64}$/.test(block.hash) || !Number.isSafeInteger(block.height) || block.height < 1) throw new Error("Invalid follower block reference");
  const response = await source.node.call<{ block: { header: RpcHeader; extrinsics: string[] } } | null>("chain_getBlock", [`0x${block.hash}`]);
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
  return { block, header, extrinsics, bytes: size };
}

async function readEffects(source: MidnightSource, body: Awaited<ReturnType<typeof readBody>>, network: MidnightNetwork, policyDigest: string): Promise<FollowerBlock> {
  const { block, header, extrinsics } = body;
  const effects = await verifyBlockEffects(source.node, { blockHash: block.hash, header });
  const sends: FollowerBlock["sends"] = [];
  for (const [extrinsicIndex, extrinsic] of extrinsics.entries()) {
    const bytes = midnightTransactionIn(extrinsic);
    if (!bytes) continue;
    const { txHash } = decodeAnchorTransaction(bytes, []);
    sends.push({ extrinsicIndex, bytes, txHash, status: effects.outcome(extrinsicIndex, txHash) });
  }
  effects.assertApplications(sends);
  return { network, policyDigest, block: { ...block }, parentHash: hex(header.parentHash), timestamp: effects.timestamp, runtimeSpecVersion: effects.runtimeSpecVersion, sends };
}

export function openFollowerReader(options: { source: MidnightSource; checkpoints: readonly FinalityCheckpoint[]; maxSetChanges?: number }) {
  const source = options.source, network = source.network, checkpoints = structuredClone(options.checkpoints), maximum = options.maxSetChanges ?? DEFAULT_MAX_SET_CHANGES;
  if (network !== "mainnet" && network !== "preprod") throw new Error("Follower source must name its network");
  const policyDigest = followerPolicyDigest(checkpoints, maximum);
  if (!checkpoints.length || checkpoints.length > 64) throw new Error("Follower reader requires 1..64 original checkpoints");
  const roots = checkpoints.map(checkpoint => ({ checkpoint, rootId: checkpointId(checkpoint), used: 0 }));
  const cached = new Map<string, typeof roots[number]>();
  return {
    async *range(input: { after: BlockRef; end: BlockRef }): AsyncGenerator<FollowerBlock> {
      const after = { ...input.after }, end = { ...input.end };
      if (![after, end].every(block => /^[a-f0-9]{64}$/.test(block.hash) && Number.isSafeInteger(block.height) && block.height >= 0) || end.height <= after.height || end.height - after.height > 32) throw new Error("Follower range must contain 1..32 exact blocks");
      const root = roots.filter(row => row.checkpoint.startsAfter.height < end.height).sort((a, b) => b.checkpoint.startsAfter.height - a.checkpoint.startsAfter.height)[0];
      if (!root) throw new Error("No original finality checkpoint lies below the follower range");
      const seed = [root, ...cached.values()].filter(row => row.rootId === root.rootId && row.checkpoint.startsAfter.height < end.height).sort((a, b) => b.checkpoint.startsAfter.height - a.checkpoint.startsAfter.height)[0]!;
      const last = await readBody(source, end);
      const finality = await verifyFinality({ rpc: finalityRpc(source), block: end, checkpoints: [structuredClone(seed.checkpoint)], maxSetChanges: maximum - seed.used });
      if (!finality.finalized) throw new Error(`Follower range finality is unverified: ${finality.reason}`);
      const used = seed.used + finality.setChanges;
      if (!Number.isSafeInteger(used) || used < 0 || used > maximum || finality.checkpoint.setId !== seed.checkpoint.setId + BigInt(finality.setChanges)) throw new Error("Follower verified transition accounting differs");
      const bodies = [last]; let bytes = last.bytes, parent = { height: end.height - 1, hash: hex(last.header.parentHash) };
      while (parent.height > after.height) {
        const body = await readBody(source, parent); bodies.push(body); bytes += body.bytes;
        if (bytes > 16 * 1024 * 1024) throw new Error("Follower range bodies exceed their byte limit");
        parent = { height: parent.height - 1, hash: hex(body.header.parentHash) };
      }
      if (parent.hash !== after.hash || parent.height !== after.height) throw new Error("Follower range does not link to its durable parent");
      const checkpoint = structuredClone(finality.checkpoint), id = checkpointId(checkpoint);
      for (const row of cached.values()) {
        if (row.rootId === root.rootId && row.checkpoint.setId === checkpoint.setId && row.checkpoint.startsAfter.height === checkpoint.startsAfter.height && checkpointId(row.checkpoint) !== id) throw new Error("Conflicting verified follower checkpoints");
      }
      const key = `${root.rootId}:${id}`;
      if (!cached.has(key) && cached.size >= 64) cached.delete(cached.keys().next().value!);
      cached.set(key, { checkpoint, rootId: root.rootId, used });
      for (const body of bodies.reverse()) yield await readEffects(source, body, network, policyDigest);
    },
  };
}
