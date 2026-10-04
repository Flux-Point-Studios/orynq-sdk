import * as L from "@midnight-ntwrk/ledger-v8";
import { decodeAnchorTransaction, type AnchorCall, type AnchorTransaction } from "./anchor-transaction.js";
import { entryCommitment, hash32, hiddenDigest, hidingCommitment, type EntryHashes, type Hash32 } from "./commitment.js";
import { verifyFinality, type BlockRef, type FinalityCheckpoint, type FinalityResult } from "./grandpa.js";
import { knownAuthors as shippedKnownAuthors, type AuthorStatus, type KnownAuthors } from "./known-authors.js";
import { KNOWN_RUNTIME_SPEC_VERSIONS, MIDNIGHT_REGISTRIES, assertRegistryGenerations, type MidnightNetwork, type RegistryInfo } from "./registries.js";
import { assertRegistryDeployBytes, assertRegistryState } from "./registry.js";
import { fromHex, toHex } from "./scale.js";
import { finalityRpc, type IndexedTransaction, type MidnightSource } from "./source.js";
import { headerFromRpc, headerHash, includedTransactionIndex, orderedTrieRoot, type RpcHeader } from "./substrate.js";

// Status, most to least severe: a check failed outright (invalid), sources disagree with each
// other or with consensus (conflict), a source could not answer (unavailable), the block is not
// shown final (unverified-finality), the author is not a known one (unauthenticated) or is
// outside its window (author-revoked). valid needs every check to pass at consensus-verified.
export type AnchorStatus = "valid" | "invalid" | "conflict" | "unavailable" | "unverified-finality" | "unauthenticated" | "author-revoked";
const SEVERITY: readonly Exclude<AnchorStatus, "valid">[] = ["invalid", "conflict", "unavailable", "unverified-finality", "unauthenticated", "author-revoked"];

// How far the inclusion of the transaction is established: consensus-verified (its block is
// GRANDPA-final from a trusted checkpoint and holds it as a top-level Midnight transaction),
// multi-path (the indexer and the node agree, finality not shown), single-path (only the
// indexer), none.
export type Assurance = "consensus-verified" | "multi-path" | "single-path" | "none";

export type Expectation =
  | { kind: 1; entry: EntryHashes }
  | { kind: 1; commitment: Hash32 }
  | { kind: 2; attribute: Hash32; opening?: EntryHashes & { salt: Hash32 } };

export interface VerifyRequest {
  network: MidnightNetwork;
  txHash: string;
  expect: Expectation;
  // An author key the caller trusts in place of the KNOWN_AUTHORS document.
  expectedAuthor?: Hash32;
}

