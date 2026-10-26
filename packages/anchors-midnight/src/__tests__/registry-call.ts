import { readFileSync } from "node:fs";
import * as L from "@midnight-ntwrk/ledger-v8";
import { provingProvider } from "@midnight-ntwrk/zkir-v2";
import { unprovenRegistryCall as buildCall, type RegistryWitnesses } from "../registry-call.js";
import { buildRegistryDeploy } from "../registry.js";

export const NETWORK = "undeployed";
export type Witnesses = RegistryWitnesses;

export const random32 = () => crypto.getRandomValues(new Uint8Array(32));
export const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
export const pad32 = (s: string) => {
  const out = new Uint8Array(32);
  out.set(Buffer.from(s, "utf8"));
  return out;
};

export const deployOf = (tx: L.UnprovenTransaction) => [...tx.intents!.values()][0]!.actions[0] as L.ContractDeploy;

// The registry exactly as buildRegistryDeploy deploys it: its address and initial state.
export function deployedRegistry(): { address: string; state: L.ContractState } {
  const { tx, address } = buildRegistryDeploy({ networkId: NETWORK, ttl: new Date(Date.now() + 3600e3) });
  return { address, state: deployOf(tx).initialState };
}

// unprovenRegistryCall for the test network, with a TTL an hour out unless one is given.
export function unprovenRegistryCall(options: Omit<Parameters<typeof buildCall>[0], "networkId" | "ttl"> & { ttl?: Date }) {
  return buildCall({ networkId: NETWORK, ttl: new Date(Date.now() + 3600e3), ...options });
}

// The distinct op names of a transcript; a popeq would mean the circuit reads ledger state.
export function opNames(ops: ReadonlyArray<unknown>): string[] {
  return [...new Set(ops.map((op) => (typeof op === "string" ? op : Object.keys(op as object)[0]!)))].sort();
}

// A one-intent pre-binding transaction ends with its binding randomness, an embedded-curve
// scalar written as a SCALE compact integer in big-integer mode: a header byte, then the
// scalar little-endian with no trailing zero. Flipping the last byte (the scalar's top byte)
// can leave a trailing zero or pass the field order, and deserialization then fails before
// any binding check. Flipping the low bit of the lowest-order byte moves the scalar by one
// and keeps the encoding canonical.
const EMBEDDED_FR_TAG = Buffer.from("midnight:embedded-fr[v1]:");
export function flipBindingRandomness<P extends L.Proofish>(tx: L.Transaction<L.SignatureEnabled, P, L.PreBinding>): Uint8Array {
  const bytes = Buffer.from(tx.serialize());
  const intents = [...(tx.intents?.values() ?? [])];
  if (intents.length !== 1) throw new Error(`expected one intent, got ${intents.length}`);
  const binding = Buffer.from(intents[0]!.binding.serialize());
  if (!binding.subarray(0, EMBEDDED_FR_TAG.length).equals(EMBEDDED_FR_TAG)) throw new Error("the intent's pre-binding is not an embedded-fr scalar");
  const scalar = binding.subarray(EMBEDDED_FR_TAG.length);
  if ((scalar[0]! & 3) !== 3 || (scalar[0]! >> 2) + 5 !== scalar.length) throw new Error("the binding randomness is not a big-integer-mode SCALE compact");
  if (!bytes.subarray(-scalar.length).equals(scalar)) throw new Error("the transaction does not end with its binding randomness");
  bytes[bytes.length - scalar.length + 1]! ^= 1;
  return bytes;
}

// Final-form bytes for a transaction without proving it: the circuit is checked by zkir as a
// prover would, and every proof is the one real registry proof recorded in the fixtures. The
// ledger WASM never verifies a proof, so these decode and hash exactly as submitted bytes do.
const managed = new URL("../../contract/managed/", import.meta.url);
const recordedProof = () =>
  Buffer.from((JSON.parse(readFileSync(new URL("./fixtures/registry-transactions.json", import.meta.url), "utf8")) as { proof: string }).proof, "hex");
export async function finalBytes(tx: L.UnprovenTransaction): Promise<Uint8Array> {
  const read = (rel: string) => new Uint8Array(readFileSync(new URL(rel, managed)));
  const zkir = provingProvider({
    async lookupKey(location: string) {
      return { proverKey: read(`keys/${location}.prover`), verifierKey: read(`keys/${location}.verifier`), ir: read(`zkir/${location}.bzkir`) };
    },
    async getParams() {
      throw new Error("finalBytes never proves");
    },
  });
  const proof = new Uint8Array(recordedProof());
  const stub: L.ProvingProvider = { check: (preimage, location) => zkir.check(preimage, location), prove: async () => proof };
  return (await tx.prove(stub, L.CostModel.initialCostModel())).bind().serialize();
}
