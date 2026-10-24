/**
 * @fileoverview End-to-end verification that a Materios receipt is anchored on
 * Cardano in a checkpoint record under metadata label 8746.
 *
 * The checks, in order; the first that fails is the refusal:
 *   input          the claim and options are well formed
 *   leaf           leaf = sha256("materios-checkpoint-v1" ‖ genesis ‖ receipt_id
 *                  ‖ cert_hash), cert_hash rebuilt from the receipt's fields
 *                  when the claim gives them; a claimed leaf list holds it
 *   root           rootFromPath(leaf, index, count, path), which accepts only
 *                  the path a tree of exactly `count` leaves gives that index
 *   anchor_id      anchorId = sha256(root ‖ manifest_hash), manifest_hash being
 *                  the daemon's hash of Python json.dumps(sort_keys=True) of
 *                  the manifest; it must equal a claimed anchor id
 *   tx             the anchor tx, named or found among the pinned wallets' txs
 *                  from a Cardano height, is in a Cardano block
 *   wallet         every input the tx spends belongs to a pinned anchor wallet
 *   record         its label 8746 value decodes, in either encoding, to a
 *                  p "materios", v 2 record
 *   chain          the record's chain is the receipt's Materios genesis
 *   anchored_root  the record's root is the root
 *   leaves         the record's leaf count is `count`
 *   blocks         the record's blocks are the manifest's range, which covers
 *                  the block the receipt was certified in
 *   manifest       the record's manifest is manifest_hash
 *   confirmations  the tx's block is at least `minConfirmations` deep
 *
 * Trust assumptions:
 * - The chain source reports truthfully which block holds the tx and how deep
 *   it is. The Koios source trusts the Koios operator; a Koios you run removes
 *   that trust.
 * - Label 8746 is open to anyone, so the record proves something only because
 *   a pinned anchor wallet funded it. The wallets are the caller's to pin.
 * - The leaf list or Merkle path is off-chain data (the gateway's batch
 *   record). The anchored root makes it unforgeable, not available.
 * - Materios's Anchors storage, which a claimed anchor id comes from, is a
 *   cross-check only: the runtime accepts an anchor from any signed origin and
 *   never checks its id against its root and manifest.
 */
import {
  anchorId,
  certHash,
  checkpointLeaf,
  manifestHash,
  merklePath,
  rootFromPath,
  type CertFormat,
} from "@fluxpointstudios/orynq-sdk-core/checkpoint";
import {
  MATERIOS_ANCHOR_LABEL,
  decodeMateriosAnchorRecord,
  type MateriosAnchorEncoding,
} from "./materios-anchor-v2.js";

/**
 * A Cardano transaction as the Materios checkpoint verifier reads it.
 */
export interface CheckpointTransaction {
  txHash: string;
  /** null while the transaction is in no block. */
  blockHeight: number | null;
  /** Metadata by label, each value as Koios renders it in JSON; null when the tx carries none. */
  metadata: Record<string, unknown> | null;
  /** The bech32 address of every input the transaction spends. */
  inputAddresses: string[];
}

/**
 * The Cardano reads the verifier makes. `createKoiosCheckpointSource` reads
 * them from Koios; any other indexer can stand in.
 */
export interface MateriosCheckpointSource {
  /** The transactions among `txHashes` that the chain has; unknown hashes are left out. */
  transactions(txHashes: readonly string[]): Promise<CheckpointTransaction[]>;
  /** The block height of the chain tip. */
  tipHeight(): Promise<number>;
  /** Every transaction touching `address` in a block at or above `fromBlockHeight`. */
  addressTransactions(address: string, fromBlockHeight: number): Promise<string[]>;
}

export type MateriosCheckpointCheck =
  | "input"
  | "leaf"
  | "root"
  | "anchor_id"
  | "tx"
  | "wallet"
  | "record"
  | "chain"
  | "anchored_root"
  | "leaves"
  | "blocks"
  | "manifest"
  | "confirmations";

