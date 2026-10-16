import { ed25519PublicKey, ed25519Sign } from "../ed25519.js";
import { blake2b256, encodeHeader, headerHash, type BlockHeader, type RpcHeader, type WeightedAuthority } from "../substrate.js";
import { compactAt, concatBytes, encodeCompact, toHex, u32le, u64le } from "../scale.js";
import type { FinalityCheckpoint, FinalityRpc } from "../grandpa.js";

// A synthetic GRANDPA chain, generated lazily: set k (counting from `firstSetId`) finalizes the
// blocks after the end of set k-1, and its last block carries an FRNK log naming set k+1.
// Headers link within a set; a set's first header names a stand-in parent, since the verifier
// links headers only between a block and the end of its own set.
export interface ChainSpec {
  firstSetId: bigint;
  genesisEnd: number;
  setLengths: (k: number) => number;
  setCount: number;
  keysFor?: (k: number) => Uint8Array[];
  forcedAt?: number;
  bodies?: Map<number, Uint8Array[]>;
  extrinsicsRootOf?: (height: number) => Uint8Array;
}

const seed = (label: string) => blake2b256(new Uint8Array(Buffer.from(label)));
export const testKeys = (label: string, n: number) => Array.from({ length: n }, (_, i) => seed(`${label}-${i}`));
const DEFAULT_KEYS = testKeys("authority", 4);
const publicKeys = new Map<string, Uint8Array>();
const publicKey = (sk: Uint8Array) => {
  const id = toHex(sk);
  let pk = publicKeys.get(id);
  if (!pk) publicKeys.set(id, (pk = ed25519PublicKey(sk)));
  return pk;
};

// A finality proof with its justification kept byte for byte and its unknown headers replaced.
export function withUnknownHeaders(proof: Uint8Array, headers: BlockHeader[]): Uint8Array {
  const length = compactAt(proof, 32);
  if ("error" in length) throw new Error(length.error);
  const end = length.next + Number(length.value);
  return concatBytes(proof.subarray(0, end), encodeCompact(headers.length), ...headers.map(encodeHeader));
}

