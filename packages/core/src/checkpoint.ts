import { sha256 } from "@noble/hashes/sha256";

export const SNAPSHOT_BUDGET = 1_572_864;
const LIVE_GENESIS = "0e46e33f639a56cc8780fd871d9a15e16d99af248526f907cb560cb40849f7bf";
const LEGACY_GENESIS = "bc0531cb311281565036fb397a376f0e0fa37005589655f97a7924b2729a164c";
const encoder = new TextEncoder();

export interface CertFormat {
  format: "scale-v1" | "dcbor-v1";
  chainId: string | null;
}

export interface ReceiptRecord {
  schemaHash: string;
  contentHash: string;
  baseRootSha256: string;
  zkRootPoseidon: string | null;
  poseidonParamsHash: string | null;
  baseManifestHash: string;
  safetyManifestHash: string;
  monitorConfigHash: string;
  attestationEvidenceHash: string;
  storageLocatorHash: string;
  availabilityCertHash: string;
  createdAtMillis: bigint;
  submitter: string;
}

interface CertFields {
  contentHash: string;
  baseRootSha256: string;
  storageLocatorHash: string;
}

export interface CheckpointMember extends CertFields {
  receiptId: string;
  certFormat: CertFormat;
}

export interface CheckpointBatch {
  genesis: string;
  finalizedHeight: number;
  receipts: CheckpointMember[];
  leafHashes: string[];
  rootHash: string;
  manifest: {
    cardano_network_id: string;
    count: number;
    from_block: number;
    materios_chain_id: string;
    root: string;
    to_block: number;
  };
  manifestHash: string;
  anchorId: string;
}

function bareHash(value: string): string {
  if (typeof value !== "string" || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(value)) throw new Error("Invalid 32-byte hash");
  return value.replace(/^0x/, "").toLowerCase();
}

function bytes(value: string): Uint8Array {
  return Uint8Array.from(bareHash(value).match(/../g)!, (byte) => Number.parseInt(byte, 16));
}

