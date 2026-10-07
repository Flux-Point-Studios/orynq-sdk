import { afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as L from "@midnight-ntwrk/ledger-v8";
import { SyncProgress } from "@midnight-ntwrk/wallet-sdk-abstractions";
import { buildRegistryDeploy, registryInitialState, type IndexedTransaction, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
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
// node refuses bytes whose TTL the chain has passed, and lands the rest.
export function chain({ spec = 1000300, state = deployed.state, node = "2.1.0" }: { spec?: number; state?: L.ContractState; node?: NodeVersion } = {}) {
  const landed = new Map<string, IndexedTransaction>();
  const contracts = new Map([[deployed.address, state]]);
  const HEAD = "00".repeat(32);
  const ledger = ledgerNode({
    blocks: [HEAD],
    contracts: (address) => {
      const held = contracts.get(address);
      return held && hex(held.serialize());
    },
    version: node,
  });
  const call = async (method: string, params: unknown[] = []) => {
    if (method === "state_getRuntimeVersion") return { specVersion: spec };
    if (method === "midnight_zswapStateRoot" || method === "midnight_contractState") return ledger.call("test", method, params);
    if (method === "chain_getBlockHash" && params[0] === 1000) return `0x${HEAD}`;
    if (method === "state_getStorage" && params[0] === TIMESTAMP_NOW && params[1] === `0x${HEAD}`) {
      const now = Buffer.alloc(8);
      now.writeBigUInt64LE(BigInt(Date.now()));
      return `0x${now.toString("hex")}`;
    }
    throw new Error(`unexpected ${method}`);
  };
  const source = {
    operator: "test",
    node: { call, batch: batchOver(call) },
    indexer: {
      async transactions(hash: string) {
        return landed.has(hash) ? [landed.get(hash)!] : [];
      },
      async head() {
        return { height: 1000, hash: HEAD, timestamp: Date.now() };
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
    landed.set(txHash, { hash: txHash, raw: hex(tx.serialize()), block: { height: 500 + landed.size, hash: "ab".repeat(32), timestamp: Date.now() }, status: "SUCCESS", contractActions: [] });
    for (const intent of tx.intents?.values() ?? []) for (const action of intent.actions) if (action instanceof L.ContractDeploy) contracts.set(String(action.address), action.initialState);
  };
  const advance = (millis: number) => {
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + millis);
  };
  return { source, land, advance };
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
