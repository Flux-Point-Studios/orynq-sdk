import { sha256 } from "@noble/hashes/sha2.js";
import { checkpointId } from "./checkpoints.js";
import { DEFAULT_MAX_SET_CHANGES, verifyFinality, type BlockRef, type FinalityCheckpoint, type FinalityRpc } from "./grandpa.js";
import type { CheckpointJson } from "./known-authors.js";
import type { MidnightNetwork } from "./registries.js";
import type { RpcHeader } from "./substrate.js";

export interface CheckpointAdvance {
  format: "orynq-midnight-checkpoint-advance/v1";
  network: MidnightNetwork;
  rootId: string;
  predecessorId: string;
  sequence: number;
  previousDigest: string | null;
  block: BlockRef;
  successor: CheckpointJson;
  proofs: [number, string | null][];
  headers: [string, RpcHeader][];
}
const MAX_BYTES = 64 * 1024 * 1024;
const hash32 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
const unhex = (value: string) => new Uint8Array(value.match(/../g)!.map(byte => Number.parseInt(byte, 16)));
const encodedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function bounded(value: unknown) { if (encodedBytes(value).length > MAX_BYTES) throw new Error("Checkpoint advancement exceeds its byte budget"); }
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error("Checkpoint advancement fields differ");
}
export function checkpointToJson(checkpoint: FinalityCheckpoint): CheckpointJson {
  return { setId: checkpoint.setId.toString(), startsAfter: { ...checkpoint.startsAfter }, authorities: checkpoint.authorities.map(row => ({ key: row.key, weight: row.weight.toString() })) };
}
export function checkpointFromJson(value: unknown): FinalityCheckpoint {
  exact(value, ["setId", "startsAfter", "authorities"]);
  if (typeof value.setId !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value.setId) || BigInt(value.setId) > 0xffff_ffff_ffff_ffffn) throw new Error("Invalid checkpoint set id");
  exact(value.startsAfter, ["height", "hash"]);
  if (!Number.isSafeInteger(value.startsAfter.height) || Number(value.startsAfter.height) < 0 || !hash32(value.startsAfter.hash)) throw new Error("Invalid checkpoint start");
  if (!Array.isArray(value.authorities) || !value.authorities.length || value.authorities.length > 4096) throw new Error("Invalid checkpoint authorities");
  const seen = new Set<string>();
  const authorities = value.authorities.map(row => {
    exact(row, ["key", "weight"]);
    if (!hash32(row.key) || seen.has(row.key) || typeof row.weight !== "string" || !/^[1-9][0-9]{0,19}$/.test(row.weight) || BigInt(row.weight) > 0xffff_ffff_ffff_ffffn) throw new Error("Invalid checkpoint authority");
    seen.add(row.key); return { key: row.key, weight: BigInt(row.weight) };
  });
  return { setId: BigInt(value.setId), startsAfter: { height: Number(value.startsAfter.height), hash: value.startsAfter.hash }, authorities };
}
export function checkpointAdvanceId(artifact: CheckpointAdvance): string {
  bounded(artifact);
  return hex(sha256(new TextEncoder().encode(`orynq:checkpoint-advance:v1\n${JSON.stringify(artifact)}`)));
}

