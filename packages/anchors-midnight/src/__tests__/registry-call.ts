import * as rt from "@midnight-ntwrk/compact-runtime";
import * as L from "@midnight-ntwrk/ledger-v8";
import { Contract, ledger, type HiddenEntry, type Ledger } from "../../contract/managed/contract/index.js";
import { buildRegistryDeploy } from "../registry.js";

export const NETWORK = "undeployed";
export type Witnesses = { authorSecret: Uint8Array; hiddenEntry?: HiddenEntry };
type CallArgs = { circuit: "anchor"; args: [Uint8Array, bigint] } | { circuit: "anchor_hiding"; args: [Uint8Array] };

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

function registryContract({ authorSecret, hiddenEntry }: Witnesses) {
  return new Contract<undefined>({
    author_secret: ({ privateState }) => [privateState, authorSecret],
    hidden_entry: ({ privateState }) => {
      if (!hiddenEntry) throw new Error("hidden_entry witness requested without an entry");
      return [privateState, hiddenEntry];
    },
  });
}

// Runs one registry circuit against `state` at `address` and builds the unproven, unbalanced
// call transaction from it the way a submitter does: the circuit's public transcript is
// partitioned into guaranteed and fallible parts and wrapped in a ContractCallPrototype.
export function unprovenRegistryCall({
  address,
  state,
  call,
  witnesses,
  ttl = new Date(Date.now() + 3600e3),
}: {
  address: string;
  state: L.ContractState;
  call: CallArgs;
  witnesses: Witnesses;
  ttl?: Date;
}) {
  const contract = registryContract(witnesses);
  const context = rt.createCircuitContext(address, "00".repeat(32), rt.ContractState.deserialize(state.serialize()), undefined);
  const result =
    call.circuit === "anchor" ? contract.circuits.anchor(context, ...call.args) : contract.circuits.anchor_hiding(context, ...call.args);
  const query = context.currentQueryContext;
  const ledgerQuery = new L.QueryContext(new L.ChargedState(L.StateValue.decode(query.state.state.encode())), query.address);
  ledgerQuery.block = query.block;
  ledgerQuery.effects = query.effects;
  const pre = new L.PreTranscript(ledgerQuery, result.proofData.publicTranscript);
  const [guaranteed, fallible] = L.partitionTranscripts([pre], L.LedgerParameters.initialParameters())[0]!;
  const operation = state.operation(call.circuit);
  if (!operation) throw new Error(`no operation ${call.circuit} on the registry`);
  const prototype = new L.ContractCallPrototype(
    address,
    call.circuit,
    operation,
    guaranteed,
    fallible,
    result.proofData.privateTranscriptOutputs,
    result.proofData.input,
    result.proofData.output,
    L.communicationCommitmentRandomness(),
    call.circuit,
  );
  const tx = L.Transaction.fromParts(NETWORK, undefined, undefined, L.Intent.new(ttl).addCall(prototype));
  return { tx, result, after: ledger(result.context.currentQueryContext.state) as Ledger, guaranteed, fallible };
}

// The distinct op names of a transcript; a popeq would mean the circuit reads ledger state.
export function opNames(ops: ReadonlyArray<unknown>): string[] {
  return [...new Set(ops.map((op) => (typeof op === "string" ? op : Object.keys(op as object)[0]!)))].sort();
}
