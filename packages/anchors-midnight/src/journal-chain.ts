import * as L from "@midnight-ntwrk/ledger-v8";
import type { AnchorKey, ChainView, JournalBoundary, JournalConfirmation } from "./journal.js";
import { decodeAnchorTransaction } from "./anchor-transaction.js";
import { contractStateOnNode } from "./contract-state.js";
import { fromHex, ScaleReader, toHex } from "./scale.js";
import { KNOWN_RUNTIME_SPEC_VERSIONS } from "./registries.js";
import { SourceConflict, type MidnightSource } from "./source.js";
import { headerFromRpc, headerHash, midnightTransactionIn, orderedTrieRoot, type RpcHeader } from "./substrate.js";

export const MIDNIGHT_GENESIS_HASHES: Readonly<Record<string, string>> = {
  mainnet: "1941ca8e2bb88146c14dea084d3be7eb6e96ca7135429c543848b628124f2854",
  preprod: "df831b09a8baa92badf47762ce5ac439b7e47e3ed3d39600cfdd44fad552361b",
};
const TIMESTAMP_NOW = "0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb";
const hash = (v: unknown, label: string): string => {
  if (typeof v !== "string" || !/^(0x)?[0-9a-f]{64}$/.test(v)) throw new SourceConflict(`${label} is not a block hash`);
  return v.replace(/^0x/, "");
};
const sameAnchor = (raw: Uint8Array, key: AnchorKey) => decodeAnchorTransaction(raw, [key.registry]).calls.some(c =>
  c.kind === key.kind && c.author === key.author && c.commitment === key.commitment && c.attribute === key.attribute);

