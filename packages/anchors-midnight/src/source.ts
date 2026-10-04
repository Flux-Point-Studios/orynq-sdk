import type { FinalityRpc } from "./grandpa.js";
import type { MidnightNetwork } from "./registries.js";
import { readPrivateFile } from "./private-file.js";
import { fromHex } from "./scale.js";
import type { RpcHeader } from "./substrate.js";

// Where a source reads from: a Midnight indexer's GraphQL endpoint and a Midnight node's
// JSON-RPC endpoint, with the request headers that authenticate to them.
export interface SourceEndpoints {
  operator: string;
  indexer: string;
  indexerWs: string;
  node: string;
  headers: Record<string, string>;
}

export interface IndexedTransaction {
  hash: string;
  raw: string;
  block: { height: number; hash: string; timestamp: number };
  status: "SUCCESS" | "PARTIAL_SUCCESS" | "FAILURE" | null;
  contractActions: Array<{ kind: "ContractCall" | "ContractDeploy" | "ContractUpdate"; address: string; state: string; entryPoint?: string }>;
}

// A contract action as the indexer's contractActions subscription delivers it.
export interface IndexedAction {
  txHash: string;
  // The indexer's sequence number for the transaction, which orders transactions in a block.
  transactionId: number;
  raw: string;
  block: { height: number; hash: string };
}

export interface MidnightSource {
  operator: string;
  indexer: {
    transactions(hash: string): Promise<IndexedTransaction[]>;
    head(): Promise<{ height: number; hash: string; timestamp: number }>;
    latestAction(address: string): Promise<{ height: number; transactionId: number } | null>;
    // Every action on `address` from block `fromHeight` on, in chain order, then new ones as
    // they come; the subscription closes when the consumer stops iterating.
    contractActions(address: string, fromHeight: number): AsyncIterableIterator<IndexedAction>;
  };
  node: {
    call<T = unknown>(method: string, params?: unknown[]): Promise<T>;
    batch<T = unknown>(calls: Array<[method: string, params: unknown[]]>): Promise<T[]>;
  };
}

// Blockfrost's Midnight indexer and node, authenticated by the project id in `projectIdFile`,
// which must be a file only its owner can read.
export function blockfrostEndpoints(network: MidnightNetwork, projectIdFile: string): SourceEndpoints {
  return {
    operator: "blockfrost",
    indexer: `https://midnight-${network}.blockfrost.io/api/v0`,
    indexerWs: `wss://midnight-${network}.blockfrost.io/api/v0/ws`,
    node: `https://rpc.midnight-${network}.blockfrost.io`,
    headers: { project_id: readPrivateFile(projectIdFile).trim() },
  };
}

const httpUrl = (value: string, name: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`the ${name} URL must be http or https`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`the ${name} URL must be http or https`);
  return url;
};

// The endpoints a user configured: Blockfrost's for `network`, authenticated by a project id
// file, or a Midnight indexer's GraphQL URL and a node's JSON-RPC URL that need no credential
// (a self-hosted node, say). Null when neither is configured.
export function sourceEndpoints(
  network: MidnightNetwork,
  config: { blockfrostProjectIdFile?: string | undefined; indexer?: string | undefined; node?: string | undefined },
): SourceEndpoints | null {
  const { blockfrostProjectIdFile, indexer, node } = config;
  if (blockfrostProjectIdFile !== undefined && (indexer !== undefined || node !== undefined)) {
    throw new Error("give a Blockfrost project id file or an indexer and node URL, not both");
  }
  if (blockfrostProjectIdFile !== undefined) return blockfrostEndpoints(network, blockfrostProjectIdFile);
  if (indexer === undefined && node === undefined) return null;
  if (indexer === undefined || node === undefined) throw new Error("an indexer URL needs a node URL, and a node URL an indexer URL");
  const graphql = httpUrl(indexer, "indexer").href.replace(/\/$/, "");
  const rpc = httpUrl(node, "node").href;
  return { operator: new URL(graphql).host, indexer: graphql, indexerWs: `${graphql.replace(/^http/, "ws")}/ws`, node: rpc, headers: {} };
}

const HASH = /^[0-9a-f]{64}$/;
const TRANSACTIONS = `query Transactions($hash: HexEncoded!) {
  transactions(offset: { hash: $hash }) {
    __typename hash raw block { height hash timestamp }
    ... on RegularTransaction { transactionResult { status } }
    contractActions { __typename address state ... on ContractCall { entryPoint } }
  }
}`;

