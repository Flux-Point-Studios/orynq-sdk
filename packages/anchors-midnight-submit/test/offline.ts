// What a script imports as the submit package (../src/index.js) when a test runs it offline: the
// submit package itself, with its wallet, prover and endpoints replaced, over a chain that lives
// in the JSON file OFFLINE_CHAIN so it outlasts each process, and whose node, midnight-node 2.1.0
// as Blockfrost serves it, refuses bytes whose TTL the chain has passed. The rehearsal's run.ts
// also imports it as ./endpoints.js. OFFLINE_FAULT breaks one step of a run: "refuse-broadcast"
// (a proxy answers the broadcast with HTTP 403), "lose-read" (the first read of a landed
// transaction fails) or "lose-sync" (the wallet stops syncing once a deploy landed).
import { readFileSync, writeFileSync } from "node:fs";
import * as L from "@midnight-ntwrk/ledger-v8";
import { midnightSource, type IndexedTransaction, type MidnightNetwork, type SourceEndpoints } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { ledgerNode } from "../../anchors-midnight/src/__tests__/ledger-node.js";
import { NETWORK_IDENTITY, type OperatorWallet, type WalletOptions } from "../src/index.js";
import { prover } from "./prover.js";

export * from "../src/index.js";

export interface OfflineChain {
  // The network whose chain name and genesis the node reports.
  network: MidnightNetwork;
  // How far time has moved past the host's clock, for the chain and for the process alike.
  aheadMs: number;
  // Every transaction handed to the node, in order, whether or not it landed.
  sent: string[];
  landed: Record<string, { raw: string; height: number; address: string; state: string }>;
  // Every transaction whose DUST the wallet was asked to release.
  discarded: string[];
}

const FILE = process.env.OFFLINE_CHAIN!;
const FAULT = process.env.OFFLINE_FAULT;
const HEAD = "00".repeat(32);
const BLOCK = "ab".repeat(32);
const read = (): OfflineChain => JSON.parse(readFileSync(FILE, "utf8"));
const write = (chain: OfflineChain) => writeFileSync(FILE, JSON.stringify(chain));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
let readsToLose = FAULT === "lose-read" ? 1 : 0;

// The process reads the chain's clock as its own, as a host whose clock is right does: a deployer
// stamps its TTLs from Date.now, so a clock left behind the chain's would stamp bytes the chain
// already refuses.
const hostNow = Date.now;
Date.now = () => hostNow() + read().aheadMs;

// The node reads its ledger in the newest block and in the block every transaction lands in.
const ledger = ledgerNode({ blocks: [HEAD, BLOCK], contracts: (address) => Object.values(read().landed).find((t) => t.address === address)?.state });

// The node's answer to one JSON-RPC request.
function nodeAnswer(method: string, params: unknown[] = []) {
  const identity = NETWORK_IDENTITY[read().network];
  if (method === "system_chain") return { result: identity.chain };
  if (method === "midnight_ledgerVersion") return { result: "8.1.3" };
  if (method === "state_getRuntimeVersion") return { result: { specVersion: 1000300 } };
  if (method === "chain_getBlockHash") return { result: `0x${params[0] === 0 ? identity.genesis : HEAD}` };
  if (method === "state_getStorage" && params[1] === `0x${HEAD}`) {
    const now = Buffer.alloc(8);
    now.writeBigUInt64LE(BigInt(Date.now()));
    return { result: `0x${now.toString("hex")}` };
  }
  if (method === "midnight_zswapStateRoot" || method === "midnight_contractState") return ledger.answer(method, params);
  return { error: { code: -32000, message: `offline node: unexpected ${method}` } };
}

const indexer = {
  async transactions(hash: string): Promise<IndexedTransaction[]> {
    const t = read().landed[hash];
    if (!t) return [];
    if (readsToLose > 0) {
      readsToLose--;
      throw new Error("offline indexer: HTTP 502: Bad Gateway");
    }
    return [{ hash, raw: t.raw, block: { height: t.height, hash: BLOCK, timestamp: Date.now() }, status: "SUCCESS", contractActions: [{ kind: "ContractDeploy", address: t.address, state: t.state }] }];
  },
  async head() {
    return { height: 1000, hash: HEAD, timestamp: Date.now() };
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
export async function openWallet(options: WalletOptions): Promise<OperatorWallet> {
  return {
    network: options.network,
    addresses: options.expectedAddresses!,
    async waitForSync() {},
    async progress() {
      throw new Error("offline wallet: unexpected progress");
    },
    async saveState() {},
    async balances() {
      if (FAULT === "lose-sync" && Object.keys(read().landed).length > 0) throw new Error(`the ${options.network} wallet did not sync within 600 s`);
      return { night: 10n ** 9n, dust: 10n ** 16n, nightUtxos: 1, registeredNightUtxos: 1 };
    },
    async registerNightForDust() {
      return null;
    },
    async payFee(tx) {
      return tx.bind();
    },
    async submit(tx) {
      const chain = read();
      chain.sent.push(tx.transactionHash());
      write(chain);
      if (FAULT === "refuse-broadcast") throw new Error("offline node: HTTP 403: Forbidden");
      if ([...tx.intents!.values()].some((intent) => intent.ttl.getTime() < Date.now())) {
        throw new Error('offline node: author_submitExtrinsic failed: {"code":1010,"message":"Invalid Transaction","data":"the TTL is behind the chain\'s time"}');
      }
      const deploy = [...tx.intents!.values()].flatMap((intent) => intent.actions).find((a): a is L.ContractDeploy => a instanceof L.ContractDeploy)!;
      chain.landed[tx.transactionHash()] = { raw: hex(tx.serialize()), height: 500 + Object.keys(chain.landed).length, address: String(deploy.address), state: hex(deploy.initialState.serialize()) };
      write(chain);
    },
    async discard(tx) {
      const chain = read();
      chain.discarded.push(tx.transactionHash());
      write(chain);
    },
    async close() {},
  };
}
