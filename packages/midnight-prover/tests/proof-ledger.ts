import * as L from "@midnight-ntwrk/ledger-v8";
import type { MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";

// Executes the actual transcript and gas meter; proof validity is covered by the real rehearsal.
export function proofLedger() {
  const states = new Map<string, L.ContractState>();
  const read = (address: string) => states.get(address);
  const source = {
    network: "preprod", operator: "local-ledger",
    node: { batch: async (calls: [string, unknown[]][]) => calls.map(([method, args]) => {
      if (method === "midnight_zswapStateRoot") return Array(33).fill(0);
      if (method === "midnight_contractState") return read(String(args[0])) ? Buffer.from(read(String(args[0]))!.serialize()).toString("hex") : "";
      throw new Error("Unexpected ledger read");
    }) },
  } as MidnightSource;
  const apply = (tx: L.FinalizedTransaction) => {
    for (const intent of tx.intents?.values() ?? []) for (const action of intent.actions) {
      if (action instanceof L.ContractDeploy) states.set(String(action.address), action.initialState);
      else if (action instanceof L.ContractCall) {
        const state = read(String(action.address));
        if (!state || !action.guaranteedTranscript || action.fallibleTranscript) throw new Error("Unexpected proof call");
        const query = new L.QueryContext(state.data, String(action.address));
        const now = BigInt(Math.floor(Date.now() / 1000));
        query.block = { ...query.block, secondsSinceEpoch: now, secondsSinceEpochErr: 0, lastBlockTime: now - 1n };
        state.data = query.runTranscript(action.guaranteedTranscript, L.CostModel.initialCostModel()).state;
        states.set(String(action.address), state);
      }
    }
  };
  return { source, read, apply };
}