/** What the caller holds about a certified receipt and the batch that anchors it. */
export interface MateriosCheckpointClaim {
  /** Genesis hash of the Materios chain the receipt is on. */
  genesis: string;
  receiptId: string;
  /** The receipt's availability_cert_hash. Give this or `cert`. */
  certHash?: string;
  /**
   * The receipt fields its availability Cert is rebuilt from, which binds the
   * leaf to the receipt's content hash. Give this or `certHash`.
   */
  cert?: { certFormat: CertFormat; contentHash: string; baseRootSha256: string; storageLocatorHash: string };
  /** The Materios block of the receipt's first AvailabilityCertified event. */
  certifiedBlock: number;
  /** The batch's leaf hashes in order, or the leaf's index, the batch's leaf count and the Merkle path. */
  inclusion: { leafHashes: readonly string[] } | { index: number; count: number; path: readonly string[] };
  /**
   * The manifest fields the rest of the claim does not fix: the batch's
   * Materios block range, and the cert-daemon's CARDANO_NETWORK_ID, which is
   * "" (the default) on the live path.
   */
  manifest: { fromBlock: number; toBlock: number; cardanoNetworkId?: string };
  /** An anchor id to cross-check, as Materios's Anchors storage or the gateway's batch record holds it. */
  anchorId?: string;
  /** The anchor tx, or the Cardano block height from which to scan the pinned wallets for it. */
  cardano: { txHash: string } | { scanFromBlockHeight: number };
}

export interface MateriosCheckpointOptions {
  source: MateriosCheckpointSource;
  /** Bech32 addresses of the wallets that fund genuine anchor txs. */
  anchorWallets: readonly string[];
  /**
   * Confirmations the tx's block needs, counting that block as one. The
   * default 15 is a depth Cardano mainnet has never rolled back; 2160, the
   * security parameter k, is the depth no rollback can reach.
   */
  minConfirmations?: number;
}

export interface MateriosCheckpointVerification {
  verified: boolean;
  /** The check that refused, and why; null when verified. */
  refusal: { check: MateriosCheckpointCheck; reason: string } | null;
  /** The checks run, in order, ending with the one that refused, if any. */
  checks: { name: MateriosCheckpointCheck; ok: boolean; detail: string }[];
  certHash: string | null;
  leaf: string | null;
  rootHash: string | null;
  manifestHash: string | null;
  anchorId: string | null;
  txHash: string | null;
  encoding: MateriosAnchorEncoding | null;
  blockHeight: number | null;
  confirmations: number | null;
}

type Check = MateriosCheckpointVerification["checks"][number];

const SETTLED_CONFIRMATIONS = 15;
const LABEL = String(MATERIOS_ANCHOR_LABEL);

