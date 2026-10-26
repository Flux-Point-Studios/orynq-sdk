// What a script imports as the submit package (../src/index.js) when a test runs it offline: the
// submit package itself, with its wallet, prover and endpoints replaced, over a chain that lives
// in the JSON file OFFLINE_CHAIN so it outlasts each process, and whose node, midnight-node 2.1.0
// as Blockfrost serves it, refuses bytes whose TTL the chain has passed. The rehearsal's run.ts
// also imports it as ./endpoints.js. OFFLINE_FAULT, a comma-separated list, breaks steps of a
// run: "refuse-broadcast" (a proxy answers the broadcast with HTTP 403), "refuse-anchor" (the node
// refuses every transaction that deploys nothing with Custom error: 170, InvalidDustSpendProof),
// "lose-read" (the first read of a landed transaction fails), "lose-sync" (the wallet stops
// syncing once a deploy landed), "fail-save" (the shielded state does not serialize, as
// ledger-v8 8.1.3 once trapped on preprod), "fail-close" (closing the wallet throws), "low-dust"
// (the wallet holds 0.5 DUST), "stall-sync" (the wallet's sync does not finish in time), "unfinal"
// (the node's finalized head stays below every landed transaction), "foreign-block" (the node's
// block of the landed transactions carries none of them), "lose-body" (the node answers for no
// block's body) or "fork" (the node's block at their heights is another than the indexer's). A
// test reorganizes the chain by moving a landed transaction to another block, or dropping it.
// The FPS mainnet keys an operator loads are the ones the chain file pins, a test's throwaway
// keys, when it pins any.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as L from "@midnight-ntwrk/ledger-v8";
import { decodeAnchorTransaction, midnightSource, type IndexedTransaction, type MidnightNetwork, type SourceEndpoints, type VerifyResult } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { ledgerNode } from "../../anchors-midnight/src/__tests__/ledger-node.js";
import { MAINNET_AUTHOR_KEYS, MAINNET_SALT_KEY_IDS } from "../src/custody.js";
import { NETWORK_IDENTITY, type OperatorWallet, type StateSave, type WalletOptions } from "../src/index.js";
import { costParametersOf } from "../src/wallet.js";
import { prover } from "./prover.js";
import { offlineBlocks, offlineHeight, offlineRpcHeader } from "./offline-blocks.js";
import { registryOperator as realRegistryOperator, type OperatorOptions, type PreparedAnchor, type AnchorReceipt } from "../src/operator.js";
import { verifyConfirmedAnchor as realVerifyConfirmedAnchor } from "../src/confirmed-anchor.js";

export * from "../src/index.js";

export interface OfflineChain {
  // The network whose chain name and genesis the node reports.
  network: MidnightNetwork;
  // How far time has moved past the host's clock, for the chain and for the process alike.
  aheadMs: number;
  viewHead?: number;
  viewAheadMs?: number;
  blockTimes?: Record<string, number>;
  // Every transaction handed to the node, in order, whether or not it landed.
  sent: string[];
  // Each landed transaction, in block BLOCK unless `block` names another, and for a deploy the
  // contract's address and initial state; a contract a test deployed before its run carries no
  // bytes (raw "").
  landed: Record<string, { raw: string; height: number; block?: string; address?: string; state?: string }>;
  // Every transaction whose DUST the wallet was asked to release.
  discarded: string[];
  // Set while the node lacks the indexer's newest block, as a node behind the indexer does.
  nodeLags?: boolean;
  // How many times a run closed its wallet, and saved its sync state.
  walletCloses?: number;
  walletSaves?: number;
  // The state file each run opened its wallet with, and how long each waited for its sync.
  walletOpens?: { stateFile: string | null }[];
  syncWaits?: number[];
  // The FPS mainnet keys this mainnet pins in the place of the real ones: its test's throwaway
  // author key and salt key id. Without them the real ones are pinned.
  fpsKeys?: { authorKeys: string[]; saltKeyIds: string[] };
}

