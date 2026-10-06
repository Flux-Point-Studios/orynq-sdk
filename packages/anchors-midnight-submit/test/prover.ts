import { readFileSync } from "node:fs";
import * as L from "@midnight-ntwrk/ledger-v8";
import { provingProvider } from "@midnight-ntwrk/zkir-v2";
import { compiledContractFile } from "@fluxpointstudios/orynq-sdk-anchors-midnight";

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