export function syntheticChain(spec: ChainSpec) {
  const keysFor = spec.keysFor ?? (() => DEFAULT_KEYS);
  const ends: number[] = [spec.genesisEnd];
  const endOf = (k: number) => {
    while (ends.length <= k + 1) ends.push(ends.at(-1)! + spec.setLengths(ends.length - 1));
    return ends[k + 1]!;
  };
  const setOf = (height: number) => {
    let k = 0;
    while (endOf(k) < height) k++;
    return k;
  };
  const authorities = (k: number): WeightedAuthority[] => keysFor(k).map((sk) => ({ key: toHex(publicKey(sk)), weight: 1n }));
  const frnk = (k: number) => {
    const next = authorities(k + 1);
    const variant = spec.forcedAt === k ? concatBytes(new Uint8Array([2]), u32le(0)) : new Uint8Array([1]);
    const payload = concatBytes(variant, encodeCompact(next.length), ...next.flatMap((a) => [Buffer.from(a.key, "hex"), u64le(a.weight)]), u32le(0));
    return concatBytes(new Uint8Array([4]), new Uint8Array(Buffer.from("FRNK")), encodeCompact(payload.length), payload);
  };
  const segments = new Map<number, BlockHeader[]>();
  const byHashIndex = new Map<string, BlockHeader>();
  const segment = (k: number) => {
    let headers = segments.get(k);
    if (!headers) {
      headers = [];
      let parent = seed(`parent-of-set-${k}`);
      for (let n = endOf(k - 1) + 1; n <= endOf(k); n++) {
        const header: BlockHeader = {
          parentHash: parent,
          number: n,
          stateRoot: seed(`state-${n}`),
          extrinsicsRoot: spec.extrinsicsRootOf?.(n) ?? seed(`extrinsics-${n}`),
          digest: n === endOf(k) && k < spec.setCount - 1 ? [frnk(k)] : [],
        };
        headers.push(header);
        parent = headerHash(header);
        byHashIndex.set(toHex(parent), header);
      }
      segments.set(k, headers);
    }
    return headers;
  };
  const header = (height: number) => {
    const k = setOf(height);
    return segment(k)[height - endOf(k - 1) - 1]!;
  };
  const finalizedHeight = endOf(spec.setCount - 1);

  const justification = (k: number, target: BlockHeader, signers = keysFor(k)) => {
    const hash = headerHash(target);
    const setId = spec.firstSetId + BigInt(k);
    const round = 7n;
    const message = concatBytes(new Uint8Array([1]), hash, u32le(target.number), u64le(round), u64le(setId));
    const quorum = signers.slice(0, signers.length - Math.floor((signers.length - 1) / 3));
    const precommits = quorum.map((sk) => concatBytes(hash, u32le(target.number), ed25519Sign(message, sk), publicKey(sk)));
    return concatBytes(u64le(round), hash, u32le(target.number), encodeCompact(precommits.length), ...precommits, encodeCompact(0));
  };
  const proof = (target: BlockHeader, j: Uint8Array, unknown: BlockHeader[]) =>
    concatBytes(headerHash(target), encodeCompact(j.length), j, encodeCompact(unknown.length), ...unknown.map(encodeHeader));

  // grandpa_proveFinality as Substrate answers it: the justification of the last block of the
  // set that finalized `height`, or of the latest finalized block for the running set, with
  // every header after `height` up to it.
  const proveFinality = (height: number): Uint8Array | null => {
    if (height > finalizedHeight) return null;
    const k = setOf(height);
    const target = header(endOf(k));
    const unknown = Array.from({ length: target.number - height }, (_, i) => header(height + 1 + i));
    return proof(target, justification(k, target), unknown);
  };

  const rpcHeader = (h: BlockHeader): RpcHeader => ({
    parentHash: `0x${toHex(h.parentHash)}`,
    number: `0x${h.number.toString(16)}`,
    stateRoot: `0x${toHex(h.stateRoot)}`,
    extrinsicsRoot: `0x${toHex(h.extrinsicsRoot)}`,
    digest: { logs: h.digest.map((d) => `0x${toHex(d)}`) },
  });
  const byHash = (hash: string) => {
    const found = byHashIndex.get(hash.replace(/^0x/, ""));
    if (!found) throw new Error(`no header ${hash}`);
    return found;
  };

  // Every request, and the time the chain spent answering, so a test can tell the verifier's
  // own cost from the cost of generating the chain it reads.
  const calls: Array<{ method: string; count: number }> = [];
  const timed = <T>(answer: () => T): T => {
    const started = performance.now();
    const out = answer();
    calls.push({ method: "time", count: performance.now() - started });
    return out;
  };
  const rpc: FinalityRpc = {
    async proveFinality(heights) {
      calls.push({ method: "proveFinality", count: heights.length });
      return timed(() => heights.map(proveFinality));
    },
    async headers(hashes) {
      calls.push({ method: "headers", count: hashes.length });
      return timed(() => hashes.map((h) => rpcHeader(byHash(h))));
    },
  };
  const answering = () => ({
    requests: calls.filter((c) => c.method !== "time").length,
    items: calls.filter((c) => c.method !== "time").reduce((n, c) => n + c.count, 0),
    millis: calls.filter((c) => c.method === "time").reduce((n, c) => n + c.count, 0),
  });

  const checkpoint = (k: number): FinalityCheckpoint => {
    const start = k === 0 ? { height: spec.genesisEnd, hash: toHex(seed("genesis-end")) } : { height: endOf(k - 1), hash: toHex(headerHash(header(endOf(k - 1)))) };
    return { setId: spec.firstSetId + BigInt(k), startsAfter: start, authorities: authorities(k) };
  };
  const block = (height: number) => ({ height, hash: toHex(headerHash(header(height))) });

  return { rpc, answering, checkpoint, block, header, byHash, endOf, setOf, justification, proof, rpcHeader, authorities };
}
