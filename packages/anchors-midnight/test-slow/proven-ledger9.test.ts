import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as L9 from "@midnightntwrk/ledger-v9";
import { provingProvider } from "@midnightntwrk/zkir-v2";
import { decodeAnchorTransaction } from "../src/anchor-transaction.js";
import { unprovenRegistryCall } from "../src/registry-call.js";
import { deployedRegistry9, finalBytes9, ledger9Strictness, random32 } from "../src/__tests__/registry-call.js";

// After the fork the immutable registry keeps its ledger 8 verifier keys, so a ledger 9 call to it
// carries a zkir-v2 proof of the compactc 0.31.1 circuit. This proves one in-process, as the
// submitter does: zkir checks the circuit against the preimage ledger 9 writes, then proves it.
const params = process.env.MIDNIGHT_PP;
const managed = new URL("../contract/managed/", import.meta.url);
const read = (rel: string) => new Uint8Array(readFileSync(new URL(rel, managed)));
const keys = async (location: string) => ({ proverKey: read(`keys/${location}.prover`), verifierKey: read(`keys/${location}.verifier`), ir: read(`zkir/${location}.bzkir`) });
const provider = (): L9.ProvingProvider => {
  if (!params) throw new Error("MIDNIGHT_PP must name the directory holding bls_midnight_2p13 and 2p14 (tools/compactc/install.sh)");
  const zkir = provingProvider({ lookupKey: keys, getParams: async (k: number) => new Uint8Array(readFileSync(`${params}/bls_midnight_2p${k}`)) });
  return { check: (preimage, location) => zkir.check(preimage, location), prove: (preimage, location, binding) => zkir.prove(preimage, location, binding), lookupKey: keys };
};

const now = new Date();
const registry = deployedRegistry9("preprod", now);
const commitment = random32();
const proofOf = (tx: L9.FinalizedTransaction) => Buffer.from(([...tx.intents!.values()][0]!.actions[0] as L9.ContractCall<L9.Proof>).proof.serialize());
let final: L9.FinalizedTransaction;
let foreign: L9.FinalizedTransaction;

beforeAll(async () => {
  const { tx } = unprovenRegistryCall({ networkId: "preprod", address: registry.address, state: registry.state, parameters: registry.parameters, call: { circuit: "anchor", args: [commitment, 1n] }, witnesses: { authorSecret: random32() }, ttl: new Date(now.getTime() + 1800e3) });
  final = (await tx.prove(provider(), L9.CostModel.initialCostModel())).bind();
  foreign = L9.Transaction.deserialize("signature", "proof", "binding", await finalBytes9(tx));
});

describe("a ledger 9 call to the ledger 8 registry, proven in-process with zkir-v2", () => {
  it("carries a fresh proof and decodes to exactly the anchor", () => {
    expect(proofOf(final).equals(proofOf(foreign))).toBe(false);
    expect(decodeAnchorTransaction(final.serialize(), [registry.address]).calls[0]).toMatchObject({ kind: 1, commitment: Buffer.from(commitment).toString("hex") });
    expect(() => final.wellFormed(registry.ledger, ledger9Strictness(), now)).not.toThrow();
  });
});

// Like ledger-v8's, the ledger-v9 WASM is built without proof verification, so wellFormed() never
// checks a contract proof, whatever verifyContractProofs says. Nothing here may present it as
// proof verification; this canary fails the day the published build starts verifying.
describe("canary: ledger-v9 WASM does not verify contract proofs", () => {
  it("accepts a genuine registry proof of another call in place of the call's own", () => {
    const strictness = ledger9Strictness();
    strictness.verifyContractProofs = true;
    expect(() => foreign.wellFormed(registry.ledger, strictness, now)).not.toThrow();
  });
});
