import { createHash } from "node:crypto";
import { DEFAULT_MAX_SET_CHANGES, checkpointFromJson, checkpointId, decodeAnchorTransaction, finalityRpc, headerFromRpc, headerHash, midnightTransactionIn, orderedTrieRoot, verifyBlockEffects, verifyFinality, type BlockRef, type CheckpointAdvance, type ExecutionOutcome, type FinalityCheckpoint, type MidnightNetwork, type MidnightSource, type RpcHeader } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { authenticateCheckpointHistory } from "./checkpoint-history.js";

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
  return readEffects(options.source.node, body, network, policyDigest);
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
  return { block, header, rpcHeader: structuredClone(response.block.header), extrinsics, bytes: size };
}

async function readEffects(node: MidnightSource["node"], body: Awaited<ReturnType<typeof readBody>>, network: MidnightNetwork, policyDigest: string): Promise<FollowerBlock> {
  const { block, header, extrinsics } = body;
  const effects = await verifyBlockEffects(node, { blockHash: block.hash, header });
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

export function openFollowerReader(options: { source: MidnightSource; checkpoints: readonly FinalityCheckpoint[]; maxSetChanges?: number; advances?: readonly CheckpointAdvance[] }) {
  const source = options.source, network = source.network, checkpoints = structuredClone(options.checkpoints), maximum = options.maxSetChanges ?? DEFAULT_MAX_SET_CHANGES;
  if (network !== "mainnet" && network !== "preprod") throw new Error("Follower source must name its network");
  const policyDigest = followerPolicyDigest(checkpoints, maximum);
  if (!checkpoints.length || checkpoints.length > 64) throw new Error("Follower reader requires 1..64 original checkpoints");
  const roots = checkpoints.map(checkpoint => ({ checkpoint, rootId: checkpointId(checkpoint), used: 0 }));
  const cached = new Map<string, typeof roots[number]>();
  const advances = structuredClone(options.advances ?? []);
  let ready: Promise<void> | undefined;
  const prepare = () => ready ??= (async () => {
    if (!advances.length) return;
    const verified = await authenticateCheckpointHistory(network, checkpoints, advances);
    // Retain each verified step, not only the tip: historical replay must remain possible
    // after many maintenance advances. Every step independently renews the bounded allowance.
    for (const artifact of verified.artifacts) roots.push({ checkpoint: checkpointFromJson(artifact.successor), rootId: artifact.rootId, used: 0 });
  })();
  return {
    async *range(input: { after: BlockRef; end: BlockRef }): AsyncGenerator<FollowerBlock> {
      await prepare();
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
      bodies.reverse();
      const headers = new Map(bodies.map(body => [`0x${body.block.hash}`, body.rpcHeader]));
      // Ten blocks fit both the proxy's 32-call and 8 KiB request limits.
      for (let offset = 0; offset < bodies.length; offset += 10) {
        const requests: [string, unknown[]][] = [];
        const waiting: { indices: (number | RpcHeader)[]; resolve: (values: unknown[]) => void; reject: (reason: unknown) => void }[] = [];
        const node: MidnightSource["node"] = { call: source.node.call, async batch<T>(calls: [string, unknown[]][]) {
          const indices = calls.map(([method, params]) => {
            const header = method === "chain_getHeader" && params.length === 1 && typeof params[0] === "string" ? headers.get(params[0]) : undefined;
            if (header) return header;
            requests.push([method, params]); return requests.length - 1;
          });
          return new Promise<T[]>((resolve, reject) => waiting.push({ indices, resolve: values => resolve(values as T[]), reject }));
        } };
        const completed = Promise.allSettled(bodies.slice(offset, offset + 10).map(body => readEffects(node, body, network, policyDigest)));
        try {
          const payload = requests.map(([method, params], id) => ({ jsonrpc: "2.0", id, method, params }));
          if (requests.length > 32 || Buffer.byteLength(JSON.stringify(payload)) > 8192) throw new Error("Follower effect batch exceeds the proxy request limit");
          const answers = await source.node.batch(requests);
          if (answers.length !== requests.length) throw new Error("Follower effect batch response length differs");
          for (const row of waiting) row.resolve(row.indices.map(index => typeof index === "number" ? answers[index] : index));
        } catch (error) { for (const row of waiting) row.reject(error); }
        for (const result of await completed) {
          if (result.status === "rejected") throw result.reason;
          yield result.value;
        }
      }
    },
  };
}
