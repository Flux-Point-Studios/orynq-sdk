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

export interface MidnightSource {
  operator: string;
  indexer: {
    transactions(hash: string): Promise<IndexedTransaction[]>;
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
    node: `https://rpc.midnight-${network}.blockfrost.io`,
    headers: { project_id: readPrivateFile(projectIdFile).trim() },
  };
}

const HASH = /^[0-9a-f]{64}$/;
const TRANSACTIONS = `query Transactions($hash: HexEncoded!) {
  transactions(offset: { hash: $hash }) {
    __typename hash raw block { height hash timestamp }
    ... on RegularTransaction { transactionResult { status } }
    contractActions { __typename address state ... on ContractCall { entryPoint } }
  }
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
  return {
    operator: endpoints.operator,
    indexer: {
      async transactions(hash) {
        if (!HASH.test(hash)) throw new Error(`a transaction hash must be 64 lowercase hex characters`);
        const out = (await post(endpoints.indexer, "indexer", { query: TRANSACTIONS, variables: { hash } })) as {
          data?: { transactions: Array<Record<string, any>> };
          errors?: unknown;
        };
        if (out.errors !== undefined || !out.data) throw new Error(redact(`${endpoints.operator} indexer: ${JSON.stringify(out.errors ?? out).slice(0, 300)}`));
        return out.data.transactions.map((t) => ({
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