const FILE = process.env.OFFLINE_CHAIN!;
const FAULTS = new Set(process.env.OFFLINE_FAULT?.split(","));
const read = (): OfflineChain => JSON.parse(readFileSync(FILE, "utf8"));
// Written whole under this process's own name and renamed over the file, so neither this process
// nor the test's, which both read the file at any moment, ever reads it half written.
const write = (chain: OfflineChain) => {
  writeFileSync(`${FILE}.${process.pid}`, JSON.stringify(chain));
  renameSync(`${FILE}.${process.pid}`, FILE);
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
let readsToLose = FAULTS.has("lose-read") ? 1 : 0;
let finalityClockAdvanced = false;

// The process reads the chain's clock as its own, as a host whose clock is right does: a deployer
// stamps its TTLs from Date.now, so a clock left behind the chain's would stamp bytes the chain
// already refuses.
const hostNow = Date.now;
Date.now = () => hostNow() + read().aheadMs;

const pinned = read().fpsKeys;
if (pinned) {
  (MAINNET_AUTHOR_KEYS as string[]).splice(0, MAINNET_AUTHOR_KEYS.length, ...pinned.authorKeys);
  (MAINNET_SALT_KEY_IDS as string[]).splice(0, MAINNET_SALT_KEY_IDS.length, ...pinned.saltKeyIds);
}

// Clocks advance only by adding a new finalized block. A transaction is included strictly after
// the pre-send boundary; existing block bodies/timestamps remain immutable across process restarts.
function view() {
  const chain = read();
  let changed = !chain.blockTimes || chain.viewHead === undefined;
  chain.blockTimes ??= {};
  let tip = offlineHeight(chain);
  if (chain.viewAheadMs !== undefined && chain.viewAheadMs !== chain.aheadMs) { tip++; changed = true; }
  if (chain.viewAheadMs !== chain.aheadMs) changed = true;
  for (let height = 499; height <= tip; height++) if (chain.blockTimes[height] === undefined) { chain.blockTimes[height] = Date.now(); changed = true; }
  if (chain.viewHead !== tip) changed = true;
  chain.viewHead = tip; chain.viewAheadMs = chain.aheadMs;
  if (changed) write(chain);
  return chain;
}
function nodeAnswer(method: string, params: unknown[] = []) {
  let chain = view();
  const identity = NETWORK_IDENTITY[chain.network];
  if (method === "system_chain") return { result: identity.chain };
  if (method === "midnight_ledgerVersion") return { result: "8.1.3" };
  if (method === "state_getRuntimeVersion") return { result: { specVersion: 1000300 } };
  if (method === "chain_getFinalizedHead" && FAULTS.has("expire-finality-poll") && chain.sent.length && !finalityClockAdvanced) {
    write({ ...chain, aheadMs: chain.aheadMs + 11 * 60_000 }); finalityClockAdvanced = true; chain = view();
  }
  const blocks = offlineBlocks(chain, FAULTS.has("fork"));
  const tip = FAULTS.has("unfinal") ? 499 : offlineHeight(chain);
  const heightAt = (hash: unknown) => [...blocks].find(([, block]) => `0x${block.hash}` === hash)?.[0];
  if (method === "chain_getBlockHash") {
    if (params[0] === 0) return { result: `0x${identity.genesis}` };
    return { result: chain.nodeLags ? null : (blocks.get(Number(params[0])) ? `0x${blocks.get(Number(params[0]))!.hash}` : null) };
  }
  if (method === "chain_getFinalizedHead") return { result: `0x${blocks.get(tip)!.hash}` };
  if (method === "chain_getHeader") { const height = heightAt(params[0]); return { result: chain.nodeLags || height === undefined ? null : offlineRpcHeader(blocks.get(height)!.header) }; }
  if (method === "chain_getBlock") {
    const height = heightAt(params[0]);
    if (height === undefined || FAULTS.has("lose-body")) return { result: null };
    const block = blocks.get(height)!;
    return { result: { block: { header: offlineRpcHeader(block.header), extrinsics: FAULTS.has("foreign-block") ? [] : block.extrinsics.map(raw => `0x${hex(raw)}`) } } };
  }
  if (method === "state_getStorage") {
    const height = heightAt(params[1]);
    if (height === undefined || chain.nodeLags) return { result: null };
    const now = Buffer.alloc(8); now.writeBigUInt64LE(BigInt(chain.blockTimes![height]!));
    return { result: `0x${now.toString("hex")}` };
  }
  if (method === "midnight_zswapStateRoot" || method === "midnight_contractState") {
    const at = heightAt(method === "midnight_contractState" ? params[1] : params[0]);
    const ledger = ledgerNode({ blocks: [...blocks.values()].map(block => block.hash), contracts: address => Object.values(chain.landed).find(tx => tx.address === address && tx.height <= (at ?? offlineHeight(chain)))?.state });
    return ledger.answer(method, params);
  }
  return { error: { code: -32000, message: `offline node: unexpected ${method}` } };
}

const indexer = {
  async transactions(hash: string): Promise<IndexedTransaction[]> {
    const chain = view();
    const t = chain.landed[hash];
    if (!t) return [];
    if (readsToLose > 0) {
      readsToLose--;
      throw new Error("offline indexer: HTTP 502: Bad Gateway");
    }
    const actions = t.address === undefined ? [] : [{ kind: "ContractDeploy" as const, address: t.address, state: t.state! }];
    return [{ hash, raw: t.raw, block: { height: t.height, hash: offlineBlocks(chain).get(t.height)!.hash, timestamp: chain.blockTimes![t.height]! }, status: "SUCCESS", contractActions: actions }];
  },
  async head() {
    const chain = view(), height = offlineHeight(chain);
    return { height, hash: offlineBlocks(chain).get(height)!.hash, timestamp: chain.blockTimes![height]! };
  },
};

export const WALLET_SYNC: SourceEndpoints = { operator: "offline", indexer: "http://127.0.0.1:9/never", indexerWs: "ws://127.0.0.1:9/never", node: "http://127.0.0.1:9/never", headers: {} };

// Every source reads this chain through midnightSource: fetch answers these two URLs, as the
// indexer's GraphQL and the node's JSON-RPC would, and refuses every other, so nothing leaves the
// process.
const ENDPOINTS: SourceEndpoints = { operator: "offline", indexer: "http://offline.invalid/indexer", indexerWs: "ws://offline.invalid/indexer/ws", node: "http://offline.invalid/node", headers: {} };
export const networkEndpoints = () => ENDPOINTS;
export const source = midnightSource(ENDPOINTS);

const graphqlTransaction = (t: IndexedTransaction) => ({
  __typename: "RegularTransaction",
  hash: t.hash,
  raw: t.raw,
  block: t.block,
  transactionResult: { status: t.status },
  contractActions: t.contractActions.map((a) => ({ __typename: a.kind, address: a.address, state: a.state })),
});

type RpcRequest = { id?: number; method: string; params?: unknown[] };

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body));
  if (String(url) === ENDPOINTS.node) {
    const answer = (r: RpcRequest) => ({ jsonrpc: "2.0", id: r.id, ...nodeAnswer(r.method, r.params) });
    return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
  }
  if (String(url) !== ENDPOINTS.indexer) throw new Error(`offline: nothing answers ${String(url)}`);
  const request = body as { query: string; variables?: { hash: string } };
  try {
    if (request.query.startsWith("query Head")) return Response.json({ data: { block: await indexer.head() } });
    if (request.query.startsWith("query Transactions")) return Response.json({ data: { transactions: (await indexer.transactions(request.variables!.hash)).map(graphqlTransaction) } });
  } catch (error) {
    // An HTTP failure of the offline indexer reaches midnightSource as that HTTP answer.
    const [, status, text] = /HTTP (\d+): (.*)$/.exec((error as Error).message) ?? [];
    if (status === undefined) throw error;
    return new Response(text, { status: Number(status) });
  }
  throw new Error(`offline indexer: unexpected query ${request.query}`);
};

