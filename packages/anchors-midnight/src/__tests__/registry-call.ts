import { readFileSync } from "node:fs";
import * as L from "@midnightntwrk/ledger-v8";
import * as L9 from "@midnightntwrk/ledger-v9";
import { provingProvider } from "@midnightntwrk/zkir-v2";
import { unprovenRegistryCall as buildCall, type RegistryCallArgs, type RegistryWitnesses } from "../registry-call.js";
import { buildRegistryDeploy, registryInitialState } from "../registry.js";

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

// A ledger 9 network holding the registry as the fork left it: buildRegistryDeploy's initial state,
// its operations carrying the same ledger 8 verifier keys, deployed on a blank ledger 9 state.
export function deployedRegistry9(networkId = NETWORK, now = new Date()) {
  const initial = registryInitialState();
  const state = new L9.ContractState();
  state.data = new L9.ChargedState(L9.StateValue.decode(initial.data.state.encode()));
  for (const name of ["anchor", "anchor_hiding"]) {
    const op = new L9.ContractOperation();
    op.verifierKey = initial.operation(name)!.verifierKey;
    state.setOperation(name, op);
  }
  state.maintenanceAuthority = new L9.ContractMaintenanceAuthority([], 1, 0n);
  const deploy = new L9.ContractDeploy(state);
  const tx = L9.Transaction.fromParts(networkId, undefined, undefined, L9.Intent.new(new Date(now.getTime() + 3600e3)).addDeploy(deploy));
  const blank = L9.LedgerState.blank(networkId);
  const [ledger] = blank.apply(tx.eraseProofs().wellFormed(blank, ledger9Strictness(), now), ledger9Context(blank, now));
  const address = String(deploy.address);
  return { address, state: ledger.index(address)!, ledger, parameters: L9.LedgerParameters.initialParameters() };
}

// Well-formedness without balancing or proofs: what the shape of a transaction alone decides.
export function ledger9Strictness() {
  const strictness = new L9.WellFormedStrictness();
  strictness.enforceBalancing = false;
  strictness.verifyNativeProofs = false;
  strictness.verifyContractProofs = false;
  return strictness;
}

export function ledger9Context(state: L9.LedgerState, now: Date) {
  const seconds = BigInt(Math.floor(now.getTime() / 1000));
  return new L9.TransactionContext(state, { secondsSinceEpoch: seconds, secondsSinceEpochErr: 30, parentBlockHash: "00".repeat(32), lastBlockTime: seconds - 6n } as ConstructorParameters<typeof L9.TransactionContext>[1]);
}

// finalBytes for a ledger 9 transaction: zkir checks the ledger 8 circuit's preimage as ledger 9
// writes it, and the recorded registry proof stands in for every proof.
export async function finalBytes9(tx: L9.UnprovenTransaction): Promise<Uint8Array> {
  const zkir = registryProvider();
  const proof = new Uint8Array(recordedProof());
  const stub: L9.ProvingProvider = { check: (preimage, location) => zkir.check(preimage, location), prove: async () => proof, lookupKey: registryKeys.lookupKey };
  return (await tx.prove(stub, L9.CostModel.initialCostModel())).bind().serialize();
}

// unprovenRegistryCall for the test network, with a TTL an hour out unless one is given.
export function unprovenRegistryCall(options: { address: string; state: L.ContractState; call: RegistryCallArgs; witnesses: RegistryWitnesses; ttl?: Date }) {
  return buildCall({ networkId: NETWORK, ttl: new Date(Date.now() + 3600e3), ...options });
}

const V9_HEADER = "midnight:transaction[v9](signature[v1],proof,pedersen-schnorr[v1]):";
const V12_HEADER = "midnight:transaction[v12](signature[v2],proof,pedersen-schnorr[v1]):";
// Ledger 8 bytes under ledger 9's header, which ledger 9 reads as another transaction.
export const relabelled = (bytes: Uint8Array) => new Uint8Array(Buffer.from(Buffer.from(bytes).toString("latin1").replace(V9_HEADER, V12_HEADER), "latin1"));

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
const registryKeys = {
  async lookupKey(location: string) {
    const read = (rel: string) => new Uint8Array(readFileSync(new URL(rel, managed)));
    return { proverKey: read(`keys/${location}.prover`), verifierKey: read(`keys/${location}.verifier`), ir: read(`zkir/${location}.bzkir`) };
  },
  async getParams(): Promise<Uint8Array> {
    throw new Error("finalBytes never proves");
  },
};
const registryProvider = () => provingProvider(registryKeys);
export async function finalBytes(tx: L.UnprovenTransaction): Promise<Uint8Array> {
  const zkir = registryProvider();
  const proof = new Uint8Array(recordedProof());
  const stub: L.ProvingProvider = { check: (preimage, location) => zkir.check(preimage, location), prove: async () => proof };
  return (await tx.prove(stub, L.CostModel.initialCostModel())).bind().serialize();
}
