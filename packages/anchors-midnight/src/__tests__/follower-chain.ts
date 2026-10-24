import { readFileSync } from "node:fs";
import { metadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { anchorChain, fixture } from "./anchor-chain.js";
import { replaceProofValue } from "./proof-node.js";
import storage from "./fixtures/storage-proof-mainnet.json";
import { headerHash } from "../substrate.js";
import type { MidnightSource } from "../source.js";

const codec = getDynamicBuilder(getLookupFn(unifyMetadata(metadata.dec(readFileSync(new URL("../../runtime/1000300.scale", import.meta.url)))))).buildStorage("System", "Events").value;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
export function followerChain(edit: (method: string, params: unknown[], value: any) => unknown = (_, __, value) => value) {
  const combined = [...new Set([...storage.proof.proof, ...storage.executionProof.proof])];
  const empty = replaceProofValue(combined, storage.header.stateRoot, storage.events, `0x${Buffer.from(codec.enc([])).toString("hex")}`);
  const events = (codec.dec(storage.events) as any[]).filter(row => row.phase.type === "ApplyExtrinsic" && row.phase.value === 4 && (row.event.type === "System" || (row.event.type === "Midnight" && row.event.value.type === "TxApplied")));
  for (const row of events) { row.phase.value = 1; if (row.event.type === "Midnight") row.event.value.value = `0x${fixture.anchor.txHash}`; }
  const applied = replaceProofValue(combined, storage.header.stateRoot, storage.events, `0x${Buffer.from(codec.enc(events)).toString("hex")}`);
  const proofAt = (height: number) => height === 1601 ? applied : empty;
  let chain: ReturnType<typeof anchorChain>;
  chain = anchorChain({ place: [[1601, "anchor", fixture.anchor.tx, fixture.anchor.txHash]], stateRootOf: height => Buffer.from(proofAt(height).root.slice(2), "hex"),
    node: { state_getReadProof: params => { const at = params[1] as string; return { at, proof: proofAt(chain.chain.byHash(at).number).nodes }; } } });
  const calls: string[] = [], original = chain.source.node;
  const node: MidnightSource["node"] = {
    async call<T>(method: string, params: unknown[] = []) { calls.push(method); return edit(method, params, await original.call(method, params)) as T; },
    async batch<T>(batch: [string, unknown[]][]) { return Promise.all(batch.map(([method, params]) => node.call<T>(method, params))); },
  };
  const source = { ...chain.source, network: "mainnet" as const, node }, checkpoint = chain.chain.checkpoint(0);
  const ref = (height: number) => ({ height, hash: hex(headerHash(chain.chain.header(height))) });
  return { source, checkpoint, ref, calls, chain };
}