function hex(value: Uint8Array): string {
  return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function digest(value: Uint8Array): string { return hex(sha256(value)); }
function pair(left: string, right: string): string { return digest(concat(bytes(left), bytes(right))); }

function nextLayer(layer: string[]): string[] {
  const next: string[] = [];
  for (let i = 0; i < layer.length; i += 2) next.push(pair(layer[i]!, layer[i + 1] ?? layer[i]!));
  return next;
}

export function merkleRoot(leaves: readonly string[]): string {
  let layer = leaves.map((leaf) => `0x${bareHash(leaf)}`);
  if (!layer.length) return `0x${"00".repeat(32)}`;
  while (layer.length > 1) layer = nextLayer(layer);
  return layer[0]!;
}

function checkIndex(index: number, count: number): void {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid leaf count");
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new Error("Invalid leaf index");
}

export function merklePath(leaves: readonly string[], index: number): string[] {
  checkIndex(index, leaves.length);
  let layer = leaves.map((leaf) => `0x${bareHash(leaf)}`);
  const path: string[] = [];
  while (layer.length > 1) {
    path.push(layer[index % 2 ? index - 1 : index + 1] ?? layer[index]!);
    layer = nextLayer(layer);
    index = Math.floor(index / 2);
  }
  return path;
}

export function merkleInclusionProof(leaves: readonly string[], index: number): { siblings: { hash: string; position: "L" | "R" }[] } {
  return { siblings: merklePath(leaves, index).map((hash, depth) => ({ hash, position: Math.floor(index / 2 ** depth) % 2 ? "L" : "R" })) };
}

export function verifyMerkleProof(leaf: string, proof: { siblings: readonly { hash: string; position: "L" | "R" }[] }, root: string): boolean {
  let current = `0x${bareHash(leaf)}`;
  for (const sibling of proof.siblings) current = sibling.position === "L" ? pair(sibling.hash, current) : pair(current, sibling.hash);
  return current === `0x${bareHash(root)}`;
}

export function rootFromPath(leaf: string, index: number, count: number, path: readonly string[]): string {
  checkIndex(index, count);
  let current = `0x${bareHash(leaf)}`;
  let depth = 0;
  while (count > 1) {
    if (depth >= path.length) throw new Error("Merkle path too short");
    const sibling = `0x${bareHash(path[depth++]!)}`;
    if (index === count - 1 && count % 2 === 1 && sibling !== current) throw new Error("Odd-node sibling must duplicate the node");
    current = index % 2 ? pair(sibling, current) : pair(current, sibling);
    index = Math.floor(index / 2);
    count = Math.ceil(count / 2);
  }
  if (depth !== path.length) throw new Error("Merkle path too long");
  return current;
}

export function decodeReceiptRecord(raw: Uint8Array): ReceiptRecord {
  let offset = 0;
  function take(size: number): Uint8Array {
    if (offset + size > raw.length) throw new Error("Truncated receipt record");
    const result = raw.subarray(offset, offset + size); offset += size; return result;
  }
  const hash = () => hex(take(32));
  function option(): string | null {
    const tag = take(1)[0];
    if (tag === 0) return null;
    if (tag === 1) return hash();
    throw new Error("Invalid receipt Option tag");
  }
  const record: ReceiptRecord = {
    schemaHash: hash(), contentHash: hash(), baseRootSha256: hash(),
    zkRootPoseidon: option(), poseidonParamsHash: option(),
    baseManifestHash: hash(), safetyManifestHash: hash(), monitorConfigHash: hash(),
    attestationEvidenceHash: hash(), storageLocatorHash: hash(), availabilityCertHash: hash(),
    createdAtMillis: 0n, submitter: "",
  };
  const time = take(8);
  record.createdAtMillis = new DataView(time.buffer, time.byteOffset, 8).getBigUint64(0, true);
  record.submitter = hash();
  if (offset !== raw.length) throw new Error("Trailing receipt bytes");
  return record;
}

export function encodeCert(format: CertFormat, genesis: string, receiptId: string, record: CertFields): Uint8Array {
  const fields = [bytes(record.contentHash), bytes(record.baseRootSha256), bytes(record.storageLocatorHash)];
  if (format.format === "scale-v1" && format.chainId === null) {
    return concat(encoder.encode("materios-availability-cert-v1"), new Uint8Array(3), bytes(genesis), bytes(receiptId), ...fields,
      Uint8Array.of(0, 0, 0, 0, 109, 1, 0, 0, 2, 1));
  }
  if (format.format !== "dcbor-v1" || bareHash(genesis) !== LIVE_GENESIS || format.chainId === null || ![LIVE_GENESIS, LEGACY_GENESIS].includes(bareHash(format.chainId))) {
    throw new Error("Unsupported certificate format or chain genesis");
  }
  function text(value: string): Uint8Array {
    const data = encoder.encode(value);
    return concat(data.length < 24 ? Uint8Array.of(0x60 + data.length) : Uint8Array.of(0x78, data.length), data);
  }
  return concat(Uint8Array.of(0x8a), text("materios-availability-cert-v1"), text(bareHash(format.chainId)), text(`0x${bareHash(receiptId)}`),
    ...fields.map((field) => concat(Uint8Array.of(0x58, 32), field)), Uint8Array.of(0, 0x19, 1, 109, 2), text("1.0"));
}

export function certHash(format: CertFormat, genesis: string, receiptId: string, record: CertFields): string {
  return digest(encodeCert(format, genesis, receiptId, record));
}

export function certFormatOf(record: CertFields & { availabilityCertHash: string }, genesis: string, receiptId: string): CertFormat | null {
  const expected = bareHash(record.availabilityCertHash);
  const formats: CertFormat[] = [{ format: "scale-v1", chainId: null }];
  if (bareHash(genesis) === LIVE_GENESIS) formats.push(...[LIVE_GENESIS, LEGACY_GENESIS].map((chainId): CertFormat => ({ format: "dcbor-v1", chainId })));
  return formats.find((format) => bareHash(certHash(format, genesis, receiptId, record)) === expected) ?? null;
}

export function checkpointLeaf(genesis: string, receiptId: string, certificateHash: string): string {
  return digest(concat(encoder.encode("materios-checkpoint-v1"), bytes(genesis), bytes(receiptId), bytes(certificateHash)));
}

export function anchorId(rootHash: string, manifestHash: string): string { return digest(concat(bytes(rootHash), bytes(manifestHash))); }

export function manifestHash(manifest: CheckpointBatch["manifest"]): string {
  // The daemon hashes Python json.dumps(sort_keys=True), including its separators.
  const json = `{${Object.keys(manifest).sort().map((key) => `${JSON.stringify(key)}: ${JSON.stringify(manifest[key as keyof typeof manifest])}`).join(", ")}}`;
  return digest(encoder.encode(json.replace(/[\u0080-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)));
}

function batchFromMembers(genesis: string, finalizedHeight: number, receipts: CheckpointMember[]): CheckpointBatch {
  genesis = bareHash(genesis);
  if (!Number.isSafeInteger(finalizedHeight) || finalizedHeight < 0) throw new Error("Invalid finalized height");
  if (receipts.length < 1 || receipts.length > 4096) throw new Error("Receipt count must be 1..4096");
  if (new Set(receipts.map((r) => bareHash(r.receiptId))).size !== receipts.length) throw new Error("Duplicate receipt id");
  const leafHashes = receipts.map((r) => checkpointLeaf(genesis, r.receiptId, certHash(r.certFormat, genesis, r.receiptId, r)));
  const rootHash = merkleRoot(leafHashes);
  const manifest = { cardano_network_id: "", count: receipts.length, from_block: finalizedHeight, materios_chain_id: genesis, root: bareHash(rootHash), to_block: finalizedHeight };
  const hash = manifestHash(manifest);
  return { genesis, finalizedHeight, receipts, leafHashes, rootHash, manifest, manifestHash: hash, anchorId: anchorId(rootHash, hash) };
}

export function censusBatch(input: { genesis: string; finalizedHeight: number; receipts: (ReceiptRecord & { receiptId: string })[] }): CheckpointBatch {
  if (input.receipts.length < 1 || input.receipts.length > 4096) throw new Error("Receipt count must be 1..4096");
  const sorted = [...input.receipts].sort((a, b) => {
    if (a.createdAtMillis !== b.createdAtMillis) return a.createdAtMillis < b.createdAtMillis ? -1 : 1;
    const left = bareHash(a.receiptId), right = bareHash(b.receiptId);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const members = sorted.map((r) => {
    const certFormat = certFormatOf(r, input.genesis, r.receiptId);
    if (!certFormat) throw new Error("Receipt certificate hash does not match an allowed format");
    return { receiptId: bareHash(r.receiptId), contentHash: bareHash(r.contentHash), baseRootSha256: bareHash(r.baseRootSha256), storageLocatorHash: bareHash(r.storageLocatorHash), certFormat };
  });
  return batchFromMembers(input.genesis, input.finalizedHeight, members);
}

export function memberSnapshot(batch: CheckpointBatch): string {
  const receipts = batch.receipts.map((r) => [r.receiptId, r.contentHash, r.baseRootSha256, r.storageLocatorHash, r.certFormat.format === "scale-v1" ? 0 : r.certFormat.chainId === LIVE_GENESIS ? 1 : 2]);
  const result = JSON.stringify({ genesis: batch.genesis, finalizedHeight: batch.finalizedHeight, receipts });
  if (encoder.encode(result).length > SNAPSHOT_BUDGET) throw new Error("Member snapshot exceeds size budget");
  return result;
}

export function parseMemberSnapshot(snapshot: string): CheckpointBatch {
  if (snapshot.length > SNAPSHOT_BUDGET || encoder.encode(snapshot).length > SNAPSHOT_BUDGET) throw new Error("Member snapshot exceeds size budget");
  const value = JSON.parse(snapshot);
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "finalizedHeight,genesis,receipts") throw new Error("Invalid member snapshot fields");
  if (!Array.isArray(value.receipts) || value.receipts.length < 1 || value.receipts.length > 4096) throw new Error("Receipt count must be 1..4096");
  const receipts = value.receipts.map((tuple: unknown): CheckpointMember => {
    if (!Array.isArray(tuple) || tuple.length !== 5) throw new Error("Invalid member tuple fields");
    if (![0, 1, 2].includes(tuple[4])) throw new Error("Unknown certificate format code");
    return { receiptId: bareHash(tuple[0]), contentHash: bareHash(tuple[1]), baseRootSha256: bareHash(tuple[2]), storageLocatorHash: bareHash(tuple[3]), certFormat: tuple[4] === 0 ? { format: "scale-v1", chainId: null } : { format: "dcbor-v1", chainId: tuple[4] === 1 ? LIVE_GENESIS : LEGACY_GENESIS } };
  });
  return batchFromMembers(value.genesis, value.finalizedHeight, receipts);
}
