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

// The set's total weight, or why it can finalize nothing: with no weight its supermajority is 0,
// so a justification without one precommit would finalize any block, and a negative weight
// shrinks the total a supermajority is measured against.
function votingWeight(set: AuthoritySet): bigint | { error: string } {
  if (set.authorities.some((a) => a.weight < 0n)) return { error: `set ${set.setId} gives an authority a negative weight` };
  const total = set.authorities.reduce((s, a) => s + a.weight, 0n);
  return total > 0n ? total : { error: `set ${set.setId} has no voting weight, so it finalizes nothing` };
}

// The block a justification finalizes, when voters of `set` holding a supermajority of its
// weight vouch for it; otherwise why not. Of each voter only the first two different precommits
// are read, as finality-grandpa imports no more, and only those signed for this set id and round.
// The justification's own target is unsigned: a voter vouches for it by a precommit for that hash
// at that number, or for a descendant whose ancestry headers lead down to it one block at a time.
//
// A voter with two such precommits equivocated. finality-grandpa counts an equivocator's weight
// for every block of the round's vote graph: the blocks from the round's base, the commit's lowest
// precommit, up to a voter's precommit; validate_commit refuses a commit holding a precommit that
// is not the base or its descendant. So an equivocator vouches here when the lowest signed
// precommit on the target's chain is, or through the ancestry headers is an ancestor of, both its
// precommits, and some voter vouched for the target directly. Where finality-grandpa refuses the
// whole commit, this sets the stray precommit aside instead: an equivocator with one precommit off
// that base vouches only as its other precommit does. GRANDPA signs neither a chain nor its
// genesis, so what a key signed on another chain with the same set id and round verifies here too;
// such a pair shares a base only where the two chains share that block.
//
// The work is linear in the justification, whatever the source sends: non-voters and repeated
// precommits are skipped by a lookup, at most two precommits per voter are verified, and each
// ancestry header is hashed once and walked at most once.
export function justifiedTarget(j: GrandpaJustification, set: AuthoritySet): Target | { error: string } {
  const total = votingWeight(set);
  if (typeof total !== "bigint") return total;
  // finality-grandpa's voter set leaves out an authority with no weight.
  const weightOf = new Map(set.authorities.filter((a) => a.weight > 0n).map((a) => [a.key, a.weight]));
  const ancestry = new Map(j.ancestries.map((h) => [toHex(headerHash(h)), h]));
  const headerAt = (hash: string, number: number) => {
    const header = ancestry.get(hash);
    return header?.number === number ? header : undefined;
  };
  // The target's chain: the hash at each height from the target down through its ancestry headers.
  const chain = new Map<number, string>();
  let link: string | undefined = toHex(j.target.hash);
  for (let n = j.target.number; link !== undefined; n--) {
    chain.set(n, link);
    const header = headerAt(link, n);
    link = header && toHex(header.parentHash);
  }
  // The height at which a block joins the target's chain, walking down its ancestry headers one
  // block at a time, or -1 if it never does. Each header walked is remembered, so walked once.
  const joined = new Map<string, number>();
  const join = (from: Target): number => {
    const walked: string[] = [];
    let hash = toHex(from.hash);
    let n = from.number;
    let found: number | undefined;
    while (found === undefined) {
      const header = headerAt(hash, n);
      if (chain.get(n) === hash) found = n;
      else if (!header) found = -1;
      else if ((found = joined.get(hash)) === undefined) {
        walked.push(hash);
        hash = toHex(header.parentHash);
        n--;
      }
    }
    for (const k of walked) joined.set(k, found);
    return found;
  };
  // Each voter's first two different precommits, and whether each one's signature verified.
  const votes = new Map<string, Array<{ target: Target; signed: boolean }>>();
  for (const p of j.precommits) {
    const id = toHex(p.id);
    if (!weightOf.has(id)) continue;
    const earlier = votes.get(id) ?? [];
    if (earlier.length === 2 || earlier.some((e) => e.target.number === p.target.number && bytesEqual(e.target.hash, p.target.hash))) continue;
    const message = concatBytes(new Uint8Array([1]), p.target.hash, u32le(p.target.number), u64le(j.round), u64le(set.setId));
    votes.set(id, [...earlier, { target: p.target, signed: ed25519Verify(p.signature, message, p.id) }]);
  }
  const voters = [...votes].map(([id, tried]) => ({
    seats: weightOf.get(id)!,
    signed: tried.filter((t) => t.signed).map((t) => ({ number: t.target.number, joins: join(t.target) })),
  }));
  // finality-grandpa's round base is the commit's lowest precommit; here, the lowest signed one
  // on the target's chain.
  const base = voters.flatMap((v) => v.signed).reduce((low, p) => (p.joins === p.number ? Math.min(low, p.number) : low), Infinity);
  let direct = 0n;
  let equivocated = 0n;
  for (const { seats, signed } of voters) {
    if (signed.some((p) => p.joins === j.target.number)) direct += seats;
    else if (signed.length === 2 && signed.every((p) => p.joins >= base)) equivocated += seats;
  }
  const weight = direct > 0n ? direct + equivocated : 0n;
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
// checkpoint below the block it follows each authority set change (a set-change block after the
// set's start, justified by the outgoing set, whose header names the next set) to the set that
// finalized the block, then checks that set's justification and the header chain down to the
// block. The work is bounded by `maxSetChanges`, never by the chain's age: past the bound the
// block is reported not finalized, with the reason.
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
  const usable = votingWeight(start);
  if (typeof usable !== "bigint") return notFinal(usable.error);
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
  // Moves to the set after `end`, the set-change block the current set justified. A justification
  // can name any ancestor of the blocks its precommits signed, and a set's voters sign no block
  // past its last, so its last block is the one block after its start that schedules a change.
  const advance = (end: Target, header: BlockHeader): FinalityResult | null => {
    if (end.number <= set.startsAfter.height) {
      return notFinal(`the end of set ${set.setId} is justified at block ${end.number}, not after its start ${set.startsAfter.height}`);
    }
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
