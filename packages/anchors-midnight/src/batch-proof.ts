import { anchorId, certHash, checkpointLeaf, manifestHash, rootFromPath, type CertFormat } from "@fluxpointstudios/orynq-sdk-core/checkpoint";
import { batchSetCommitment, hash32, type Hash32 } from "./commitment.js";
import { checkpointId } from "./checkpoints.js";
import { MIDNIGHT_REGISTRIES, type MidnightNetwork } from "./registries.js";
import { authorStatusAt, knownAuthors } from "./known-authors.js";
import type { MidnightSource } from "./source.js";
import { toHex } from "./scale.js";
import { verifyMidnightAnchor, type AnchorStatus, type VerifyOptions, type VerifyResult } from "./verify.js";

export const BATCH_PROOF_FORMAT = "orynq-midnight-batch-proof/v1";

export interface BatchSetFacts {
  authorKey: string;
  blockHeight: number;
  blockHash: string;
  checkpointId: string;
  knownAuthorsSerial: number;
}

type Failure = { status: Exclude<AnchorStatus, "valid">; reason: string; anchor?: VerifyResult };
export type BatchSetResult = { status: "valid"; anchor: VerifyResult; facts: BatchSetFacts } | Failure;
export type BatchProofResult = ({ status: "valid"; anchor: VerifyResult; facts: BatchSetFacts; anchorId: string; receiptId: string; certificateHash: string; rootHash: string }) | Failure;

function object(value: unknown, fields: readonly string[], at: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${at} must be an object`);
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) throw new Error(`${at} has missing or unknown fields`);
  return value as Record<string, unknown>;
}

function hash(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length !== 64 || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${at} must be a canonical 32-byte hash`);
  return value;
}

function integer(value: unknown, at: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) throw new Error(`${at} must be a bounded nonnegative integer`);
  return value as number;
}

function network(value: unknown): MidnightNetwork {
  if (value !== "mainnet" && value !== "preprod") throw new Error("Unknown Midnight network");
  return value;
}

