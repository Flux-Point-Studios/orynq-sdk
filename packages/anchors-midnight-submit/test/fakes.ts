import { afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as L from "@midnight-ntwrk/ledger-v8";
import { provingProvider } from "@midnight-ntwrk/zkir-v2";
import { buildRegistryDeploy, compiledContractFile, type IndexedTransaction, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";

export const dir = mkdtempSync(join(tmpdir(), "orynq-submit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
export const fresh = (name: string) => join(dir, `${n++}-${name}`);
export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const bytes32 = () => crypto.getRandomValues(new Uint8Array(32));

// Final-form bytes without proving: zkir checks each circuit as a prover would, and every proof
// is the one real registry proof recorded in the verifier's fixtures. The ledger WASM never
// verifies a proof, so these decode and hash exactly as submitted bytes do.
const recordedProof = new Uint8Array(
  Buffer.from((JSON.parse(readFileSync(new URL("../../anchors-midnight/src/__tests__/fixtures/registry-transactions.json", import.meta.url), "utf8")) as { proof: string }).proof, "hex"),
);
const zkir = provingProvider({
  async lookupKey(location: string) {
    return { proverKey: compiledContractFile(`keys/${location}.prover`), verifierKey: compiledContractFile(`keys/${location}.verifier`), ir: compiledContractFile(`zkir/${location}.bzkir`) };
  },
  async getParams() {
    throw new Error("never proves");
  },
});
export const prover = {
  prove: (tx: L.UnprovenTransaction) => tx.prove({ check: (p, l) => zkir.check(p, l), prove: async () => recordedProof }, L.CostModel.initialCostModel()),
};

export const deployed = (() => {
  const { tx, address } = buildRegistryDeploy({ networkId: "preprod", ttl: new Date(Date.now() + 3600e3) });
  return { address, state: ([...tx.intents!.values()][0]!.actions[0] as L.ContractDeploy).initialState };
})();

// The chain as the operator sees it: a node that runs `spec` and holds `state` at the registry,
// and an indexer that lists every transaction once it has reached the node.
export function chain({ spec = 1000300, state = deployed.state }: { spec?: number; state?: L.ContractState } = {}) {
  const landed = new Map<string, IndexedTransaction>();
  const source = {
    operator: "test",
    node: {
      async call(method: string, params: unknown[] = []) {
        if (method === "state_getRuntimeVersion") return { specVersion: spec };
        if (method === "midnight_contractState") return params[0] === deployed.address ? hex(state.serialize()) : null;
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
        return { height: 1000, hash: "00".repeat(32), timestamp: Date.now() };
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
  };
  return { source, land };
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
