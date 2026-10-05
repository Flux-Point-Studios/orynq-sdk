import { ed25519Verify } from "./ed25519.js";
import { ScaleReader, bytesEqual, concatBytes, fromHex, toHex, u32le, u64le } from "./scale.js";
import { headerFromRpc, headerHash, readHeader, scheduledAuthorityChange, type BlockHeader, type RpcHeader, type WeightedAuthority } from "./substrate.js";

export interface BlockRef {
  height: number;
  hash: string;
}

interface Target {
  hash: Uint8Array;
  number: number;
}

export interface GrandpaJustification {
  round: bigint;
  target: Target;
  precommits: Array<{ target: Target; signature: Uint8Array; id: Uint8Array }>;
  ancestries: BlockHeader[];
}

export interface FinalityProof {
  block: Uint8Array;
  justification: GrandpaJustification;
  unknownHeaders: BlockHeader[];
}

const readTarget = (r: ScaleReader): Target => ({ hash: r.bytes(32), number: r.u32() });

export function decodeJustification(bytes: Uint8Array): GrandpaJustification {
  const r = new ScaleReader(bytes, "GRANDPA justification");
  const round = r.u64();
  const target = readTarget(r);
  const precommits = r.vec((x) => ({ target: readTarget(x), signature: x.bytes(64), id: x.bytes(32) }));
  const ancestries = r.vec(readHeader);
  r.end();
  return { round, target, precommits, ancestries };
}

export function decodeFinalityProof(bytes: Uint8Array): FinalityProof {
  const r = new ScaleReader(bytes, "GRANDPA finality proof");
  const block = r.bytes(32);
  const justification = decodeJustification(r.vecBytes());
  const unknownHeaders = r.vec(readHeader);
  r.end();
  return { block, justification, unknownHeaders };
}

export interface AuthoritySet {
  setId: bigint;
  authorities: readonly WeightedAuthority[];
}

// finality-grandpa's VoterSet threshold: total weight minus the most a third can be faulty.
export const supermajority = (total: bigint): bigint => total - (total - 1n) / 3n;

// The block a justification finalizes, when voters of `set` holding a supermajority of its
// weight signed precommits, for this set id and round, for that block or a descendant shown
// by the justification's ancestry headers; otherwise why not. A precommit that is unsigned,
// from a non-voter, a repeat voter, or for a block outside the target's subtree adds no weight.
// The justification's own target is unsigned: a precommit vouches for it only by signing that
// hash at that number, or a descendant whose ancestry headers lead down to it at that number.
export function justifiedTarget(j: GrandpaJustification, set: AuthoritySet): Target | { error: string } {
  const weightOf = new Map(set.authorities.map((a) => [a.key, a.weight]));
  const total = set.authorities.reduce((s, a) => s + a.weight, 0n);
  const ancestry = new Map(j.ancestries.map((h) => [toHex(headerHash(h)), h]));
  const descends = (from: Target): boolean => {
    if (from.number < j.target.number) return false;
    let hash = from.hash;
    for (let n = from.number; n > j.target.number; n--) {
      const header = ancestry.get(toHex(hash));
      if (!header || header.number !== n) return false;
      hash = header.parentHash;
    }
    return bytesEqual(hash, j.target.hash);
  };
  const voted = new Set<string>();
  let weight = 0n;
  for (const p of j.precommits) {
    const id = toHex(p.id);
    const seats = weightOf.get(id);
    if (seats === undefined || voted.has(id)) continue;
    const message = concatBytes(new Uint8Array([1]), p.target.hash, u32le(p.target.number), u64le(j.round), u64le(set.setId));
    if (!ed25519Verify(p.signature, message, p.id) || !descends(p.target)) continue;
    voted.add(id);
    weight += seats;
  }
  if (weight < supermajority(total)) {
    return { error: `the justification for block ${j.target.number} carries ${weight} of ${total} weight under set ${set.setId}; finality needs ${supermajority(total)}` };
  }
  return j.target;
}

