import * as rt from "@midnight-ntwrk/compact-runtime";
import * as L from "@midnight-ntwrk/ledger-v8";
import { Contract, ledger, type HiddenEntry, type Ledger } from "../contract/managed/contract/index.js";

export type { HiddenEntry };
export type RegistryCallArgs = { circuit: "anchor"; args: [commitment: Uint8Array, kind: bigint] } | { circuit: "anchor_hiding"; args: [attribute: Uint8Array] };

// The circuit's private inputs. They stay in the witness closures: only the proof and the
// disclosed values leave the circuit.
export interface RegistryWitnesses {
  authorSecret: Uint8Array;
  hiddenEntry?: HiddenEntry;
}

function registryContract({ authorSecret, hiddenEntry }: RegistryWitnesses) {
  return new Contract<undefined>({
    author_secret: ({ privateState }) => [privateState, authorSecret],
    hidden_entry: ({ privateState }) => {
      if (!hiddenEntry) throw new Error("hidden_entry witness requested without an entry");
      return [privateState, hiddenEntry];
    },
  });
}

// Runs one registry circuit against `state` at `address` and builds the unproven, unbalanced
// call transaction for `networkId`: the circuit's public transcript, partitioned into its
// guaranteed and fallible parts, in a ContractCallPrototype. `after` is the registry's ledger
// as the call leaves it, which for anchor_hiding holds the commitment computed in-circuit.
export function unprovenRegistryCall({
  networkId,
  address,
  state,
  call,
  witnesses,
  ttl,
}: {
  networkId: string;
  address: string;
  state: L.ContractState;
  call: RegistryCallArgs;
  witnesses: RegistryWitnesses;
  ttl: Date;
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
  const tx = L.Transaction.fromParts(networkId, undefined, undefined, L.Intent.new(ttl).addCall(prototype));
  return { tx, result, after: ledger(result.context.currentQueryContext.state) as Ledger, guaranteed, fallible };
}