const HEAD = "query Head { block { height hash timestamp } }";
const LATEST_ACTION = "query LatestAction($address: HexEncoded!) { contract(address: $address) { actions(limit: 1) { transaction { id block { height } } } } }";
const CONTRACT_ACTIONS = `subscription ContractActions($address: HexEncoded!, $height: Int!) {
  contractActions(address: $address, offset: { height: $height }) { transaction { id hash raw block { height hash } } }
}`;

interface RpcAnswer {
  id?: number;
  result?: unknown;
  error?: unknown;
}

// Every header value is a credential: no error, status text or echoed body carries one.
export function midnightSource(endpoints: SourceEndpoints): MidnightSource {
  const secrets = Object.values(endpoints.headers).filter((v) => v.length >= 8);
  const redact = (text: string) => secrets.reduce((t, s) => t.split(s).join("<redacted>"), text);
  const post = async (url: string, what: string, body: unknown): Promise<unknown> => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...endpoints.headers }, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(redact(`${endpoints.operator} ${what}: HTTP ${res.status}: ${text.slice(0, 300)}`));
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(redact(`${endpoints.operator} ${what}: answered with something other than JSON: ${text.slice(0, 120)}`));
    }
  };
  const answer = (method: string, a: RpcAnswer | undefined) => {
    if (!a) throw new Error(`${endpoints.operator} node: no answer to ${method}`);
    if (a.error !== undefined) throw new Error(redact(`${endpoints.operator} node: ${method} failed: ${JSON.stringify(a.error)}`));
    return a.result;
  };
  const graphql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const out = (await post(endpoints.indexer, "indexer", { query, variables })) as { data?: T; errors?: unknown };
    if (out.errors !== undefined || !out.data) throw new Error(redact(`${endpoints.operator} indexer: ${JSON.stringify(out.errors ?? out).slice(0, 300)}`));
    return out.data;
  };
  return {
    operator: endpoints.operator,
    indexer: {
      async head() {
        const { block } = await graphql<{ block: { height: number; hash: string; timestamp: number } }>(HEAD, {});
        return { height: block.height, hash: block.hash, timestamp: block.timestamp };
      },
      async latestAction(address) {
        if (!HASH.test(address)) throw new Error("a contract address must be 64 lowercase hex characters");
        const { contract } = await graphql<{ contract: { actions: Array<{ transaction: { id: number; block: { height: number } } }> } | null }>(LATEST_ACTION, { address });
        const latest = contract?.actions[0];
        return latest ? { height: latest.transaction.block.height, transactionId: latest.transaction.id } : null;
      },
      contractActions: (address, fromHeight) => subscribe(endpoints, redact, address, fromHeight),
      async transactions(hash) {
        if (!HASH.test(hash)) throw new Error(`a transaction hash must be 64 lowercase hex characters`);
        const out = await graphql<{ transactions: Array<Record<string, any>> }>(TRANSACTIONS, { hash });
        return out.transactions.map((t) => ({
          hash: t.hash,
          raw: t.raw,
          block: { height: t.block.height, hash: t.block.hash, timestamp: t.block.timestamp },
          status: t.transactionResult?.status ?? null,
          contractActions: t.contractActions.map((a: Record<string, string>) => ({
            kind: a.__typename as IndexedTransaction["contractActions"][number]["kind"],
            address: a.address!,
            state: a.state!,
            ...(a.entryPoint === undefined ? {} : { entryPoint: a.entryPoint }),
          })),
        }));
      },
    },
    node: {
      async call<T>(method: string, params: unknown[] = []) {
        return answer(method, (await post(endpoints.node, "node", { jsonrpc: "2.0", id: 1, method, params })) as RpcAnswer) as T;
      },
      async batch<T>(calls: Array<[string, unknown[]]>) {
        if (calls.length === 0) return [];
        const answers = (await post(
          endpoints.node,
          "node",
          calls.map(([method, params], id) => ({ jsonrpc: "2.0", id, method, params })),
        )) as RpcAnswer[];
        if (!Array.isArray(answers)) throw new Error(`${endpoints.operator} node: a batch was answered with a single response`);
        const byId = new Map(answers.map((a) => [a.id, a]));
        return calls.map(([method], id) => answer(method, byId.get(id)) as T);
      },
    },
  };
}