// A GRANDPA authority set trusted as the set that finalizes the blocks after `startsAfter`.
export interface FinalityCheckpoint extends AuthoritySet {
  startsAfter: BlockRef;
  authorities: WeightedAuthority[];
}

export interface FinalityRpc {
  // grandpa_proveFinality for each height, in order; null where the node has no proof.
  proveFinality(heights: readonly number[]): Promise<Array<Uint8Array | null>>;
  // chain_getHeader for each block hash, in order.
  headers(hashes: readonly string[]): Promise<RpcHeader[]>;
}

// Six weeks of Midnight's 30-minute GRANDPA sets: about 13 MB fetched in about 80 requests.
export const DEFAULT_MAX_SET_CHANGES = 2016;
const SET_LENGTH = 300;
const BATCH = 64;

export type FinalityResult = { setChanges: number; requests: number } & (
  | { finalized: true; justified: BlockRef; checkpoint: FinalityCheckpoint }
  | { finalized: false; reason: string }
);

const ref = (t: Target): BlockRef => ({ height: t.number, hash: toHex(t.hash) });

function decodeProof(raw: Uint8Array): FinalityProof | { error: string } {
  try {
    return decodeFinalityProof(raw);
  } catch (error) {
    return { error: `the source's finality proof is malformed: ${(error as Error).message}` };
  }
}

