import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as L from "@midnight-ntwrk/ledger-v8";
import { buildRegistryDeploy, type IndexedTransaction, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";

export const dir = mkdtempSync(join(tmpdir(), "orynq-submit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
export const fresh = (name: string) => join(dir, `${n++}-${name}`);
export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const bytes32 = () => crypto.getRandomValues(new Uint8Array(32));
const TIMESTAMP_NOW = "0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb";

export const deployed = (() => {
  const { tx, address } = buildRegistryDeploy({ networkId: "preprod", ttl: new Date(Date.now() + 3600e3) });
  return { address, state: ([...tx.intents!.values()][0]!.actions[0] as L.ContractDeploy).initialState };
})();

// The chain as the operator sees it: a node that runs `spec`, holds `state` at the registry and
// every contract a landed deploy created, and answers an address holding none with an empty
// string, as Midnight's node does; and an indexer that lists every transaction once it has
// reached the node. Its newest block, which the node holds too, is `advance`d milliseconds past
// the local clock.
export function chain({ spec = 1000300, state = deployed.state }: { spec?: number; state?: L.ContractState } = {}) {
  const landed = new Map<string, IndexedTransaction>();
  const contracts = new Map([[deployed.address, state]]);
  const HEAD = "00".repeat(32);
  let ahead = 0;
  const source = {
    operator: "test",
    node: {
      async call(method: string, params: unknown[] = []) {
        if (method === "state_getRuntimeVersion") return { specVersion: spec };
        if (method === "midnight_contractState") {
          if (params.length > 1 && params[1] !== `0x${HEAD}`) throw new Error('test node: midnight_contractState failed: {"code":-32602,"message":"Unable to get requested contract state"}');
          return contracts.has(params[0] as string) ? hex(contracts.get(params[0] as string)!.serialize()) : "";
        }
        if (method === "chain_getBlockHash" && params[0] === 1000) return `0x${HEAD}`;
        if (method === "state_getStorage" && params[0] === TIMESTAMP_NOW && params[1] === `0x${HEAD}`) {
          const now = Buffer.alloc(8);
          now.writeBigUInt64LE(BigInt(Date.now() + ahead));
          return `0x${now.toString("hex")}`;
        }
        throw new Error(`unexpected ${method}`);
      },
      async batch() {
        throw new Error("unexpected batch");
      },
    },
    indexer: {
      async transactions(hash: string) {
        return landed.has(hash) ? [landed.get(hash)!] : [];
      },
      async head() {
        return { height: 1000, hash: HEAD, timestamp: Date.now() + ahead };
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
    const txHash = tx.transactionHash();
    landed.set(txHash, { hash: txHash, raw: hex(tx.serialize()), block: { height: 500 + landed.size, hash: "ab".repeat(32), timestamp: Date.now() }, status: "SUCCESS", contractActions: [] });
    for (const intent of tx.intents?.values() ?? []) for (const action of intent.actions) if (action instanceof L.ContractDeploy) contracts.set(String(action.address), action.initialState);
  };
  return { source, land, advance: (millis: number) => void (ahead += millis) };
}

// A wallet that binds without adding a fee, records what it is asked to submit (and what the
// journal held at that moment), and lands it on `net`. `tamper` replaces the final bytes.
export function wallet(net: ReturnType<typeof chain>, journalPath: () => string, tamper?: (tx: L.FinalizedTransaction) => L.FinalizedTransaction) {
  const submitted: L.FinalizedTransaction[] = [];
  const discarded: string[] = [];
  const rowsAtSubmit: unknown[] = [];
  return {
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
