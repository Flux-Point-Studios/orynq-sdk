import { afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as L from "@midnight-ntwrk/ledger-v8";
import { SyncProgress } from "@midnight-ntwrk/wallet-sdk-abstractions";
import { buildRegistryDeploy, registryInitialState, headerHash, midnightExtrinsic, orderedTrieRoot, type BlockHeader, type IndexedTransaction, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { batchOver, ledgerNode, type NodeVersion } from "../../anchors-midnight/src/__tests__/ledger-node.js";
import { prover } from "./prover.js";

export const dir = mkdtempSync(join(tmpdir(), "orynq-submit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
export const fresh = (name: string) => join(dir, `${n++}-${name}`);
export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const bytes32 = () => crypto.getRandomValues(new Uint8Array(32));
afterEach(() => void vi.useRealTimers());
const TIMESTAMP_NOW = "0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb";

// A deploy whose maintenance authority has threshold 0, so maintenance updates can apply: final
// bytes for `network` that deploy a state other than the immutable registry's.
export const mutableDeploy = async (network: string) => {
  const mutable = registryInitialState();
  mutable.maintenanceAuthority = new L.ContractMaintenanceAuthority([], 0, 0n);
  const tx = L.Transaction.fromParts(network, undefined, undefined, L.Intent.new(new Date(Date.now() + 600e3)).addDeploy(new L.ContractDeploy(mutable)));
  return (await prover.prove(tx)).bind();
};

export const deployed = (() => {
  const { tx, address } = buildRegistryDeploy({ networkId: "preprod", ttl: new Date(Date.now() + 3600e3) });
  return { address, state: ([...tx.intents!.values()][0]!.actions[0] as L.ContractDeploy).initialState };
})();

// The chain as the operator sees it: a node that runs `spec`, holds `state` at the registry and
// every contract a landed deploy created, and answers for an address holding none as
// midnight-node `node` does; and an indexer that lists every transaction once it has reached the
// node. Its newest block, the one block whose ledger the node reads besides its best, is as new
// as the local clock, and `advance` moves both: a deployer stamps its TTLs from that clock. The
// node refuses bytes whose TTL the chain has passed, and lands the rest. `lag(true)` takes that
// newest block from the node, as a node behind the indexer lacks it, until `lag(false)`. The
// node's finalized chain reaches that newest block, at height 1000, and holds each landed
// transaction's block at its height and an anchorless block at every other; `reorg` moves a
// landed transaction to another block, or off the chain, as a reorg that orphans its block does.
export function chain({ spec = 1000300, state = deployed.state, node = "2.1.0", network = "preprod" }: { spec?: number; state?: L.ContractState; node?: NodeVersion; network?: "mainnet" | "preprod" } = {}) {
  const landed = new Map<string, IndexedTransaction>();
  let lags = false;
  const contracts = new Map([[deployed.address, state]]);
  let tip = 499;
  let blocks = new Map<number, { hash: string; header: BlockHeader; extrinsics: Uint8Array[] }>();
  const times = new Map<number, number>([[499, Date.now()]]);
  const rebuild = () => {
    if (blocks.size) return;
    let parent = "0f".repeat(32);
    for (let height = 499; height <= tip; height++) {
      const txs = [...landed.values()].filter(tx => tx.block.height === height);
      const extrinsics = txs.map(tx => midnightExtrinsic(Buffer.from(tx.raw, "hex")));
      const header: BlockHeader = { parentHash: Buffer.from(parent, "hex"), number: height, stateRoot: Buffer.alloc(32, height % 251), extrinsicsRoot: orderedTrieRoot(extrinsics), digest: [] };
      const hash = hex(headerHash(header)); blocks.set(height, { hash, header, extrinsics }); parent = hash;
    }
  };
  const blockAt = (height: number) => { rebuild(); const block = blocks.get(height); if (!block) throw new Error(`missing synthetic block ${height}`); return block; };
  const rpcHeader = (header: BlockHeader) => ({ parentHash: `0x${hex(header.parentHash)}`, number: `0x${header.number.toString(16)}`, stateRoot: `0x${hex(header.stateRoot)}`, extrinsicsRoot: `0x${hex(header.extrinsicsRoot)}`, digest: { logs: [] } });
  const heightOf = (at: unknown) => { rebuild(); return [...blocks].find(([, block]) => `0x${block.hash}` === at)?.[0]; };
  const pushHead = (height: number) => { const now = Date.now(); for (let h = tip + 1; h <= height; h++) times.set(h, now); tip = height; blocks = new Map(); };
  const heldAt = (at: unknown[]) => !at.length || heightOf(at[0]) !== undefined;
  const call = async (method: string, params: unknown[] = []) => {
    if (method === "state_getRuntimeVersion") return { specVersion: spec };
    if (method === "midnight_zswapStateRoot" || method === "midnight_contractState") {
      const nodeLedger = ledgerNode({ blocks: [...(rebuild(), blocks.values())].map(block => block.hash), contracts: address => { const held = contracts.get(address); return held && hex(held.serialize()); }, version: node });
      return nodeLedger.call("test", method, params);
    }
    if (method === "chain_getBlockHash" && params[0] === 0) return network === "mainnet" ? "0x1941ca8e2bb88146c14dea084d3be7eb6e96ca7135429c543848b628124f2854" : "0xdf831b09a8baa92badf47762ce5ac439b7e47e3ed3d39600cfdd44fad552361b";
    if (method === "chain_getBlockHash") return `0x${blockAt(params[0] as number).hash}`;
    if (method === "chain_getFinalizedHead") return `0x${blockAt(tip).hash}`;
    if (method === "chain_getHeader") { const h = heightOf(params[0]); return lags || h === undefined ? null : rpcHeader(blockAt(h).header); }
    if (method === "chain_getBlock") { const h = heightOf(params[0]); if (h === undefined) throw new Error("missing synthetic block"); const block = blockAt(h); return { block: { header: rpcHeader(block.header), extrinsics: block.extrinsics.map(raw => `0x${hex(raw)}`) } }; }
    if (method === "state_getStorage" && params[0] === TIMESTAMP_NOW && heldAt(params.slice(1))) {
      const now = Buffer.alloc(8); now.writeBigUInt64LE(BigInt(times.get(heightOf(params[1])!) ?? Date.now())); return `0x${now.toString("hex")}`;
    }
    throw new Error(`unexpected ${method}`);
  };
  const source = {
    operator: "test",
    node: { call, batch: batchOver(call) },
    indexer: {
      async transactions(hash: string) {
        const tx = landed.get(hash); return tx ? [{ ...tx, block: { ...tx.block, hash: blockAt(tx.block.height).hash } }] : [];
      },
      async head() {
        return { height: tip, hash: blockAt(tip).hash, timestamp: times.get(tip)! };
      },
      async latestAction() {
        return null;
      },
      contractActions() {
        throw new Error("unexpected subscription");
      },
    },
  } as unknown as MidnightSource;
  const land = (tx: L.FinalizedTransaction) => {
    if ([...(tx.intents?.values() ?? [])].some((intent) => intent.ttl.getTime() < Date.now())) {
      throw new Error('test node: author_submitExtrinsic failed: {"code":1010,"message":"Invalid Transaction","data":"the TTL is behind the chain\'s time"}');
    }
    const txHash = tx.transactionHash();
    const height = Math.max(500 + landed.size, tip + 1);
    landed.set(txHash, { hash: txHash, raw: hex(tx.serialize()), block: { height, hash: "", timestamp: Date.now() }, status: "SUCCESS", contractActions: [] });
    times.set(height, Date.now()); pushHead(Math.max(1000, tip + 1));
    for (const intent of tx.intents?.values() ?? []) for (const action of intent.actions) if (action instanceof L.ContractDeploy) contracts.set(String(action.address), action.initialState);
  };
  const advance = (millis: number) => {
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + millis);
    pushHead(tip + 1);
  };
  const lag = (on: boolean) => void (lags = on);
  const reorg = (txHash: string, to?: { height: number; hash: string }) => {
    const moved = landed.get(txHash)!;
    if (to) landed.set(txHash, { ...moved, block: { ...moved.block, ...to } });
    else landed.delete(txHash);
    blocks = new Map();
  };
  return { source, land, advance, lag, reorg, blockHash: (height: number) => blockAt(height).hash };
}

// A wallet named `name` that binds without adding a fee, records what it is asked to submit (and
// what the journal held at that moment), and lands it on `net`. `tamper` replaces the final bytes.
export function wallet(net: ReturnType<typeof chain>, journalPath: () => string, tamper?: (tx: L.FinalizedTransaction) => L.FinalizedTransaction, name = "a") {
  const submitted: L.FinalizedTransaction[] = [];
  const discarded: string[] = [];
  const rowsAtSubmit: unknown[] = [];
  return {
    addresses: { unshielded: `mn_addr_test1${name}`, shielded: `mn_shield-addr_test1${name}`, dust: `mn_dust_test1${name}` },
    submitted,
    discarded,
    rowsAtSubmit,
    async payFee(tx: L.Transaction<L.SignatureEnabled, L.Proof, L.PreBinding>) {
      const bound = tx.bind();
      return tamper ? tamper(bound) : bound;
    },
    async submit(tx: L.FinalizedTransaction) {
      const db = new DatabaseSync(journalPath());
      rowsAtSubmit.push(db.prepare("select tx_hash, state from attempts").all());
      db.close();
      submitted.push(tx);
      net.land(tx);
    },
    async discard(tx: L.FinalizedTransaction) {
      discarded.push(tx.transactionHash());
    },
  };
}

// The facade's state as openWallet reads it: the DUST sync has applied the indexer's events up to
// `applied`, and the indexer's last message named `announced` as its newest.
export const facadeSyncedTo = (applied: bigint, announced: bigint, connected = true) => ({
  isSynced: false,
  shielded: { progress: SyncProgress.createSyncProgress({ appliedIndex: 3n, highestRelevantWalletIndex: 4n, isConnected: true }) },
  unshielded: { progress: { appliedId: 8n, highestTransactionId: 9n, isConnected: true } },
  dust: { progress: SyncProgress.createSyncProgress({ appliedIndex: applied, highestRelevantWalletIndex: announced, isConnected: connected }) },
});