export async function verifyCheckpointAdvance(options: {
  artifact: unknown; predecessor: FinalityCheckpoint; expectedNetwork: MidnightNetwork;
  expectedSequence: number; previousDigest: string | null; rootId?: string;
}): Promise<{ checkpoint: FinalityCheckpoint; digest: string; block: BlockRef; sequence: number; setChanges: number }> {
  const artifact = options.artifact;
  bounded(artifact);
  exact(artifact, ["format", "network", "rootId", "predecessorId", "sequence", "previousDigest", "block", "successor", "proofs", "headers"]);
  const rootId = options.rootId ?? checkpointId(options.predecessor);
  if (artifact.format !== "orynq-midnight-checkpoint-advance/v1" || artifact.network !== options.expectedNetwork || !["mainnet", "preprod"].includes(options.expectedNetwork) || !hash32(rootId) || artifact.rootId !== rootId || artifact.predecessorId !== checkpointId(options.predecessor) || !Number.isSafeInteger(artifact.sequence) || Number(artifact.sequence) < 1 || artifact.sequence !== options.expectedSequence || artifact.previousDigest !== options.previousDigest || (artifact.sequence === 1 ? artifact.previousDigest !== null || artifact.rootId !== artifact.predecessorId : !hash32(artifact.previousDigest))) throw new Error("Checkpoint advancement continuity differs");
  exact(artifact.block, ["height", "hash"]);
  if (!Number.isSafeInteger(artifact.block.height) || Number(artifact.block.height) <= options.predecessor.startsAfter.height || !hash32(artifact.block.hash)) throw new Error("Invalid checkpoint advancement target");
  const block = { height: Number(artifact.block.height), hash: artifact.block.hash };
  const successor = checkpointFromJson(artifact.successor);
  if (successor.setId <= options.predecessor.setId || successor.startsAfter.height <= options.predecessor.startsAfter.height || successor.startsAfter.height >= block.height) throw new Error("Checkpoint advancement must move forward");
  if (!Array.isArray(artifact.proofs) || !Array.isArray(artifact.headers) || artifact.proofs.length > 8192 || artifact.headers.length > 131072) throw new Error("Checkpoint advancement transcript exceeds its entry budget");
  const proofs = new Map<number, Uint8Array | null>();
  for (const row of artifact.proofs) {
    if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0]) || row[0] < 1 || proofs.has(row[0]) || (row[1] !== null && (typeof row[1] !== "string" || !/^(?:[a-f0-9]{2})+$/.test(row[1])))) throw new Error("Invalid checkpoint proof transcript");
    proofs.set(row[0], row[1] === null ? null : unhex(row[1]));
  }
  const headers = new Map<string, RpcHeader>();
  for (const row of artifact.headers) {
    if (!Array.isArray(row) || row.length !== 2 || !hash32(row[0]) || headers.has(row[0])) throw new Error("Invalid checkpoint header transcript");
    headers.set(row[0], structuredClone(row[1]));
  }
  const rpc: FinalityRpc = {
    async proveFinality(heights) { return heights.map(height => { if (!proofs.has(height)) throw new Error("Checkpoint proof transcript is incomplete"); return proofs.get(height)!; }); },
    async headers(hashes) { return hashes.map(hash => { const header = headers.get(hash.replace(/^0x/, "")); if (!header) throw new Error("Checkpoint header transcript is incomplete"); return structuredClone(header); }); },
  };
  const result = await verifyFinality({ rpc, block, checkpoints: [structuredClone(options.predecessor)], maxSetChanges: DEFAULT_MAX_SET_CHANGES });
  if (!result.finalized || checkpointId(result.checkpoint) !== checkpointId(successor)) throw new Error("Checkpoint advancement is not authenticated by its predecessor");
  return { checkpoint: result.checkpoint, digest: checkpointAdvanceId(artifact as unknown as CheckpointAdvance), block, sequence: Number(artifact.sequence), setChanges: result.setChanges };
}

export async function deriveCheckpointAdvance(options: {
  network: MidnightNetwork; predecessor: FinalityCheckpoint; rpc: FinalityRpc; block: BlockRef;
  sequence?: number; previousDigest?: string | null; rootId?: string;
}): Promise<CheckpointAdvance> {
  const proofs = new Map<number, string | null>(), headers = new Map<string, RpcHeader>();
  let retainedBytes = 2;
  const retain = <K, V>(map: Map<K, V>, key: K, value: V) => {
    if (map.has(key) && JSON.stringify(map.get(key)) !== JSON.stringify(value)) throw new Error("Checkpoint source changed a retained proof response");
    if (!map.has(key)) retainedBytes += encodedBytes([key, value]).length + 1;
    if (retainedBytes > MAX_BYTES || proofs.size > 8192 || headers.size > 131072) throw new Error("Checkpoint advancement transcript exceeds its budget");
    map.set(key, value);
  };
  const rpc: FinalityRpc = {
    async proveFinality(heights) { const result = await options.rpc.proveFinality(heights); if (result.length !== heights.length) throw new Error("Checkpoint proof response count differs"); result.forEach((value, i) => retain(proofs, heights[i]!, value === null ? null : hex(value))); return result; },
    async headers(hashes) { const result = await options.rpc.headers(hashes); if (result.length !== hashes.length) throw new Error("Checkpoint header response count differs"); result.forEach((value, i) => retain(headers, hashes[i]!.replace(/^0x/, ""), structuredClone(value))); return result; },
  };
  const result = await verifyFinality({ rpc, block: options.block, checkpoints: [structuredClone(options.predecessor)], maxSetChanges: DEFAULT_MAX_SET_CHANGES });
  if (!result.finalized) throw new Error("Checkpoint advancement target is not authenticated");
  const artifact: CheckpointAdvance = { format: "orynq-midnight-checkpoint-advance/v1", network: options.network, rootId: options.rootId ?? checkpointId(options.predecessor), predecessorId: checkpointId(options.predecessor), sequence: options.sequence ?? 1, previousDigest: options.previousDigest ?? null, block: { ...options.block }, successor: checkpointToJson(result.checkpoint), proofs: [...proofs], headers: [...headers] };
  await verifyCheckpointAdvance({ artifact, predecessor: options.predecessor, expectedNetwork: options.network, expectedSequence: artifact.sequence, previousDigest: artifact.previousDigest, rootId: artifact.rootId });
  return artifact;
}
