import { readFileSync } from "node:fs";
import * as L from "@midnight-ntwrk/ledger-v8";
import { censusBatch, decodeReceiptRecord, memberSnapshot, merklePath } from "@fluxpointstudios/orynq-sdk-core/checkpoint";
import { metadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { authorKey, batchSetCommitment } from "../commitment.js";
import { verifyExecution } from "../execution.js";
import { registryInitialState } from "../registry.js";
import { fromHex, toHex } from "../scale.js";
import { headerHash } from "../substrate.js";
import storage from "./fixtures/storage-proof-mainnet.json";
import { anchorChain, DEPLOY_HEIGHT, fixture } from "./anchor-chain.js";
import { finalBytes, unprovenRegistryCall } from "./registry-call.js";
import { replaceProofValue } from "./proof-node.js";
import type { MidnightNetwork } from "../registries.js";

export async function batchChain(options: { singleBatch?: boolean; network?: MidnightNetwork } = {}) {
  const network = options.network ?? "mainnet";
  const receipts = JSON.parse(readFileSync(new URL("../../../core/src/__tests__/fixtures/checkpoint-receipts.json", import.meta.url), "utf8"));
  const batch = censusBatch({ genesis: receipts.genesis, finalizedHeight: 2416892, receipts: receipts.receipts.map((r: { receiptId: string; raw: string }) => ({ receiptId: r.receiptId, ...decodeReceiptRecord(Buffer.from(r.raw, "hex")) })) });
  const anchorIds = (options.singleBatch ? [batch.anchorId.slice(2)] : ["00".repeat(32), batch.anchorId.slice(2), "ff".repeat(32)]).sort();
  const commitment = toHex(batchSetCommitment({ materiosGenesis: batch.genesis, anchorIds })), secret = new Uint8Array(32).fill(19), key = toHex(authorKey(secret));
  const { tx } = unprovenRegistryCall({ address: fixture.registry.address, state: registryInitialState(), call: { circuit: "anchor", args: [Buffer.from(commitment, "hex"), 3n] }, witnesses: { authorSecret: secret } });
  const bytes = await finalBytes(tx), txHash = L.Transaction.deserialize("signature", "proof", "binding", bytes).transactionHash();
  const codec = getDynamicBuilder(getLookupFn(unifyMetadata(metadata.dec(readFileSync(new URL("../../runtime/1000300.scale", import.meta.url)))))).buildStorage("System", "Events").value;
  const roots = new Map<number, string>(), proofs = new Map<number, string[]>();
  for (const [height, hash] of [[DEPLOY_HEIGHT, fixture.registry.txHash], [2023, txHash]] as const) {
    const records = (codec.dec(storage.events) as any[]).filter(record => record.phase.type === "ApplyExtrinsic" && record.phase.value === 4 && (record.event.type === "System" || (record.event.type === "Midnight" && record.event.value.type === "TxApplied")));
    for (const record of records) {
      record.phase.value = 1;
      if (record.event.type === "Midnight") record.event.value.value = `0x${hash}`;
    }
    const changed = replaceProofValue(storage.executionProof.proof, storage.header.stateRoot, storage.events, `0x${Buffer.from(codec.enc(records)).toString("hex")}`);
    roots.set(height - 1, storage.parent.header.stateRoot); roots.set(height, changed.root); proofs.set(height, changed.nodes);
  }
  let chain: ReturnType<typeof anchorChain>;
  chain = anchorChain({ place: [[2023, "anchor", toHex(bytes), txHash]], stateRootOf: height => roots.has(height) ? fromHex(roots.get(height)!, "test state root") : undefined,
    node: { midnight_zswapStateRoot: () => Array(33).fill(0), state_getReadProof: params => {
      const at = params[1] as string, height = chain.chain.byHash(at.replace(/^0x/, "")).number;
      if (proofs.has(height)) return { at, proof: proofs.get(height)! };
      if (height === DEPLOY_HEIGHT - 1 || height === 2022) return { at, proof: storage.parent.proof.proof };
      throw new Error("Unexpected test storage proof height");
    } } });
  chain.registry.deployBlockHash = toHex(headerHash(chain.chain.header(DEPLOY_HEIGHT)));
  chain.source.verifyExecution = request => verifyExecution(chain.source.node, request);
  const indexed = chain.indexed.get(txHash)!, member = batch.receipts[0]!;
  const midnight = { registry: chain.registry.address, txHash, blockHeight: indexed.block.height, blockHash: indexed.block.hash };
  const proof = { format: "orynq-midnight-batch-proof/v1", network, materiosGenesis: batch.genesis,
    receipt: { receiptId: member.receiptId, contentHash: member.contentHash, baseRootSha256: member.baseRootSha256, storageLocatorHash: member.storageLocatorHash, certFormat: member.certFormat.format, certChainId: member.certFormat.chainId },
    batch: { index: 0, count: batch.receipts.length, path: merklePath(batch.leafHashes, 0).map(node => node.slice(2)), rootHash: batch.rootHash.slice(2), manifest: batch.manifest },
    set: { commitment, anchorIds }, midnight };
  return { batch, snapshot: memberSnapshot(batch), proof, set: { network, materiosGenesis: batch.genesis, commitment, anchorIds, midnight }, key, chain, authors: chain.authors([{ key, id: "fluxpoint-batch", role: "batch" }], network) };
}
