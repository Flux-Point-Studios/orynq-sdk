import { blake2b } from "@noble/hashes/blake2.js";
import { ScaleReader, bytesEqual, compactAt, concatBytes, encodeCompact, fromHex, toHex } from "./scale.js";

export const blake2b256 = (bytes: Uint8Array): Uint8Array => blake2b(bytes, { dkLen: 32 });

export interface BlockHeader {
  parentHash: Uint8Array;
  number: number;
  stateRoot: Uint8Array;
  extrinsicsRoot: Uint8Array;
  // Each digest item exactly as SCALE-encoded in the header.
  digest: Uint8Array[];
}

// A header as chain_getHeader and chain_getBlock return it.
export interface RpcHeader {
  parentHash: string;
  number: string;
  stateRoot: string;
  extrinsicsRoot: string;
  digest: { logs: string[] };
}

// sp_runtime::DigestItem: Other(0), Consensus(4), Seal(5), PreRuntime(6) and
// RuntimeEnvironmentUpdated(8). Returns the item's own bytes.
function readDigestItem(r: ScaleReader): Uint8Array {
  const from = r.position;
  const tag = r.u8();
  if (tag === 4 || tag === 5 || tag === 6) {
    r.bytes(4);
    r.vecBytes();
  } else if (tag === 0) {
    r.vecBytes();
  } else if (tag !== 8) {
    throw new Error(`unknown digest item ${tag}`);
  }
  return r.since(from);
}

function digestItem(bytes: Uint8Array): Uint8Array {
  const r = new ScaleReader(bytes, "digest item");
  readDigestItem(r);
  r.end();
  return bytes;
}

const hash32 = (hex: string, what: string) => {
  const b = fromHex(hex, what);
  if (b.length !== 32) throw new Error(`${what} must be 32 bytes`);
  return b;
};

export function headerFromRpc(json: RpcHeader): BlockHeader {
  const number = Number.parseInt(json.number, 16);
  if (!/^0x[0-9a-f]+$/.test(json.number) || !Number.isSafeInteger(number)) throw new Error(`header number ${json.number} is not a hex integer`);
  return {
    parentHash: hash32(json.parentHash, "parentHash"),
    number,
    stateRoot: hash32(json.stateRoot, "stateRoot"),
    extrinsicsRoot: hash32(json.extrinsicsRoot, "extrinsicsRoot"),
    digest: json.digest.logs.map((log) => digestItem(fromHex(log, "digest log"))),
  };
}

export function readHeader(r: ScaleReader): BlockHeader {
  const parentHash = r.bytes(32);
  const number = r.compactNumber();
  const stateRoot = r.bytes(32);
  const extrinsicsRoot = r.bytes(32);
  const digest = r.vec(readDigestItem);
  return { parentHash, number, stateRoot, extrinsicsRoot, digest };
}

export function encodeHeader(h: BlockHeader): Uint8Array {
  return concatBytes(h.parentHash, encodeCompact(h.number), h.stateRoot, h.extrinsicsRoot, encodeCompact(h.digest.length), ...h.digest);
}

export function headerHash(h: BlockHeader): Uint8Array {
  return blake2b256(encodeHeader(h));
}

export interface WeightedAuthority {
  key: string;
  weight: bigint;
}

const FRNK = "FRNK";

// The next GRANDPA authority set a set-change header schedules, with duplicate keys' seats
// summed as finality-grandpa's VoterSet does, or null when the header schedules none. A
// delayed or forced change is refused: both move the point where the next set starts. So is a
// set with no voting weight, which would finalize a justification without one precommit.
export function scheduledAuthorityChange(h: BlockHeader): WeightedAuthority[] | null {
  let next: WeightedAuthority[] | null = null;
  for (const item of h.digest) {
    if (item[0] !== 4 || Buffer.from(item.subarray(1, 5)).toString("latin1") !== FRNK) continue;
    const outer = new ScaleReader(item.subarray(5), "FRNK log");
    const payload = outer.vecBytes();
    outer.end();
    const r = new ScaleReader(payload, "FRNK consensus log");
    const variant = r.u8();
    if (variant === 2) throw new Error(`block ${h.number} carries a forced authority change; refusing to follow it`);
    if (variant !== 1) continue;
    if (next) throw new Error(`block ${h.number} schedules two authority changes`);
    const seats = r.vec((x) => ({ key: toHex(x.bytes(32)), weight: x.u64() }));
    const delay = r.u32();
    r.end();
    if (delay !== 0) throw new Error(`block ${h.number} schedules an authority change with a delay of ${delay} blocks`);
    const byKey = new Map<string, bigint>();
    for (const { key, weight } of seats) byKey.set(key, (byKey.get(key) ?? 0n) + weight);
    next = [...byKey].map(([key, weight]) => ({ key, weight }));
    if (next.every((a) => a.weight === 0n)) throw new Error(`block ${h.number} schedules an authority set with no voting weight`);
  }
  return next;
}

// sp_trie::LayoutV1 node encoding, keyed by SCALE-compact index as frame_system's
// extrinsics_data_root keys a block body. A value of sp-core's TRIE_VALUE_NODE_THRESHOLD (33)
// bytes or more is stored by its hash.
const VALUE_HASH_THRESHOLD = 33;

