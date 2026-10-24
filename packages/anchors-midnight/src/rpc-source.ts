import { decodeAnchorTransaction } from "./anchor-transaction.js";
import { verifyExecution } from "./execution.js";
import { MIDNIGHT_REGISTRIES, assertRegistryGenerations, type MidnightNetwork, type RegistryInfo } from "./registries.js";
import { fromHex, toHex } from "./scale.js";
import { SourceConflict, contractStateOnNode, midnightSource, type IndexedTransaction, type MidnightSource } from "./source.js";
import { headerFromRpc, headerHash, midnightTransactionIn, type RpcHeader } from "./substrate.js";

export interface BlockHint { txHash: string; blockHeight: number; blockHash: string }

// Hints locate bytes. The verifier still proves the body, finality and execution independently.
export function rpcOnlySource(options: { network: MidnightNetwork; node: string | MidnightSource["node"]; hints: readonly BlockHint[]; registries?: readonly RegistryInfo[]; operator?: string }): MidnightSource {
  const registries = options.registries ?? MIDNIGHT_REGISTRIES[options.network];
  assertRegistryGenerations(registries);
  const hints = new Map<string, BlockHint>();
  const add = (hint: BlockHint) => {
    if (!/^[0-9a-f]{64}$/.test(hint.txHash) || !/^[0-9a-f]{64}$/.test(hint.blockHash) || !Number.isSafeInteger(hint.blockHeight) || hint.blockHeight < 0) throw new Error("Invalid transaction block hint");
    const prior = hints.get(hint.txHash);
    if (prior && (prior.blockHeight !== hint.blockHeight || prior.blockHash !== hint.blockHash)) throw new Error("Contradictory transaction block hints");
    hints.set(hint.txHash, { ...hint });
  };
  for (const registry of registries) {
    if (!registry.deployBlockHash) throw new Error("RPC-only verification requires a pinned registry deploy block");
    add({ txHash: registry.deployTxHash, blockHeight: registry.deployHeight, blockHash: registry.deployBlockHash });
  }
  options.hints.forEach(add);
  let operator = options.operator ?? "rpc";
  let node = options.node;
  if (typeof node === "string") {
    const url = new URL(node);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("RPC URL must be HTTP(S) without credentials, query or fragment");
    operator = options.operator ?? url.host;
    // Only the existing transport's node half is used; no GraphQL request is made.
    node = midnightSource({ operator, node: url.href, indexer: url.href, indexerWs: url.href.replace(/^http/, "ws"), headers: {} }).node;
  }
  const rpc = node;
  const unavailable = () => { throw new Error("RPC-only verification requires transaction block hints; indexer discovery is unavailable"); };
  return {
    operator, network: options.network, node: rpc,
    verifyExecution: (request) => verifyExecution(rpc, request),
    indexer: {
      head: unavailable, latestAction: unavailable,
      async *contractActions() { unavailable(); },
      async transactions(txHash) {
        const hint = hints.get(txHash);
        if (!hint) throw new Error("No block hint was provided for this transaction");
        const at = `0x${hint.blockHash}`;
        const response = await rpc.call<{ block: { header: RpcHeader; extrinsics: string[] } } | null>("chain_getBlock", [at]);
        if (!response) throw new SourceConflict("The hinted block is absent");
        const header = headerFromRpc(response.block.header);
        if (toHex(headerHash(header)) !== hint.blockHash || header.number !== hint.blockHeight) throw new SourceConflict("The returned block contradicts its hint");
        const matches = response.block.extrinsics.map((extrinsic) => midnightTransactionIn(fromHex(extrinsic, "extrinsic")))
          .filter((raw): raw is Uint8Array => raw !== null && decodeAnchorTransaction(raw, []).txHash === txHash);
        if (matches.length !== 1) throw new SourceConflict("The hinted block does not contain exactly one matching transaction");
        const raw = matches[0]!;
        const decoded = decodeAnchorTransaction(raw, registries.map((registry) => registry.address));
        const actions = [...decoded.calls.map((call) => ({ address: call.address, kind: "ContractCall" as const, entryPoint: call.entryPoint })),
          ...decoded.touches.map((touch) => ({ address: touch.address, kind: touch.action === "deploy" ? "ContractDeploy" as const : "ContractUpdate" as const }))];
        const contractActions: IndexedTransaction["contractActions"] = [];
        for (const action of actions) {
          const state = await contractStateOnNode({ node: rpc, operator }, action.address, hint.blockHash);
          if (!state) throw new SourceConflict("The hinted block has no state for the requested registry action");
          contractActions.push({ ...action, state: state.replace(/^0x/, "") });
        }
        return [{ hash: txHash, raw: toHex(raw), block: { height: hint.blockHeight, hash: hint.blockHash, timestamp: 0 }, status: null, contractActions }];
      },
    },
  };
}
