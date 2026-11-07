import { readFileSync } from "node:fs";
import * as L from "@midnight-ntwrk/ledger-v8";
import * as L9 from "@midnightntwrk/ledger-v9";
import { provingProvider } from "@midnight-ntwrk/zkir-v2";
import { compiledContractFile } from "@fluxpointstudios/orynq-sdk-anchors-midnight";

// Final-form bytes without proving: zkir checks each circuit as a prover would, and every proof
// is the one real registry proof recorded in the verifier's fixtures. The ledger WASM never
// verifies a proof, so these decode and hash exactly as submitted bytes do.
const recordedProof = new Uint8Array(
  Buffer.from((JSON.parse(readFileSync(new URL("../../anchors-midnight/src/__tests__/fixtures/registry-transactions.json", import.meta.url), "utf8")) as { proof: string }).proof, "hex"),
);
const zkir = provingProvider({
  lookupKey: (location: string) => keyMaterial(location),
  async getParams() {
    throw new Error("never proves");
  },
});
const keyMaterial = async (location: string) => ({ proverKey: compiledContractFile(`keys/${location}.prover`), verifierKey: compiledContractFile(`keys/${location}.verifier`), ir: compiledContractFile(`zkir/${location}.bzkir`) });
function prove(tx: L.UnprovenTransaction): Promise<L.Transaction<L.SignatureEnabled, L.Proof, L.PreBinding>>;
function prove(tx: L9.UnprovenTransaction): Promise<L9.Transaction<L9.SignatureEnabled, L9.Proof, L9.PreBinding>>;
function prove(tx: L.UnprovenTransaction | L9.UnprovenTransaction): Promise<L.Transaction<L.SignatureEnabled, L.Proof, L.PreBinding> | L9.Transaction<L9.SignatureEnabled, L9.Proof, L9.PreBinding>>;
function prove(tx: L.UnprovenTransaction | L9.UnprovenTransaction) {
  if (tx instanceof L9.Transaction) return tx.prove({ check: (p, l) => zkir.check(p, l), prove: async () => recordedProof, lookupKey: keyMaterial }, L9.CostModel.initialCostModel());
  return tx.prove({ check: (p, l) => zkir.check(p, l), prove: async () => recordedProof }, L.CostModel.initialCostModel());
}
export const prover = { prove };