export const provingService = () => prover;

// A synced wallet with DUST to spare that binds without adding a fee and lands what it submits.
// It takes only the fee parameters the real wallet takes, and like it saves on close only once synced.
export async function openWallet(options: WalletOptions): Promise<OperatorWallet> {
  costParametersOf(options.costParameters);
  const opened = read();
  write({ ...opened, walletOpens: [...(opened.walletOpens ?? []), { stateFile: options.stateFile ?? null }] });
  const stalls = FAULTS.has("stall-sync");
  const saveState = async (): Promise<StateSave> => {
    const chain = read();
    write({ ...chain, walletSaves: (chain.walletSaves ?? 0) + 1 });
    return FAULTS.has("fail-save") ? { saved: false, failures: [{ part: "shielded", error: "ParseError: Could not serialize local state: RuntimeError: unreachable" }] } : { saved: true };
  };
  const at = (applied: bigint) => ({ applied, highest: 9n, connected: true });
  return {
    network: options.network,
    addresses: options.expectedAddresses!,
    async waitForSync(timeoutMs = 600_000) {
      const chain = read();
      write({ ...chain, syncWaits: [...(chain.syncWaits ?? []), timeoutMs] });
      if (stalls) throw new Error(`the ${options.network} wallet did not sync within ${timeoutMs / 1000} s`);
    },
    async progress() {
      return { shielded: at(stalls ? 5n : 9n), unshielded: at(9n), dust: at(9n), synced: !stalls };
    },
    saveState,
    async balances() {
      if (FAULTS.has("lose-sync") && Object.keys(read().landed).length > 0) throw new Error(`the ${options.network} wallet did not sync within 600 s`);
      return { night: 10n ** 9n, dust: FAULTS.has("dust-0.4") ? 4n * 10n ** 14n : FAULTS.has("low-dust") ? 5n * 10n ** 14n : 10n ** 16n, nightUtxos: 1, registeredNightUtxos: 1 };
    },
    async registerNightForDust() {
      return null;
    },
    async payFee(tx) {
      return tx.bind();
    },
    async submit(tx) {
      const chain = view();
      chain.sent.push(tx.transactionHash());
      write(chain);
      if (FAULTS.has("refuse-broadcast")) throw new Error("offline node: HTTP 403: Forbidden");
      if ([...tx.intents!.values()].some((intent) => intent.ttl.getTime() < Date.now())) {
        throw new Error('offline node: author_submitExtrinsic failed: {"code":1010,"message":"Invalid Transaction","data":"the TTL is behind the chain\'s time"}');
      }
      const deploy = [...tx.intents!.values()].flatMap((intent) => intent.actions).find((a): a is L.ContractDeploy => a instanceof L.ContractDeploy);
      if (!deploy && FAULTS.has("refuse-anchor")) {
        throw new Error('offline node: author_submitExtrinsic failed: {"code":1010,"message":"Invalid Transaction","data":"Custom error: 170"}');
      }
      chain.landed[tx.transactionHash()] = {
        raw: hex(tx.serialize()),
        height: offlineHeight(chain) + 1,
        ...(deploy ? { address: String(deploy.address), state: hex(deploy.initialState.serialize()) } : {}),
      };
      chain.viewHead = chain.landed[tx.transactionHash()]!.height;
      chain.blockTimes![chain.viewHead] = Date.now();
      write(chain);
    },
    async discard(tx) {
      const chain = read();
      chain.discarded.push(tx.transactionHash());
      write(chain);
    },
    async close() {
      const chain = read();
      write({ ...chain, walletCloses: (chain.walletCloses ?? 0) + 1 });
      if (FAULTS.has("fail-close")) throw new Error("offline wallet: the facade did not stop");
      return stalls ? null : saveState();
    },
  };
}

