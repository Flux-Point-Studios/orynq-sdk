import * as rt from "@midnight-ntwrk/compact-runtime";
import * as L8 from "@midnight-ntwrk/ledger-v8";
import * as L9 from "@midnightntwrk/ledger-v9";
import { Contract, ledger, type HiddenEntry, type Ledger } from "../contract/managed/contract/index.js";

export type { HiddenEntry };
export type RegistryCallArgs = { circuit: "anchor"; args: [commitment: Uint8Array, kind: bigint] } | { circuit: "anchor_hiding"; args: [attribute: Uint8Array] };

// The circuit's private inputs. They stay in the witness closures: only the proof and the
// disclosed values leave the circuit.
export interface RegistryWitnesses {
  authorSecret: Uint8Array;
  hiddenEntry?: HiddenEntry;
}

interface RegistryCall<S> {
  networkId: string;
  address: string;
  state: S;
  call: RegistryCallArgs;
  witnesses: RegistryWitnesses;
  ttl: Date;
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
//
// The ledger that reads `state` builds the transaction. Against the ledger 8 state it is a ledger
// 8 transaction[v9], partitioned with ledger 8's initial parameters unless others are given.
// Against the ledger 9 state a ledger 9 network holds for the registry it is a ledger 9
// transaction[v12] carrying the ledger 8 circuit's transcript, which ledger 9's cost model
// partitions: with the chain's parameters, as `parameters`, since ledger 9 prices the same
// program differently.
export function unprovenRegistryCall(options: RegistryCall<L8.ContractState> & { parameters?: L8.LedgerParameters }): Ledger8RegistryCall;
export function unprovenRegistryCall(options: RegistryCall<L9.ContractState> & { parameters: L9.LedgerParameters }): Ledger9RegistryCall;
export function unprovenRegistryCall(options: RegistryCall<L8.ContractState | L9.ContractState> & { parameters?: L8.LedgerParameters | L9.LedgerParameters }): Ledger8RegistryCall | Ledger9RegistryCall;
export function unprovenRegistryCall({ networkId, address, state, call, witnesses, ttl, parameters }: RegistryCall<L8.ContractState | L9.ContractState> & { parameters?: L8.LedgerParameters | L9.LedgerParameters }) {
  const contract = registryContract(witnesses);
  const circuitState = new rt.ContractState();
  circuitState.data = new rt.ChargedState(rt.StateValue.decode(state.data.state.encode()));
  const context = rt.createCircuitContext(address, "00".repeat(32), circuitState, undefined);
  const result =
    call.circuit === "anchor" ? contract.circuits.anchor(context, ...call.args) : contract.circuits.anchor_hiding(context, ...call.args);
  const after = ledger(result.context.currentQueryContext.state) as Ledger;
  if (state instanceof L9.ContractState) {
    if (!(parameters instanceof L9.LedgerParameters)) throw new Error("a call against a ledger 9 state is partitioned with the chain's ledger 9 parameters");
    return assemble(L9, { networkId, address, state, call, ttl, parameters, result, after, query: context.currentQueryContext });
  }
  if (parameters !== undefined && !(parameters instanceof L8.LedgerParameters)) throw new Error("a call against a ledger 8 state is partitioned with ledger 8 parameters");
  return assemble(L8, { networkId, address, state, call, ttl, parameters: parameters ?? L8.LedgerParameters.initialParameters(), result, after, query: context.currentQueryContext });
}

type CircuitResult = ReturnType<ReturnType<typeof registryContract>["circuits"]["anchor"]>;
interface BuiltCall<T, Transcript> {
  tx: T;
  result: CircuitResult;
  after: Ledger;
  guaranteed: Transcript | undefined;
  fallible: Transcript | undefined;
}
export type Ledger8RegistryCall = BuiltCall<L8.UnprovenTransaction, L8.Transcript<L8.AlignedValue>>;
export type Ledger9RegistryCall = BuiltCall<L9.UnprovenTransaction, L9.Transcript<L9.AlignedValue>>;

// The query context the circuit left, read into `L`, partitions the public transcript under
// `parameters`; `state`'s own operation for the circuit carries the verifier key. Both ledgers'
// call-building API has one shape, typed here as ledger 9's.
function assemble(
  L: typeof L8 | typeof L9,
  { networkId, address, state, call, ttl, parameters, result, after, query }: {
    networkId: string; address: string; state: L8.ContractState | L9.ContractState; call: RegistryCallArgs; ttl: Date;
    parameters: L8.LedgerParameters | L9.LedgerParameters; result: CircuitResult; after: Ledger; query: rt.QueryContext;
  },
): Ledger8RegistryCall | Ledger9RegistryCall {
  const X = L as typeof L9;
  const ledgerQuery = new X.QueryContext(new X.ChargedState(X.StateValue.decode(query.state.state.encode())), query.address);
  ledgerQuery.block = query.block as unknown as L9.CallContext;
  ledgerQuery.effects = query.effects as unknown as L9.Effects;
  const pre = new X.PreTranscript(ledgerQuery, result.proofData.publicTranscript as unknown as L9.Op<L9.AlignedValue>[]);
  const [guaranteed, fallible] = X.partitionTranscripts([pre], parameters as L9.LedgerParameters)[0]!;
  const operation = (state as L9.ContractState).operation(call.circuit);
  if (!operation) throw new Error(`no operation ${call.circuit} on the registry`);
  const prototype = new X.ContractCallPrototype(
    address,
    call.circuit,
    operation,
    guaranteed,
    fallible,
    result.proofData.privateTranscriptOutputs as unknown as L9.AlignedValue[],
    result.proofData.input as unknown as L9.AlignedValue,
    result.proofData.output as unknown as L9.AlignedValue,
    X.communicationCommitmentRandomness(),
    call.circuit,
  );
  const tx = X.Transaction.fromParts(networkId, undefined, undefined, X.Intent.new(ttl).addCall(prototype));
  return { tx, result, after, guaranteed, fallible };
}