export interface VerifyOptions {
  source: MidnightSource;
  registries?: readonly RegistryInfo[];
  knownAuthors?: KnownAuthors;
  // Checkpoints the caller trusts beyond those in the KNOWN_AUTHORS document.
  checkpoints?: readonly FinalityCheckpoint[];
  maxSetChanges?: number;
  finality?: "verify" | "skip";
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyResult {
  status: AnchorStatus;
  assurance: Assurance;
  network: MidnightNetwork;
  txHash: string;
  operators: string[];
  registry: { generation: number; address: string } | null;
  block: BlockRef | null;
  anchor: AnchorCall | null;
  author: ((AuthorStatus | { status: "expected" }) & { key: string }) | null;
  // The fields the anchor's commitment binds that matched the request.
  verifiedFields: string[];
  notes: string[];
  checks: Check[];
  finality: FinalityResult | null;
  knownAuthorsSerial: number;
}

const KIND2_NOTE = "kind 2: the registry circuit binds the attribute to the commitment and never checks it against the trace's model manifest";

class Checks {
  readonly list: Check[] = [];
  private readonly failed = new Set<Exclude<AnchorStatus, "valid">>();
  pass(name: string, detail: string) {
    this.list.push({ name, ok: true, detail });
  }
  fail(name: string, severity: Exclude<AnchorStatus, "valid">, detail: string) {
    this.list.push({ name, ok: false, detail });
    this.failed.add(severity);
  }
  status(): AnchorStatus {
    return SEVERITY.find((s) => this.failed.has(s)) ?? "valid";
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface Included {
  raw: Uint8Array;
  decoded: AnchorTransaction;
  indexed: IndexedTransaction;
  block: BlockRef;
  runtime: number | null;
  assurance: Assurance;
  finality: FinalityResult | null;
}

// Establishes, as far as the sources and the checkpoints allow, that `txHash` is a transaction
// in a block: the indexer's bytes must decode to a transaction with that hash, before anything
// else is asked of them; the node's block at the indexer's height must have the indexer's hash, hash to it
// from its header and commit to its body (so the body is the block's own), run a runtime whose
// extrinsic layout the decoder knows, and hold the transaction as a top-level Midnight
// transaction; GRANDPA must then show the block final. A final block that lacks the
// transaction is checked for finality too: it shows the indexer's claim false.
async function include(
  label: string,
  txHash: string,
  registries: readonly string[],
  source: MidnightSource,
  checks: Checks,
  finality: { checkpoints: readonly FinalityCheckpoint[]; maxSetChanges: number | undefined; skip: boolean },
): Promise<Included | null> {
  let found: IndexedTransaction[];
  try {
    found = (await source.indexer.transactions(txHash)).filter((t) => t.hash === txHash);
  } catch (error) {
    checks.fail(`${label}indexer`, "unavailable", message(error));
    return null;
  }
  if (found.length !== 1) {
    checks.fail(`${label}indexer`, "invalid", found.length === 0 ? `the indexer knows no transaction ${txHash}` : `the indexer lists transaction ${txHash} ${found.length} times`);
    return null;
  }
  const indexed = found[0]!;
  checks.pass(`${label}indexer`, `the indexer places it in block ${indexed.block.height}`);
  const raw = fromHex(indexed.raw, "raw transaction");
  let decoded: AnchorTransaction;
  try {
    decoded = decodeAnchorTransaction(raw, registries);
  } catch (error) {
    checks.fail(`${label}transaction`, "invalid", message(error));
    return null;
  }
  if (decoded.txHash !== txHash) {
    checks.fail(`${label}transaction-hash`, "invalid", `the bytes hash to ${decoded.txHash}, not ${txHash}`);
    return null;
  }
  checks.pass(`${label}transaction-hash`, "the transaction's own bytes hash to the requested hash");
  const out: Included = { raw, decoded, indexed, block: { height: indexed.block.height, hash: indexed.block.hash }, runtime: null, assurance: "single-path", finality: null };
  const { block } = out;

  let included: boolean;
  try {
    const blockHash = (await source.node.call<string>("chain_getBlockHash", [block.height])).replace(/^0x/, "");
    if (blockHash !== block.hash) {
      checks.fail(`${label}node-block`, "conflict", `the node's block ${block.height} is ${blockHash}, the indexer's ${block.hash}`);
      return out;
    }
    checks.pass(`${label}node-block`, `the node agrees block ${block.height} is ${block.hash}`);
    const { block: body } = await source.node.call<{ block: { header: RpcHeader; extrinsics: string[] } }>("chain_getBlock", [`0x${block.hash}`]);
    const header = headerFromRpc(body.header);
    const extrinsics = body.extrinsics.map((e) => fromHex(e, "extrinsic"));
    if (toHex(headerHash(header)) !== block.hash || header.number !== block.height) {
      checks.fail(`${label}node-header`, "conflict", `the node's header does not hash to block ${block.hash}`);
      return out;
    }
    checks.pass(`${label}node-header`, "the header hashes to the block hash");
    if (toHex(orderedTrieRoot(extrinsics)) !== toHex(header.extrinsicsRoot)) {
      checks.fail(`${label}extrinsics-root`, "conflict", "the node's block body does not match its header's extrinsicsRoot");
      return out;
    }
    checks.pass(`${label}extrinsics-root`, `the body's ${extrinsics.length} extrinsics match the header's extrinsicsRoot`);
    out.runtime = (await source.node.call<{ specVersion: number }>("state_getRuntimeVersion", [`0x${block.hash}`])).specVersion;
    if (!(KNOWN_RUNTIME_SPEC_VERSIONS as readonly number[]).includes(out.runtime)) {
      checks.fail(`${label}runtime`, "invalid", `block ${block.height} runs runtime ${out.runtime}, whose extrinsic layout the decoder does not know`);
      return out;
    }
    checks.pass(`${label}runtime`, `the node reports runtime ${out.runtime}, whose extrinsic layout the decoder knows`);
    const index = includedTransactionIndex(extrinsics, out.raw);
    included = index !== null;
    if (index === null) checks.fail(`${label}inclusion`, "conflict", `no extrinsic of block ${block.height} is exactly a bare Midnight.send_mn_transaction of this transaction`);
    else checks.pass(`${label}inclusion`, `extrinsic ${index} of block ${block.height} is Midnight.send_mn_transaction of exactly these bytes`);
  } catch (error) {
    checks.fail(`${label}node`, "unavailable", message(error));
    return out;
  }
  if (included) out.assurance = "multi-path";

  if (finality.skip) {
    checks.fail(`${label}finality`, "unverified-finality", "skipped by the caller");
    return out;
  }
  try {
    out.finality = await verifyFinality({ rpc: finalityRpc(source), block, checkpoints: finality.checkpoints, ...(finality.maxSetChanges === undefined ? {} : { maxSetChanges: finality.maxSetChanges }) });
  } catch (error) {
    checks.fail(`${label}finality`, "unavailable", message(error));
    return out;
  }
  if (!out.finality.finalized) {
    checks.fail(`${label}finality`, "unverified-finality", out.finality.reason);
    return out;
  }
  checks.pass(`${label}finality`, `GRANDPA set ${out.finality.checkpoint.setId} justified block ${out.finality.justified.height} after ${out.finality.setChanges} set changes`);
  if (included) out.assurance = "consensus-verified";
  return out;
}

const stateCheck = (checks: Checks, name: string, stateHex: string | undefined, where: string) => {
  if (stateHex === undefined) return checks.fail(name, "conflict", `${where} reports no state for the registry`);
  try {
    assertRegistryState(L.ContractState.deserialize(fromHex(stateHex, "state")));
    checks.pass(name, `${where} reports the immutable registry state`);
  } catch (error) {
    checks.fail(name, "conflict", `${where}: ${message(error)}`);
  }
};

// The fields a commitment binds that match the request, or why the request does not match.
function expectation(expect: Expectation, anchor: AnchorCall): { fields: string[] } | { error: string } {
  if (!("kind" in expect) || (expect.kind !== 1 && expect.kind !== 2)) return { error: `kind ${String((expect as { kind: unknown }).kind)} is not one the registry writes` };
  if (anchor.kind !== expect.kind) return { error: `the anchor is kind ${anchor.kind}, not kind ${expect.kind}` };
  if (expect.kind === 1) {
    if ("entry" in expect) {
      const want = toHex(entryCommitment(expect.entry));
      return want === anchor.commitment ? { fields: ["rootHash", "manifestHash", "merkleRoot"] } : { error: `the anchor commits to ${anchor.commitment}, not to the entry (${want})` };
    }
    const want = toHex(hash32(expect.commitment, "commitment"));
    return want === anchor.commitment ? { fields: ["commitment"] } : { error: `the anchor commits to ${anchor.commitment}, not ${want}` };
  }
  const attribute = toHex(hash32(expect.attribute, "attribute"));
  if (attribute !== anchor.attribute) return { error: `the anchor's attribute is ${anchor.attribute}, not ${attribute}` };
  if (!expect.opening) return { fields: ["committedAttribute"] };
  const opened = toHex(hidingCommitment(hiddenDigest(expect.opening, attribute), expect.opening.salt));
  return opened === anchor.commitment
    ? { fields: ["committedAttribute", "rootHash", "manifestHash", "merkleRoot"] }
    : { error: `the opening commits to ${opened}, not to the anchor's ${anchor.commitment}` };
}

// Verifies that `request.txHash` is a registry anchor that matches `request.expect`, written by
// a recognized author, in a block GRANDPA shows final. Every step is a named check; the status
// is valid only when all of them pass at consensus-verified assurance.
export async function verifyMidnightAnchor(request: VerifyRequest, options: VerifyOptions): Promise<VerifyResult> {
  const checks = new Checks();
  const txHash = request.txHash.toLowerCase().replace(/^0x/, "");
  const authors = options.knownAuthors ?? shippedKnownAuthors();
  const result: VerifyResult = {
    status: "invalid",
    assurance: "none",
    network: request.network,
    txHash,
    operators: [options.source.operator],
    registry: null,
    block: null,
    anchor: null,
    author: null,
    verifiedFields: [],
    notes: [],
    checks: checks.list,
    finality: null,
    knownAuthorsSerial: authors.serial,
  };
  // valid exists only at consensus-verified assurance, whatever the individual checks say.
  const done = (): VerifyResult => {
    const status = checks.status();
    return { ...result, status: status === "valid" && result.assurance !== "consensus-verified" ? "unverified-finality" : status };
  };

  const registries = options.registries ?? MIDNIGHT_REGISTRIES[request.network];
  try {
    if (registries.length === 0) throw new Error(`no registry generation is deployed on ${request.network}`);
    assertRegistryGenerations(registries);
    checks.pass("registry", `${registries.length} registry generation${registries.length === 1 ? "" : "s"} on ${request.network}`);
  } catch (error) {
    checks.fail("registry", "invalid", message(error));
    return done();
  }
  if (!/^[0-9a-f]{64}$/.test(txHash)) {
    checks.fail("transaction-hash", "invalid", "a transaction hash is 64 hex characters");
    return done();
  }
  const finality = { checkpoints: [...authors.checkpoints(request.network), ...(options.checkpoints ?? [])], maxSetChanges: options.maxSetChanges, skip: options.finality === "skip" };

  const addresses = registries.map((r) => r.address);
  const indexed = await include("", txHash, addresses, options.source, checks, finality);
  if (!indexed) return done();
  result.block = indexed.block;
  result.assurance = indexed.assurance;
  result.finality = indexed.finality;

  let anchor: AnchorCall;
  try {
    const { decoded } = indexed;
    if (decoded.touches.length) throw new Error(`transaction ${txHash} also carries a ${decoded.touches[0]!.action === "deploy" ? "deploy" : "maintenance update"} aimed at registry ${decoded.touches[0]!.address}`);
    if (decoded.calls.length !== 1) throw new Error(decoded.calls.length === 0 ? `transaction ${txHash} writes no anchor to a registry generation` : `transaction ${txHash} writes ${decoded.calls.length} anchors`);
    anchor = decoded.calls[0]!;
    checks.pass("anchor", `${anchor.entryPoint}() wrote kind ${anchor.kind} to registry ${anchor.address}`);
  } catch (error) {
    checks.fail("anchor", "invalid", message(error));
    return done();
  }
  result.anchor = anchor;
  const registry = registries.find((r) => r.address === anchor.address)!;
  result.registry = { generation: registry.generation, address: registry.address };
  if (indexed.runtime !== null && indexed.runtime !== registry.runtimeSpecVersion) {
    checks.fail("registry-runtime", "invalid", `block ${indexed.block.height} runs runtime ${indexed.runtime}, not registry generation ${registry.generation}'s ${registry.runtimeSpecVersion}`);
  }

  if (indexed.indexed.status !== "SUCCESS") checks.fail("indexer-status", "invalid", `the indexer reports ${indexed.indexed.status}`);
  else checks.pass("indexer-status", "the indexer reports SUCCESS");
  stateCheck(checks, "indexer-state", indexed.indexed.contractActions.find((a) => a.address === anchor.address)?.state, "the indexer");
  if (indexed.runtime !== null) {
    try {
      const state = await options.source.node.call<string | null>("midnight_contractState", [anchor.address, `0x${indexed.block.hash}`]);
      stateCheck(checks, "node-state", state === null ? undefined : state.replace(/^0x/, ""), "the node");
    } catch (error) {
      checks.fail("node-state", "unavailable", message(error));
    }
  }

  // The registry is what its pinned deploy created: verify that deploy as this anchor is.
  const deploy = await include("registry-deploy/", registry.deployTxHash, addresses, options.source, checks, finality);
  if (deploy) {
    try {
      const address = assertRegistryDeployBytes(deploy.raw, "final");
      if (address !== registry.address) throw new Error(`it deploys ${address}, not ${registry.address}`);
      if (deploy.block.height !== registry.deployHeight) throw new Error(`it is in block ${deploy.block.height}, not the pinned ${registry.deployHeight}`);
      checks.pass("registry-deploy", `transaction ${registry.deployTxHash} deployed the immutable registry at ${registry.address}`);
    } catch (error) {
      checks.fail("registry-deploy", "invalid", `the registry's pinned deploy ${registry.deployTxHash}: ${message(error)}`);
    }
  }

  const matched = expectation(request.expect, anchor);
  if ("error" in matched) checks.fail("expectation", "invalid", matched.error);
  else {
    result.verifiedFields = matched.fields;
    checks.pass("expectation", `the anchor binds ${matched.fields.join(", ")}`);
  }
  if (anchor.kind === 2) result.notes.push(KIND2_NOTE);

  if (request.expectedAuthor !== undefined) {
    const expected = toHex(hash32(request.expectedAuthor, "expectedAuthor"));
    result.author = { status: "expected", key: anchor.author };
    if (expected === anchor.author) checks.pass("author", "the caller's expected author wrote it");
    else checks.fail("author", "unauthenticated", `written by ${anchor.author}, not the expected ${expected}`);
  } else {
    const status = authors.author(request.network, anchor.author, indexed.block.height);
    result.author = { ...status, key: anchor.author };
    if (status.status === "known") checks.pass("author", `${status.id} (${status.role}) within its window`);
    else if (status.status === "outside-window") checks.fail("author", "author-revoked", `${status.id}'s window is ${status.validFrom} to ${status.validTo ?? "open"}; block ${indexed.block.height} lies outside it`);
    else checks.fail("author", "unauthenticated", `KNOWN_AUTHORS serial ${authors.serial} does not list ${anchor.author}`);
  }
  return done();
}