// This fixture is an explicitly synthetic chain. Its verifier seam still exercises the real
// operator's complete exact-field gate and the CLI's cached verification path.
function syntheticVerifier(registry: string): NonNullable<OperatorOptions["verifyLanded"]> {
  return async (request, { source }) => {
    const [transaction] = await source.indexer.transactions(request.txHash);
    if (!transaction) throw new Error("offline verifier cannot find the exact transaction");
    const [anchor] = decodeAnchorTransaction(Buffer.from(transaction.raw.replace(/^0x/, ""), "hex"), [registry]).calls;
    if (!anchor) throw new Error("offline verifier cannot find the exact anchor");
    return {
      status: FAULTS.has("consensus-unverified") ? "unverified-finality" : "valid",
      assurance: FAULTS.has("consensus-unverified") ? "multi-path" : "consensus-verified",
      network: request.network, txHash: request.txHash, operators: ["synthetic-offline-test-only"],
      registry: { generation: 1, address: registry }, block: { height: transaction.block.height, hash: transaction.block.hash }, anchor,
      author: { status: "known", key: anchor.author, id: "synthetic-offline-test-only", role: anchor.kind === 3 ? "batch" : "relay", validFrom: 0, validTo: null },
      verifiedFields: [], notes: [], checks: [], finality: null, knownAuthorsSerial: 1,
    } satisfies VerifyResult;
  };
}

export function registryOperator(options: OperatorOptions) {
  return realRegistryOperator({ ...options, bindingRoot: `${dirname(FILE)}/author-bindings`, verifyLanded: syntheticVerifier(options.registry) });
}

export async function verifyConfirmedAnchor(source: Parameters<typeof realVerifyConfirmedAnchor>[0], prepared: PreparedAnchor, receipt: AnchorReceipt) {
  return realVerifyConfirmedAnchor(source, prepared, receipt, syntheticVerifier(prepared.registry));
}