// Verifies that `block` is final under GRANDPA, trusting only `checkpoints`: from the nearest
// checkpoint below the block it follows each authority set change (a set-change block
// justified by the outgoing set, whose header names the next set) to the set that finalized
// the block, then checks that set's justification and the header chain down to the block.
// The work is bounded by `maxSetChanges`, never by the chain's age: past the bound the block
// is reported not finalized, with the reason.
export async function verifyFinality({
  rpc,
  block,
  checkpoints,
  maxSetChanges = DEFAULT_MAX_SET_CHANGES,
}: {
  rpc: FinalityRpc;
  block: BlockRef;
  checkpoints: readonly FinalityCheckpoint[];
  maxSetChanges?: number;
}): Promise<FinalityResult> {
  const progress = { setChanges: 0, requests: 0 };
  const notFinal = (reason: string): FinalityResult => ({ finalized: false, reason, ...progress });
  const start = checkpoints.filter((c) => c.startsAfter.height < block.height).sort((a, b) => b.startsAfter.height - a.startsAfter.height)[0];
  if (!start) return notFinal(`no finality checkpoint lies below block ${block.height}`);
  let set: FinalityCheckpoint = { setId: start.setId, startsAfter: start.startsAfter, authorities: start.authorities };
  let setLength = SET_LENGTH;
  let covers = false;
  const blockHash = fromHex(block.hash, "block hash");

  const proofs = async (heights: number[]) => {
    progress.requests++;
    const out = await rpc.proveFinality(heights);
    if (out.length !== heights.length) throw new Error(`the source answered ${out.length} finality proofs for ${heights.length} heights`);
    return out;
  };
  const headers = async (hashes: string[]) => {
    progress.requests++;
    const out = await rpc.headers(hashes);
    if (out.length !== hashes.length) throw new Error(`the source answered ${out.length} headers for ${hashes.length} hashes`);
    return out.map(headerFromRpc);
  };
  // Moves to the set after `end`, the set-change block the current set justified.
  const advance = (end: Target, header: BlockHeader): FinalityResult | null => {
    let next: WeightedAuthority[] | null;
    try {
      next = scheduledAuthorityChange(header);
    } catch (error) {
      return notFinal((error as Error).message);
    }
    if (!next) return notFinal(`set ${set.setId} has not ended: its latest justified block is ${end.number}, below block ${block.height}`);
    if (++progress.setChanges > maxSetChanges) {
      return notFinal(`block ${block.height} lies more than ${maxSetChanges} GRANDPA set changes past the nearest checkpoint (set ${start.setId})`);
    }
    setLength = end.number - set.startsAfter.height;
    set = { setId: set.setId + 1n, startsAfter: ref(end), authorities: next };
    return null;
  };
  // The block's own proof: the current set's justification of a block at or above it, and the
  // headers from there down to it. `otherSet` means the current set did not sign it.
  const proveBlock = (raw: Uint8Array): FinalityResult | { otherSet: string } => {
    const proof = decodeProof(raw);
    if ("error" in proof) return notFinal(proof.error);
    const target = justifiedTarget(proof.justification, set);
    if ("error" in target) return { otherSet: target.error };
    if (target.number < block.height) return notFinal(`the finality proof for block ${block.height} justifies only block ${target.number}`);
    const chain = proof.unknownHeaders;
    if (chain.length !== target.number - block.height) return notFinal(`the finality proof carries ${chain.length} headers between blocks ${block.height} and ${target.number}`);
    let hash = target.hash;
    for (let i = chain.length - 1; i >= 0; i--) {
      const header = chain[i]!;
      if (header.number !== block.height + 1 + i || !bytesEqual(headerHash(header), hash)) {
        return notFinal(`header ${block.height + 1 + i} of the finality proof does not chain to block ${target.number}`);
      }
      hash = header.parentHash;
    }
    if (!bytesEqual(hash, blockHash)) return notFinal(`the finalized chain holds ${toHex(hash)} at height ${block.height}, not ${block.hash}`);
    return { finalized: true, justified: ref(target), checkpoint: set, ...progress };
  };

  for (;;) {
    if (covers || block.height <= set.startsAfter.height + setLength) {
      const [raw] = await proofs([block.height]);
      if (!raw) return notFinal(`the source has no finality proof for block ${block.height}`);
      const outcome = proveBlock(raw);
      if (!("otherSet" in outcome)) return outcome;
      if (covers) return notFinal(`the proof for block ${block.height} does not verify under set ${set.setId}: ${outcome.otherSet}`);
    }

    // Walk set changes, first at the heights where sets of the last length would end; the
    // first proof that is not exactly such an end sends the walk to resync.
    const ends: number[] = [];
    const room = Math.min(BATCH, maxSetChanges - progress.setChanges + 1);
    for (let e = set.startsAfter.height + setLength; e < block.height && ends.length < room; e += setLength) ends.push(e);
    let resync = ends.length === 0;
    if (!resync) {
      const decoded = (await proofs(ends)).map((raw) => (raw ? decodeProof(raw) : null));
      const found = await headers(decoded.flatMap((p) => (p && !("error" in p) ? [toHex(p.block)] : [])));
      for (let i = 0, next = 0; i < ends.length && !resync; i++) {
        const proof = decoded[i];
        if (!proof || "error" in proof) {
          resync = true;
          continue;
        }
        const header = found[next++]!;
        const target = justifiedTarget(proof.justification, set);
        if ("error" in target || target.number !== ends[i] || !bytesEqual(target.hash, proof.block) || header.number !== target.number || !bytesEqual(headerHash(header), target.hash)) {
          resync = true;
          continue;
        }
        const stop = advance(target, header);
        if (stop) return stop;
      }
    }
    if (!resync) continue;

    // The sets did not end where predicted: ask for the end of the current set itself.
    const [raw] = await proofs([set.startsAfter.height + 1]);
    if (!raw) return notFinal(`the source has no finality proof for block ${set.startsAfter.height + 1}`);
    const proof = decodeProof(raw);
    if ("error" in proof) return notFinal(proof.error);
    const target = justifiedTarget(proof.justification, set);
    if ("error" in target) return notFinal(`the end of set ${set.setId} does not verify: ${target.error}`);
    const header = proof.unknownHeaders.at(-1) ?? (await headers([toHex(target.hash)]))[0]!;
    if (header.number !== target.number || !bytesEqual(headerHash(header), target.hash)) return notFinal(`the source's header for block ${target.number} does not hash to its justified hash`);
    if (target.number >= block.height) {
      covers = true;
      continue;
    }
    const stop = advance(target, header);
    if (stop) return stop;
  }
}