// A journal trusts this configured node for its finalized-chain view; this is not itself a
// GRANDPA proof. User-facing receipts still require the consensus verifier. Every operation
// binds the node to the pinned genesis, and every scanned body to its canonical header/root.
class NodeScanDeadline extends Error {}
export function chainView(source: MidnightSource, network: string, { maxScanBlocks = 128, scanTimeoutMillis = 30_000 }: { maxScanBlocks?: number; scanTimeoutMillis?: number } = {}): ChainView {
  if (!MIDNIGHT_GENESIS_HASHES[network]) throw new Error("A journal chain view needs a pinned Midnight network");
  if (!Number.isSafeInteger(maxScanBlocks) || maxScanBlocks < 1 || maxScanBlocks > 1024) throw new Error("Invalid journal block scan budget");
  if (!Number.isFinite(scanTimeoutMillis) || scanTimeoutMillis < 1 || scanTimeoutMillis > 120_000) throw new Error("Invalid journal scan deadline");
  type NodeCall = MidnightSource["node"]["call"];
  const ordinaryCall: NodeCall = source.node.call.bind(source.node);
  const identity = async (call: NodeCall = ordinaryCall) => {
    const genesis = hash(await call("chain_getBlockHash", [0]), "genesis");
    if (genesis !== MIDNIGHT_GENESIS_HASHES[network]) throw new SourceConflict(`The node is not the pinned ${network} chain`);
  };
  const finalized = async (call: NodeCall = ordinaryCall) => {
    await identity(call);
    const blockHash = hash(await call("chain_getFinalizedHead"), "finalized head");
    const json = await call<RpcHeader | null>("chain_getHeader", [`0x${blockHash}`]);
    if (!json) return null;
    const header = headerFromRpc(json);
    if (toHex(headerHash(header)) !== blockHash) throw new SourceConflict("The finalized header does not hash to its claimed block");
    return { height: header.number, hash: blockHash };
  };
  const atHeight = async (height: number, call: NodeCall = ordinaryCall) => hash(await call("chain_getBlockHash", [height]), "canonical block");
  const bodyAt = async (block: JournalBoundary, call: NodeCall = ordinaryCall) => {
    const { specVersion } = await call<{ specVersion: number }>("state_getRuntimeVersion", [`0x${block.hash}`]);
    if (!(KNOWN_RUNTIME_SPEC_VERSIONS as readonly number[]).includes(specVersion)) throw new SourceConflict("A journal scan encountered an unsupported runtime");
    const response = await call<{ block: { header: RpcHeader; extrinsics: string[] } }>("chain_getBlock", [`0x${block.hash}`]);
    const header = headerFromRpc(response.block.header);
    const extrinsics = response.block.extrinsics.map(e => fromHex(e, "extrinsic"));
    if (header.number !== block.height || toHex(headerHash(header)) !== block.hash || toHex(orderedTrieRoot(extrinsics)) !== toHex(header.extrinsicsRoot)) {
      throw new SourceConflict("A scanned journal block disagrees with its canonical header/body root");
    }
    return { header, extrinsics };
  };
  return {
    network,
    async lookup(txHash) {
      await identity();
      const found = (await source.indexer.transactions(txHash)).filter(t => t.hash === txHash);
      if (found.length > 1) throw new SourceConflict("The indexer repeats a journal transaction");
      const tx = found[0];
      if (!tx) return null;
      return { status: tx.status, height: tx.block.height, blockHash: tx.block.hash };
    },
    async indexedThrough() {
      const head = await finalized();
      if (!head) return null;
      const raw = await ordinaryCall<string | null>("state_getStorage", [TIMESTAMP_NOW, `0x${head.hash}`]);
      if (raw === null) throw new Error("The finalized block has no Timestamp.Now");
      const reader = new ScaleReader(fromHex(raw, "Timestamp.Now"), "Timestamp.Now");
      const value = reader.u64(); reader.end();
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Finalized Timestamp.Now exceeds the safe clock range");
      const time = new Date(Number(value));
      if (!Number.isFinite(time.getTime())) throw new Error("Finalized Timestamp.Now is outside the Date range");
      return { ...head, time };
    },
    async holdsContract(address, at) {
      await identity();
      return (await contractStateOnNode(source, address, at)) !== null;
    },
    async finalHash(height) {
      const head = await finalized();
      return !head || height > head.height ? null : atHeight(height);
    },
    async confirm({ key, bytes, since, through, hint }): Promise<JournalConfirmation> {
      let cursor = through;
      const deadline = performance.now() + scanTimeoutMillis;
      const withinBudget = async <T>(operation: () => Promise<T>): Promise<T> => {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new NodeScanDeadline();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            operation(),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new NodeScanDeadline()), remaining); }),
          ]);
        } finally { if (timer) clearTimeout(timer); }
      };
      const call: NodeCall = <T>(method: string, params?: unknown[]) => withinBudget(() => ordinaryCall<T>(method, params));
      try {
      const head = await finalized(call);
      if (!head) return { state: "pending" };
      const tx = L.Transaction.deserialize("signature", "proof", "binding", bytes);
      const originalIntents = [...(tx.intents?.values() ?? [])];
      const guaranteed = originalIntents.every(intent => intent.actions.every(action => !(action instanceof L.ContractCall) || (action.guaranteedTranscript !== undefined && action.fallibleTranscript === undefined)));
      const intents = originalIntents.map(intent => Buffer.from(intent.serialize()));
      const check = async (block: JournalBoundary, loaded?: Awaited<ReturnType<typeof bodyAt>>) => {
        const { header, extrinsics } = loaded ?? await bodyAt(block, call);
        let uncertain = false;
        for (const [extrinsicIndex, extrinsic] of extrinsics.entries()) {
          const raw = midnightTransactionIn(extrinsic);
          if (raw) {
            const actual = L.Transaction.deserialize("signature", "proof", "binding", raw);
            if (actual.transactionHash() === tx.transactionHash() || (key.kind !== 0 && sameAnchor(raw, key))) {
              if (!guaranteed && !source.verifyExecution) return "uncertain";
              if (source.verifyExecution) await withinBudget(() => source.verifyExecution!({ header, blockHash: block.hash, extrinsicIndex, txHash: actual.transactionHash() }));
              return { state: "landed" as const, height: block.height, blockHash: block.hash };
            }
            if (intents.some(intent => Buffer.from(raw).includes(intent))) uncertain = true;
          } else if (intents.some(intent => Buffer.from(extrinsic).includes(intent))) {
            // An unsupported wrapper carrying the intent is not an absence proof. Never free
            // its key merely because the supported top-level decoder cannot authenticate it.
            uncertain = true;
          }
        }
        return uncertain ? "uncertain" : null;
      };
      // Positive inclusion can settle pre-migration rows, but absence cannot: no trustworthy
      // pre-broadcast boundary exists for those rows.
      if (hint && Number.isSafeInteger(hint.height) && hint.height >= 0 && hint.height <= head.height) {
        const canonical = await atHeight(hint.height, call);
        const included = await check({ height: hint.height, hash: canonical });
        if (included && included !== "uncertain") return included;
      }
      if (!since) return { state: "pending" };
      for (const boundary of [since, ...(through ? [through] : [])]) {
        if (boundary.height > head.height || await atHeight(boundary.height, call) !== boundary.hash) throw new SourceConflict("The journal's retained finalized boundary is no longer canonical");
      }
      let count = 0;
      for (let height = through ? through.height + 1 : since.height; height <= head.height && count < maxScanBlocks; height++, count++) {
        const block = { height, hash: await atHeight(height, call) };
        const loaded = await bodyAt(block, call);
        const { header } = loaded;
        if (cursor && toHex(header.parentHash) !== cursor.hash) throw new SourceConflict("Scanned finalized journal blocks do not extend the retained prefix");
        const included = await check(block, loaded);
        if (included === "uncertain") return { state: "pending", ...(cursor ? { through: cursor } : {}) };
        if (included) return included;
        cursor = block;
      }
      if (cursor?.height === head.height && cursor.hash !== head.hash) throw new SourceConflict("The scanned prefix does not end at the finalized head");
      return { state: cursor?.height === head.height ? "absent" : "pending", ...(cursor ? { through: cursor } : {}) };
      } catch (error) {
        if (error instanceof NodeScanDeadline) return { state: "pending", ...(cursor ? { through: cursor } : {}) };
        throw error;
      }
    },
  };
}