// The indexer's contractActions subscription over graphql-transport-ws. Messages queue until
// the consumer asks for them; an error or the server's completion ends the iteration.
function subscribe(endpoints: SourceEndpoints, redact: (s: string) => string, address: string, fromHeight: number): AsyncIterableIterator<IndexedAction> {
  if (!HASH.test(address)) throw new Error("a contract address must be 64 lowercase hex characters");
  const queue: IndexedAction[] = [];
  let waiting: ((r: IteratorResult<IndexedAction>) => void) | null = null;
  let failed: ((e: Error) => void) | null = null;
  let ended: Error | "done" | null = null;
  const fail = `${endpoints.operator} indexer subscription`;
  const socket = new WebSocket(endpoints.indexerWs, { protocols: ["graphql-transport-ws"], headers: endpoints.headers } as never);
  let subscribed = false;
  let open = true;
  const settle = (end: Error | "done") => {
    ended ??= end;
    if (waiting && ended === "done") waiting({ value: undefined, done: true });
    else if (failed && ended instanceof Error) failed(ended);
    waiting = failed = null;
  };
  socket.onopen = () => socket.send(JSON.stringify({ type: "connection_init" }));
  socket.onerror = (e: Event) => settle(new Error(redact(`${fail}: ${(e as Event & { message?: string }).message ?? "socket error"}`)));
  socket.onclose = (e: CloseEvent) => {
    open = false;
    settle(e.code === 1000 ? "done" : new Error(redact(`${fail}: closed ${e.code} ${e.reason}`)));
  };
  // Node treats a throw from a WebSocket handler as an uncaught exception and ends the process,
  // so every frame either yields an action or ends the iteration with the reason.
  socket.onmessage = (m: MessageEvent) => {
    let message: { type?: unknown; payload?: any };
    try {
      message = JSON.parse(String(m.data));
    } catch {
      return close(new Error(`${fail}: a frame is not JSON`), true);
    }
    if (message.type === "connection_ack") {
      socket.send(JSON.stringify({ id: "1", type: "subscribe", payload: { query: CONTRACT_ACTIONS, variables: { address, height: fromHeight } } }));
      subscribed = true;
    } else if (message.type === "next") {
      if (message.payload?.errors !== undefined) return close(new Error(redact(`${fail}: ${JSON.stringify(message.payload.errors).slice(0, 300)}`)), true);
      const t = message.payload?.data?.contractActions?.transaction;
      if (typeof t?.hash !== "string" || !Number.isSafeInteger(t.id) || typeof t.raw !== "string" || !Number.isSafeInteger(t.block?.height) || typeof t.block.hash !== "string") {
        return close(new Error(`${fail}: a next frame carries no transaction`), true);
      }
      const action: IndexedAction = { txHash: t.hash, transactionId: t.id, raw: t.raw, block: { height: t.block.height, hash: t.block.hash } };
      if (waiting) {
        waiting({ value: action, done: false });
        waiting = failed = null;
      } else queue.push(action);
    } else if (message.type === "error") close(new Error(redact(`${fail}: ${JSON.stringify(message.payload)}`)), false);
    else if (message.type === "complete") close("done", false);
  };
  // Ends the iteration and closes the socket, telling the indexer when it is the client that stops.
  function close(end: Error | "done", clientStops: boolean) {
    if (open && subscribed && clientStops) socket.send(JSON.stringify({ id: "1", type: "complete" }));
    if (open) socket.close(1000);
    open = false;
    settle(end);
  }
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      const value = queue.shift();
      if (value) return Promise.resolve({ value, done: false });
      if (ended === "done") return Promise.resolve({ value: undefined, done: true });
      if (ended) return Promise.reject(ended);
      return new Promise((resolve, reject) => {
        waiting = resolve;
        failed = reject;
      });
    },
    async return() {
      close("done", true);
      return { value: undefined, done: true };
    },
  };
}

// GRANDPA finality proofs and headers through a source's node, one batched request per call.
export function finalityRpc(source: MidnightSource): FinalityRpc {
  return {
    async proveFinality(heights) {
      const proofs = await source.node.batch<string | null>(heights.map((h) => ["grandpa_proveFinality", [h]]));
      return proofs.map((p) => (p === null ? null : fromHex(p, "finality proof")));
    },
    async headers(hashes) {
      return source.node.batch<RpcHeader>(hashes.map((h) => ["chain_getHeader", [h.startsWith("0x") ? h : `0x${h}`]]));
    },
  };
}
