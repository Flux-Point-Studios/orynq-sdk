import { readFileSync } from "node:fs";
import { metadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import fork from "./fixtures/rpc-mainnet-fork.json";
import { decodeAnchorTransaction } from "../anchor-transaction.js";
import type { FinalityCheckpoint } from "../grandpa.js";
import { fromHex } from "../scale.js";
import type { MidnightSource } from "../source.js";
import { headerFromRpc, midnightTransactionIn, type RpcHeader } from "../substrate.js";

// Mainnet across the Ledger 9 runtime upgrade, recorded from the public node: block 3346138
// carries set_code, which takes effect one block later through :pending_code, so 3346139 is the
// first block executed by runtime 2001100.
export const FORK = { setCode: 3346138, firstLedger9: 3346139, after: fork.after, end: fork.end } as const;
export const CODE_KEYS = "0x3a636f646500", PENDING_CODE_KEYS = "0x3a70656e64696e675f636f646500";
export const SYSTEM_EVENTS = "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7";
const recording = fork.recording as Record<string, unknown>;

export const recorded = <T>(method: string, params: unknown[]): T => {
  const key = method + JSON.stringify(params);
  if (!(key in recording)) throw new Error(`Unrecorded RPC ${key.slice(0, 160)}`);
  return structuredClone(recording[key]) as T;
};

// `edit` sees each request with its recorded answer (undefined when none was recorded) and
// returns the answer to give; undefined fails the request as unrecorded.
export function forkNode(edit: (method: string, params: unknown[], answer: any) => unknown = (_, __, answer) => answer) {
  const calls: string[] = [];
  const node: MidnightSource["node"] = {
    async call<T>(method: string, params: unknown[] = []) {
      calls.push(method);
      const key = method + JSON.stringify(params);
      const answer = edit(method, params, key in recording ? structuredClone(recording[key]) : undefined);
      if (answer === undefined) throw new Error(`Unrecorded RPC ${key.slice(0, 160)}`);
      return answer as T;
    },
    async batch<T>(batch: [string, unknown[]][]) { return Promise.all(batch.map(([method, params]) => node.call<T>(method, params))); },
  };
  return { node, calls };
}

export function forkBlock(height: number) {
  const hash = recorded<string>("chain_getBlockHash", [height]);
  const rpcHeader = recorded<RpcHeader>("chain_getHeader", [hash]);
  return { blockHash: hash.slice(2), header: headerFromRpc(rpcHeader), rpcHeader };
}

// The Midnight sends in a block's body, as the follower binds them: body index and the hash the
// transaction's own bytes decode to.
export function forkSends(height: number) {
  const { block } = recorded<{ block: { extrinsics: string[] } }>("chain_getBlock", [`0x${forkBlock(height).blockHash}`]);
  return block.extrinsics.flatMap((extrinsic, extrinsicIndex) => {
    const bytes = midnightTransactionIn(fromHex(extrinsic, "extrinsic"));
    return bytes ? [{ extrinsicIndex, txHash: decodeAnchorTransaction(bytes, []).txHash }] : [];
  });
}

export const forkCheckpoint: FinalityCheckpoint = {
  setId: BigInt(fork.checkpoint.setId),
  startsAfter: fork.checkpoint.startsAfter,
  authorities: fork.checkpoint.authorities.map(author => ({ key: author.key, weight: BigInt(author.weight) })),
};

export const contractStateAt = (address: string, height: number) =>
  fromHex(recorded<string>("midnight_contractState", [address, `0x${forkBlock(height).blockHash}`]), "contract state");

export const eventsCodec = (spec: 1000300 | 2001100) =>
  getDynamicBuilder(getLookupFn(unifyMetadata(metadata.dec(readFileSync(new URL(`../../runtime/${spec}.scale`, import.meta.url)))))).buildStorage("System", "Events").value;