function nodeHeader(kind: "leaf" | "branch" | "branchWithValue", nibbles: number, hashedValue: boolean): Uint8Array {
  let prefix: number;
  let bits: number;
  if (hashedValue) [prefix, bits] = kind === "leaf" ? [0x20, 3] : [0x10, 4];
  else [prefix, bits] = [kind === "leaf" ? 0x40 : kind === "branch" ? 0x80 : 0xc0, 2];
  const max = 255 >> bits;
  if (nibbles < max) return new Uint8Array([prefix + nibbles]);
  const out = [prefix + max];
  let rest = nibbles - max;
  while (rest >= 255) {
    out.push(255);
    rest -= 255;
  }
  out.push(rest);
  return new Uint8Array(out);
}

const packNibbles = (nibbles: number[]): Uint8Array => {
  const out: number[] = [];
  let i = 0;
  if (nibbles.length % 2) out.push(nibbles[i++]!);
  for (; i < nibbles.length; i += 2) out.push((nibbles[i]! << 4) | nibbles[i + 1]!);
  return new Uint8Array(out);
};

// How a trie node holds a value: [true, its hash] or [false, the value with its length].
export const trieValueEncoding = (v: Uint8Array): [hashed: boolean, encoded: Uint8Array] =>
  v.length >= VALUE_HASH_THRESHOLD ? [true, blake2b256(v)] : [false, concatBytes(encodeCompact(v.length), v)];

interface TrieEntry {
  key: number[];
  value: Uint8Array;
}

function encodeNode(entries: TrieEntry[], depth: number): Uint8Array {
  if (entries.length === 1) {
    const { key, value } = entries[0]!;
    const [hashed, encoded] = trieValueEncoding(value);
    return concatBytes(nodeHeader("leaf", key.length - depth, hashed), packNibbles(key.slice(depth)), encoded);
  }
  let shared = depth;
  while (entries.every((e) => e.key.length > shared && e.key[shared] === entries[0]!.key[shared])) shared++;
  const here = entries.find((e) => e.key.length === shared);
  let bitmap = 0;
  const children: Uint8Array[] = [];
  for (let nibble = 0; nibble < 16; nibble++) {
    const below = entries.filter((e) => e.key.length > shared && e.key[shared] === nibble);
    if (below.length === 0) continue;
    bitmap |= 1 << nibble;
    const child = encodeNode(below, shared + 1);
    const ref = child.length < 32 ? child : blake2b256(child);
    children.push(concatBytes(encodeCompact(ref.length), ref));
  }
  const [hashed, value] = here ? trieValueEncoding(here.value) : [false, new Uint8Array()];
  return concatBytes(
    nodeHeader(here ? "branchWithValue" : "branch", shared - depth, hashed),
    packNibbles(entries[0]!.key.slice(depth, shared)),
    new Uint8Array([bitmap & 0xff, bitmap >> 8]),
    value,
    ...children,
  );
}

export function orderedTrieRoot(values: Uint8Array[]): Uint8Array {
  if (values.length === 0) return blake2b256(new Uint8Array([0]));
  const entries = values
    .map((value, i) => ({ key: [...encodeCompact(i)].flatMap((b) => [b >> 4, b & 15]), value }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return blake2b256(encodeNode(entries, 0));
}

// Runtime 1000300: Midnight is pallet 5 and send_mn_transaction(midnight_tx: Vec<u8>) its call 0.
// Only a bare (unsigned) extrinsic counts: for those the runtime runs the ledger's full
// well_formed check, proofs included, in pre_dispatch, so a block that holds one is invalid
// unless the transaction is. Versions 4 and 5 both encode a bare extrinsic as their version byte.
const MIDNIGHT_PALLET = 5;
const SEND_MN_TRANSACTION = 0;
const BARE_EXTRINSIC_VERSIONS = new Set([4, 5]);

// The transaction an extrinsic carries when it is exactly a bare
// Midnight.send_mn_transaction(tx) with nothing before or after, otherwise null.
export function midnightTransactionIn(extrinsic: Uint8Array): Uint8Array | null {
  const body = compactAt(extrinsic, 0);
  if ("error" in body || BigInt(extrinsic.length - body.next) !== body.value) return null;
  const at = body.next;
  if (!BARE_EXTRINSIC_VERSIONS.has(extrinsic[at]!) || extrinsic[at + 1] !== MIDNIGHT_PALLET || extrinsic[at + 2] !== SEND_MN_TRANSACTION) return null;
  const tx = compactAt(extrinsic, at + 3);
  if ("error" in tx || BigInt(extrinsic.length - tx.next) !== tx.value) return null;
  return extrinsic.subarray(tx.next);
}

// The bare v4 extrinsic Midnight.send_mn_transaction(tx): what author_submitExtrinsic takes, and
// exactly what midnightTransactionIn reads back.
export function midnightExtrinsic(tx: Uint8Array): Uint8Array {
  const call = concatBytes(new Uint8Array([4, MIDNIGHT_PALLET, SEND_MN_TRANSACTION]), encodeCompact(tx.length), tx);
  return concatBytes(encodeCompact(call.length), call);
}

// The index of the one extrinsic in a block body that is exactly the bare
// Midnight.send_mn_transaction(tx), or null when there is none or more than one.
export function includedTransactionIndex(extrinsics: Uint8Array[], tx: Uint8Array): number | null {
  const at = extrinsics.flatMap((e, i) => {
    const carried = midnightTransactionIn(e);
    return carried !== null && bytesEqual(carried, tx) ? [i] : [];
  });
  return at.length === 1 ? at[0]! : null;
}