function parseSet(value: unknown) {
  const set = object(value, ["network", "materiosGenesis", "commitment", "anchorIds", "midnight"], "batch set");
  const midnight = object(set.midnight, ["registry", "txHash", "blockHeight", "blockHash"], "midnight");
  if (!Array.isArray(set.anchorIds) || set.anchorIds.length < 1 || set.anchorIds.length > 1024) throw new Error("Batch set must contain 1..1024 anchor ids");
  return {
    network: network(set.network), materiosGenesis: hash(set.materiosGenesis, "materiosGenesis"), commitment: hash(set.commitment, "commitment"),
    anchorIds: set.anchorIds.map((id) => hash(id, "anchorId")),
    midnight: { registry: hash(midnight.registry, "registry"), txHash: hash(midnight.txHash, "txHash"), blockHeight: integer(midnight.blockHeight, "blockHeight"), blockHash: hash(midnight.blockHash, "blockHash") },
  };
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function verifyBatchSet(value: unknown, options: VerifyOptions): Promise<BatchSetResult> {
  try {
    const set = parseSet(value);
    if (toHex(batchSetCommitment(set)) !== set.commitment) throw new Error("Batch set commitment does not match its members");
    const anchor = await verifyMidnightAnchor({ network: set.network, txHash: set.midnight.txHash, expect: { kind: 3, commitment: set.commitment } }, options);
    if (anchor.status !== "valid") return { status: anchor.status, reason: anchor.checks.filter((check) => !check.ok).map((check) => check.name).join(", ") || anchor.status, anchor };
    if (anchor.registry?.address !== set.midnight.registry) return { status: "invalid", reason: "Registry differs from the proof", anchor };
    if (anchor.block?.height !== set.midnight.blockHeight || anchor.block.hash !== set.midnight.blockHash) return { status: "conflict", reason: "Block differs from the proof hint", anchor };
    if (anchor.assurance !== "consensus-verified" || !anchor.finality?.finalized || !anchor.anchor) return { status: "unverified-finality", reason: "Batch set lacks consensus finality", anchor };
    return { status: "valid", anchor, facts: { authorKey: anchor.anchor.author, blockHeight: anchor.block.height, blockHash: anchor.block.hash, checkpointId: checkpointId(anchor.finality.checkpoint), knownAuthorsSerial: anchor.knownAuthorsSerial } };
  } catch (error) {
    return { status: "invalid", reason: message(error) };
  }
}

export type BatchProofOptions = VerifyOptions & { setCache?: BatchSetCache };

export async function verifyBatchProof(request: { proof: unknown; network: MidnightNetwork; materiosGenesis: Hash32; contentHash: Hash32 }, options: BatchProofOptions): Promise<BatchProofResult> {
  try {
    const proof = object(request.proof, ["format", "network", "materiosGenesis", "receipt", "batch", "set", "midnight"], "proof");
    if (proof.format !== BATCH_PROOF_FORMAT) throw new Error("Unknown batch proof format");
    if (network(proof.network) !== request.network) throw new Error("Proof network differs from the requested network");
    const genesis = hash(proof.materiosGenesis, "materiosGenesis");
    if (genesis !== toHex(hash32(request.materiosGenesis, "expected materiosGenesis"))) throw new Error("Proof genesis differs from the requested chain");
    const receipt = object(proof.receipt, ["receiptId", "contentHash", "baseRootSha256", "storageLocatorHash", "certFormat", "certChainId"], "receipt");
    const receiptId = hash(receipt.receiptId, "receiptId");
    const fields = { contentHash: hash(receipt.contentHash, "contentHash"), baseRootSha256: hash(receipt.baseRootSha256, "baseRootSha256"), storageLocatorHash: hash(receipt.storageLocatorHash, "storageLocatorHash") };
    if (fields.contentHash !== toHex(hash32(request.contentHash, "expected contentHash"))) throw new Error("Receipt content differs from the requested content hash");
    if (receipt.certFormat !== "scale-v1" && receipt.certFormat !== "dcbor-v1") throw new Error("Unknown certificate format");
    const format: CertFormat = { format: receipt.certFormat, chainId: receipt.certChainId === null ? null : hash(receipt.certChainId, "certChainId") };
    const certificateHash = certHash(format, genesis, receiptId, fields);
    const leaf = checkpointLeaf(genesis, receiptId, certificateHash);
    const batch = object(proof.batch, ["index", "count", "path", "rootHash", "manifest"], "batch");
    const count = integer(batch.count, "count", 4096);
    if (count < 1) throw new Error("Batch count must be positive");
    if (!Array.isArray(batch.path) || batch.path.length > 12) throw new Error("Merkle path exceeds the batch depth");
    const rootHash = hash(batch.rootHash, "rootHash");
    if (rootFromPath(leaf, integer(batch.index, "index", count - 1), count, batch.path.map((node) => hash(node, "path node"))) !== `0x${rootHash}`) throw new Error("Receipt path does not produce the batch root");
    const manifest = object(batch.manifest, ["cardano_network_id", "count", "from_block", "materios_chain_id", "root", "to_block"], "manifest");
    const height = integer(manifest.from_block, "from_block");
    if (manifest.cardano_network_id !== "" || manifest.count !== count || manifest.to_block !== height || manifest.materios_chain_id !== genesis || manifest.root !== rootHash) throw new Error("Manifest does not describe this census batch");
    const id = anchorId(rootHash, manifestHash({ cardano_network_id: "", count, from_block: height, materios_chain_id: genesis, root: rootHash, to_block: height })).slice(2);
    const members = object(proof.set, ["commitment", "anchorIds"], "set");
    const set = parseSet({ network: request.network, materiosGenesis: genesis, ...members, midnight: proof.midnight });
    if (!set.anchorIds.includes(id)) throw new Error("Batch is not a member of the committed set");
    const result = await (options.setCache ? options.setCache.verify(set, options) : verifyBatchSet(set, options));
    if (result.status !== "valid") return result;
    return { ...result, anchorId: id, receiptId, certificateHash: certificateHash.slice(2), rootHash };
  } catch (error) {
    return { status: "invalid", reason: message(error) };
  }
}

export class BatchSetCache {
  private readonly identities = new WeakMap<object, number>();
  private nextIdentity = 1;
  private readonly sources = new WeakMap<MidnightSource, Map<string, Extract<BatchSetResult, { status: "valid" }>>>();
  constructor(private readonly capacity = 128) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096) throw new Error("Cache capacity must be 1..4096");
  }

  private identity(value: object | undefined): number {
    if (value === undefined) return 0;
    let identity = this.identities.get(value);
    if (identity === undefined) { identity = this.nextIdentity++; this.identities.set(value, identity); }
    return identity;
  }

  async verify(value: unknown, options: VerifyOptions): Promise<BatchSetResult> {
    try {
      if (options.maxSetChanges !== undefined && (!Number.isSafeInteger(options.maxSetChanges) || options.maxSetChanges < 0)) throw new Error("Finality budget must be a nonnegative safe integer");
      const set = parseSet(value);
      const authors = options.knownAuthors ?? knownAuthors();
      const source = options.source;
      const sourcePolicy = [source.network ?? null, source.operator, ...[source.node, source.indexer, source.node.call, source.node.batch, source.indexer.transactions, source.verifyExecution].map((value) => this.identity(value))];
      const policy = JSON.stringify({ set, sourcePolicy, registries: options.registries ?? MIDNIGHT_REGISTRIES[set.network],
        checkpoints: [...authors.checkpoints(set.network), ...(options.checkpoints ?? [])].map(checkpointId),
        maxSetChanges: options.maxSetChanges ?? null, finality: options.finality ?? "verify" });
      let entries = this.sources.get(options.source);
      if (!entries) { entries = new Map(); this.sources.set(options.source, entries); }
      const cached = entries.get(policy);
      if (cached) {
        const author = authorStatusAt(authors, set.network, cached.facts.authorKey, cached.facts.blockHeight);
        if (author.status === "outside-window") return { status: "author-revoked", reason: "The current author window excludes the anchored block" };
        if (author.status !== "known" || author.role !== "batch") return { status: "unauthenticated", reason: "The current author document does not authorize this batch author" };
        const result = structuredClone(cached);
        result.facts.knownAuthorsSerial = authors.serial;
        result.anchor.knownAuthorsSerial = authors.serial;
        result.anchor.author = { ...author, key: result.facts.authorKey };
        for (const check of result.anchor.checks) {
          if (check.name === "author") check.detail = `${author.id} (${author.role}) within its window`;
        }
        return result;
      }
      const result = await verifyBatchSet(set, options);
      if (result.status === "valid") {
        if (entries.size >= this.capacity) entries.delete(entries.keys().next().value!);
        entries.set(policy, structuredClone(result));
      }
      return result;
    } catch (error) {
      return { status: "invalid", reason: message(error) };
    }
  }
}