class Refusal extends Error {
  constructor(readonly check: MateriosCheckpointCheck, readonly reason: string) {
    super(reason);
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const bare = (hash: string) => hash.replace(/^0x/, "");

function hash32(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(value)) throw new Refusal("input", `${name} is not a 32-byte hex hash`);
  return bare(value).toLowerCase();
}

function object<T extends object>(value: T | undefined, name: string): T {
  if (typeof value !== "object" || value === null) throw new Refusal("input", `${name} is not an object`);
  return value;
}

function count(value: unknown, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Refusal("input", `${name} is not an integer of at least ${minimum}`);
  return value as number;
}

interface Input {
  genesis: string;
  receiptId: string;
  cert: string;
  certifiedBlock: number;
  leafHashes: string[] | null;
  path: { index: number; count: number; path: string[] } | null;
  fromBlock: number;
  toBlock: number;
  cardanoNetworkId: string;
  claimedAnchorId: string | null;
  txHash: string | null;
  scanFromBlockHeight: number | null;
  wallets: Set<string>;
  minConfirmations: number;
}

function parseInput(claim: MateriosCheckpointClaim, options: MateriosCheckpointOptions): Input {
  const genesis = hash32(claim.genesis, "genesis");
  const receiptId = hash32(claim.receiptId, "receiptId");
  if ((claim.certHash === undefined) === (claim.cert === undefined)) throw new Refusal("input", "the claim must give exactly one of certHash and cert");
  let cert: string;
  if (claim.cert === undefined) cert = hash32(claim.certHash, "certHash");
  else {
    try {
      cert = bare(certHash(claim.cert.certFormat, genesis, receiptId, claim.cert));
    } catch (error) {
      throw new Refusal("input", `cert: ${message(error)}`);
    }
  }
  const inclusion = object(claim.inclusion, "inclusion");
  const manifest = object(claim.manifest, "manifest");
  const cardano = object(claim.cardano, "cardano");
  let leafHashes: string[] | null = null;
  let path: Input["path"] = null;
  if ("leafHashes" in inclusion) {
    if (!Array.isArray(inclusion.leafHashes) || inclusion.leafHashes.length === 0) throw new Refusal("input", "inclusion.leafHashes lists no leaf");
    leafHashes = inclusion.leafHashes.map((leaf, i) => hash32(leaf, `inclusion.leafHashes[${i}]`));
  } else {
    const leaves = count(inclusion.count, "inclusion.count", 1);
    const index = count(inclusion.index, "inclusion.index", 0);
    if (index >= leaves) throw new Refusal("input", `inclusion.index ${index} is not below inclusion.count ${leaves}`);
    if (!Array.isArray(inclusion.path)) throw new Refusal("input", "inclusion.path is not a list");
    path = { index, count: leaves, path: inclusion.path.map((node, i) => hash32(node, `inclusion.path[${i}]`)) };
  }
  const fromBlock = count(manifest.fromBlock, "manifest.fromBlock", 0);
  const toBlock = count(manifest.toBlock, "manifest.toBlock", 0);
  if (fromBlock > toBlock) throw new Refusal("input", `manifest.fromBlock ${fromBlock} is after manifest.toBlock ${toBlock}`);
  const cardanoNetworkId = manifest.cardanoNetworkId ?? "";
  if (typeof cardanoNetworkId !== "string") throw new Refusal("input", "manifest.cardanoNetworkId is not a string");
  const wallets = options.anchorWallets;
  if (!Array.isArray(wallets) || wallets.length === 0 || !wallets.every((w) => typeof w === "string" && w.length > 0)) {
    throw new Refusal("input", "anchorWallets pins no wallet");
  }
  return {
    genesis,
    receiptId,
    cert,
    certifiedBlock: count(claim.certifiedBlock, "certifiedBlock", 0),
    leafHashes,
    path,
    fromBlock,
    toBlock,
    cardanoNetworkId,
    claimedAnchorId: claim.anchorId === undefined ? null : hash32(claim.anchorId, "anchorId"),
    txHash: "txHash" in cardano ? hash32(cardano.txHash, "cardano.txHash") : null,
    scanFromBlockHeight: "txHash" in cardano ? null : count(cardano.scanFromBlockHeight, "cardano.scanFromBlockHeight", 0),
    wallets: new Set(wallets),
    minConfirmations: count(options.minConfirmations ?? SETTLED_CONFIRMATIONS, "minConfirmations", 1),
  };
}

interface Commitment {
  leaf: string;
  root: string;
  count: number;
  manifestHash: string;
  anchorId: string;
}

/** The leaf, root, manifest hash and anchor id the claim commits to, each a check. */
function commitment(input: Input, pass: (name: MateriosCheckpointCheck, detail: string) => void): Commitment {
  const leaf = checkpointLeaf(input.genesis, input.receiptId, input.cert);
  let shape: { index: number; count: number; path: string[] };
  if (input.leafHashes) {
    const index = input.leafHashes.indexOf(bare(leaf));
    if (index < 0) throw new Refusal("leaf", `the receipt's leaf ${leaf} is not among the ${input.leafHashes.length} leaf hashes`);
    shape = { index, count: input.leafHashes.length, path: merklePath(input.leafHashes, index) };
    pass("leaf", `the receipt's leaf ${leaf} is leaf ${index} of ${shape.count}`);
  } else {
    shape = input.path!;
    pass("leaf", `the receipt's leaf is ${leaf}`);
  }
  let root: string;
  try {
    root = rootFromPath(leaf, shape.index, shape.count, shape.path);
  } catch (error) {
    throw new Refusal("root", `the path is not leaf ${shape.index}'s in a tree of ${shape.count} leaves: ${message(error)}`);
  }
  pass("root", `root ${root} of ${shape.count} leaves`);
  const hash = manifestHash({
    cardano_network_id: input.cardanoNetworkId,
    count: shape.count,
    from_block: input.fromBlock,
    materios_chain_id: input.genesis,
    root: bare(root),
    to_block: input.toBlock,
  });
  const id = anchorId(root, hash);
  if (input.claimedAnchorId !== null && input.claimedAnchorId !== bare(id)) {
    throw new Refusal("anchor_id", `the claimed anchor id 0x${input.claimedAnchorId} is not ${id}, sha256(root ‖ manifest ${hash})`);
  }
  pass("anchor_id", `${id} = sha256(root ‖ manifest ${hash})${input.claimedAnchorId === null ? "" : ", as claimed"}`);
  return { leaf, root, count: shape.count, manifestHash: hash, anchorId: id };
}

/** The txs that may anchor the claim: the named one, or the pinned wallets' txs whose record names the root. */
async function anchorCandidates(input: Input, claimed: Commitment, source: MateriosCheckpointSource): Promise<CheckpointTransaction[]> {
  if (input.txHash !== null) {
    const found = (await source.transactions([input.txHash])).filter((tx) => tx.txHash.toLowerCase() === input.txHash);
    if (found.length === 0) throw new Refusal("tx", `Cardano has no transaction ${input.txHash}`);
    return found;
  }
  const from = input.scanFromBlockHeight!;
  const listed = await Promise.all([...input.wallets].map((wallet) => source.addressTransactions(wallet, from)));
  const anchoring = (await source.transactions([...new Set(listed.flat())])).filter((tx) => {
    const decoded = decodeMateriosAnchorRecord(tx.metadata?.[LABEL]);
    return decoded.ok && decoded.record.root === bare(claimed.root);
  });
  if (anchoring.length === 0) {
    throw new Refusal("tx", `no transaction of a pinned wallet in Cardano blocks from ${from} anchors root ${claimed.root}`);
  }
  return anchoring.sort((a, b) => (a.blockHeight ?? Infinity) - (b.blockHeight ?? Infinity));
}

interface Anchoring {
  /** The checks passed, up to the refusal if there is one. */
  checks: Check[];
  refusal: Refusal | null;
  encoding: MateriosAnchorEncoding | null;
  confirmations: number | null;
}

async function checkAnchoring(tx: CheckpointTransaction, input: Input, claimed: Commitment, source: MateriosCheckpointSource): Promise<Anchoring> {
  const out: Anchoring = { checks: [], refusal: null, encoding: null, confirmations: null };
  const pass = (name: MateriosCheckpointCheck, detail: string) => out.checks.push({ name, ok: true, detail });
  const check = (name: MateriosCheckpointCheck, ok: boolean, detail: string, refusal: string) => {
    if (!ok) throw new Refusal(name, refusal);
    pass(name, detail);
  };
  try {
    const height = tx.blockHeight;
    if (height === null) throw new Refusal("tx", `transaction ${tx.txHash} is in no Cardano block yet`);
    pass("tx", `transaction ${tx.txHash} is in Cardano block ${height}`);

    if (tx.inputAddresses.length === 0) throw new Refusal("wallet", "the transaction spends no input");
    const foreign = [...new Set(tx.inputAddresses.filter((address) => !input.wallets.has(address)))];
    check("wallet", foreign.length === 0, `funded by ${[...new Set(tx.inputAddresses)].join(", ")}`, `the transaction spends inputs of ${foreign.join(", ")}, which no pinned anchor wallet is`);

    const value = tx.metadata?.[LABEL];
    if (value === undefined) throw new Refusal("record", `the transaction carries no label ${LABEL} metadata`);
    const decoded = decodeMateriosAnchorRecord(value);
    if (!decoded.ok) throw new Refusal("record", `its label ${LABEL} value: ${decoded.reason}`);
    const { record } = decoded;
    out.encoding = decoded.encoding;
    pass("record", `a ${decoded.encoding} p "materios", v 2 record under label ${LABEL}`);

    check("chain", record.chain === input.genesis, `Materios genesis ${record.chain}`, `the record names chain ${record.chain}, not the receipt's ${input.genesis}`);
    check("anchored_root", record.root === bare(claimed.root), `the record anchors root ${record.root}`, `the record anchors root ${record.root}, not ${bare(claimed.root)}`);
    check("leaves", record.leaves === claimed.count, `${record.leaves} leaves`, `the record anchors ${record.leaves} leaves, not ${claimed.count}`);
    const [from, to] = record.blocks;
    if (from !== input.fromBlock || to !== input.toBlock) {
      throw new Refusal("blocks", `the record covers Materios blocks ${from}-${to}, not the manifest's ${input.fromBlock}-${input.toBlock}`);
    }
    check("blocks", input.certifiedBlock >= from && input.certifiedBlock <= to, `Materios blocks ${from}-${to}, which hold the certification in block ${input.certifiedBlock}`, `Materios blocks ${from}-${to} do not hold the certification in block ${input.certifiedBlock}`);
    check("manifest", record.manifest === bare(claimed.manifestHash), `manifest ${record.manifest}`, `the record anchors manifest ${record.manifest}, not ${bare(claimed.manifestHash)}`);

    out.confirmations = (await source.tipHeight()) - height + 1;
    check("confirmations", out.confirmations >= input.minConfirmations, `${out.confirmations} confirmations`, `${out.confirmations} confirmations, fewer than the ${input.minConfirmations} required`);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    out.refusal = error;
  }
  return out;
}

/**
 * Verify that a certified Materios receipt is in a checkpoint batch whose root
 * and manifest a pinned anchor wallet wrote to Cardano under label 8746. See
 * the file overview for the checks and the trust they rest on.
 *
 * Every failed check is a refusal in the result; an error the chain source
 * throws propagates.
 *
 * @example
 * ```typescript
 * const result = await verifyMateriosCheckpointAnchor(
 *   {
 *     genesis, receiptId, certHash, certifiedBlock,
 *     inclusion: { leafHashes: batch.leafHashes },
 *     manifest: { fromBlock: batch.blockRangeStart, toBlock: batch.blockRangeEnd },
 *     cardano: { txHash: batch.cardanoTxHash },
 *   },
 *   { source: createKoiosCheckpointSource({ network: "mainnet" }), anchorWallets: [ANCHOR_WALLET] },
 * );
 * if (!result.verified) console.log(result.refusal);
 * ```
 */
export async function verifyMateriosCheckpointAnchor(
  claim: MateriosCheckpointClaim,
  options: MateriosCheckpointOptions,
): Promise<MateriosCheckpointVerification> {
  const result: MateriosCheckpointVerification = {
    verified: false, refusal: null, checks: [], certHash: null, leaf: null, rootHash: null,
    manifestHash: null, anchorId: null, txHash: null, encoding: null, blockHeight: null, confirmations: null,
  };
  const pass = (name: MateriosCheckpointCheck, detail: string) => result.checks.push({ name, ok: true, detail });
  try {
    const input = parseInput(claim, options);
    pass("input", `receipt 0x${input.receiptId} on Materios chain ${input.genesis}`);
    result.certHash = `0x${input.cert}`;
    const claimed = commitment(input, pass);
    Object.assign(result, { leaf: claimed.leaf, rootHash: claimed.root, manifestHash: claimed.manifestHash, anchorId: claimed.anchorId });

    let chosen: { tx: CheckpointTransaction; anchoring: Anchoring } | undefined;
    for (const tx of await anchorCandidates(input, claimed, options.source)) {
      const anchoring = await checkAnchoring(tx, input, claimed, options.source);
      if (!chosen || !anchoring.refusal) chosen = { tx, anchoring };
      if (!anchoring.refusal) break;
    }
    const { tx, anchoring } = chosen!;
    Object.assign(result, { txHash: tx.txHash, blockHeight: tx.blockHeight, encoding: anchoring.encoding, confirmations: anchoring.confirmations });
    result.checks.push(...anchoring.checks);
    if (anchoring.refusal) throw anchoring.refusal;
    result.verified = true;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    result.refusal = { check: error.check, reason: error.reason };
    result.checks.push({ name: error.check, ok: false, detail: error.reason });
  }
  return result;
}
