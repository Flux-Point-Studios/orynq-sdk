import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import * as runtime from "@midnight-ntwrk/compact-runtime";
import * as ledger from "@midnight-ntwrk/ledger-v8";
import { provingProvider } from "@midnight-ntwrk/zkir-v2";
import { withFixtureProof } from "../fixture-prover.js";

const managed = resolve(import.meta.dirname, "../../conduct-managed");
const circuits = resolve(import.meta.dirname, "../../circuits/conduct");
const ASSERT_CALL = "__compactRuntime.assert(";

export interface ProofData {
  input: { value: Uint8Array[]; alignment: unknown[] };
  output: unknown;
  publicTranscript: unknown[];
  privateTranscriptOutputs: unknown[];
}

interface CompiledContract {
  initialState(context: unknown): { currentContractState: { serialize(): Uint8Array } };
  readonly circuits: Record<string, (context: unknown, ...args: unknown[]) => { proofData: ProofData }>;
}

export interface UnitModule {
  readonly Contract: new (witnesses: object) => CompiledContract;
  readonly pureCircuits: Record<string, (...args: unknown[]) => bigint>;
  readonly ledger: (state: runtime.StateValue) => Record<string, unknown>;
}

export type Outcome = number | { readonly throws: string };

// CONDUCT_<UNIT>_UNIT swaps a unit for a discrimination mutant, so a test can prove it fails against one.
export function unitDir(unit: string): string {
  const override = /^[a-z]+$/.test(unit) ? process.env[`CONDUCT_${unit.toUpperCase()}_UNIT`] : undefined;
  if (override === undefined) return join(managed, unit);
  const dir = resolve(managed, override);
  if (!dir.startsWith(join(managed, "mutants") + sep)) throw new Error(`CONDUCT_${unit.toUpperCase()}_UNIT must name a directory under conduct-managed/mutants/`);
  return dir;
}

function contractFile(unit: string): string {
  const file = join(unitDir(unit), "contract/index.js");
  if (!existsSync(file)) throw new Error("conduct circuits not compiled: run pnpm --filter @fluxpointstudios/orynq-sdk-midnight-prover build:circuits");
  return file;
}

export async function loadUnit(unit: string): Promise<UnitModule> {
  return import(pathToFileURL(contractFile(unit)).href);
}

export function generatedSource(unit: string): string {
  return readFileSync(contractFile(unit), "utf8");
}

/** A Compact source file of a predicate unit: the committed file, or the edited copy a mutant was compiled from. */
export function unitSource(unit: string, file: string): string {
  const dir = unitDir(unit);
  contractFile(unit);
  return readFileSync(join(dir === join(managed, "predicate") ? circuits : join(dir, "source"), file), "utf8");
}

export function stripAsserts(source: string): { source: string; removed: number } {
  return { source: source.replaceAll(ASSERT_CALL, "((_c, _m) => {})("), removed: source.split(ASSERT_CALL).length - 1 };
}

// The copy keeps every ZKIR constraint but none of the generated JS checks, so only `check` can refuse a forgery. Its
// columns no longer match the compiled source map, so it names none. Each compiled unit is stripped once per process.
const strippedUnits = new Map<string, Promise<UnitModule>>();
function loadStripped(unit: string): Promise<UnitModule> {
  const file = contractFile(unit);
  let module = strippedUnits.get(file);
  if (module === undefined) {
    const { source, removed } = stripAsserts(generatedSource(unit).replace(/^\/\/# sourceMappingURL=.*$/m, ""));
    if (removed === 0) throw new Error(`no generated assertions to strip in ${unit}`);
    const stripped = join(file, "../index.stripped.js");
    const temp = `${stripped}.${randomUUID()}`;
    writeFileSync(temp, source);
    renameSync(temp, stripped);
    module = import(pathToFileURL(stripped).href);
    strippedUnits.set(file, module);
  }
  return module;
}

export function outcome(run: () => unknown): Outcome {
  try {
    return Number(run());
  } catch (error) {
    return { throws: (error as Error).message };
  }
}

// A unit's initial state reads no witness, so every call of a unit shares one, and every call of a circuit one deployment
// of it: the state with the circuit's operation and its address.
interface Initial { readonly coinKey: string; readonly state: { serialize(): Uint8Array }; readonly deployments: Map<string, { state: ledger.ContractState; address: string }> }
const initials = new WeakMap<UnitModule, Initial>();

function initialOf(module: UnitModule, contract: CompiledContract): Initial {
  let initial = initials.get(module);
  if (initial === undefined) {
    const coinKey = ledger.sampleCoinPublicKey();
    initial = { coinKey, state: contract.initialState(runtime.createConstructorContext(undefined, coinKey)).currentContractState, deployments: new Map() };
    initials.set(module, initial);
  }
  return initial;
}

function callCircuit(module: UnitModule, name: string, witnesses: object, args: readonly unknown[]) {
  const contract = new module.Contract(witnesses);
  const initial = initialOf(module, contract);
  let deployment = initial.deployments.get(name);
  if (deployment === undefined) {
    const state = ledger.ContractState.deserialize(initial.state.serialize());
    state.setOperation(name, new ledger.ContractOperation());
    deployment = { state, address: new ledger.ContractDeploy(state).address };
    initial.deployments.set(name, deployment);
  }
  const context = runtime.createCircuitContext(deployment.address, initial.coinKey, initial.state as never, undefined);
  return { ...deployment, data: circuitOf(contract, name)(context, ...args).proofData };
}

function circuitOf(contract: CompiledContract, name: string) {
  const circuit = contract.circuits[name];
  if (typeof circuit !== "function") throw new TypeError(`contract.circuits.${name} is not a function`);
  return circuit;
}

export async function runCircuit(unit: string, name: string, witnesses: object, args: readonly unknown[]): Promise<ProofData> {
  return callCircuit(await loadUnit(unit), name, witnesses, args).data;
}

/** Runs a circuit in the generated JS and returns the ledger its call wrote: the disclosed statement. */
export async function runLedger(unit: string, name: string, witnesses: object, args: readonly unknown[]): Promise<Record<string, unknown>> {
  const module = await loadUnit(unit);
  const contract = new module.Contract(witnesses);
  const initial = initialOf(module, contract);
  const call = circuitOf(contract, name)(runtime.createCircuitContext(runtime.dummyContractAddress(), initial.coinKey, initial.state as never, undefined), ...args) as unknown as
    { context: { currentQueryContext: { state: runtime.StateValue } } };
  return module.ledger(call.context.currentQueryContext.state);
}

// `check` reads only the IR; the provider insists on key fields, and empty ones show no key or parameter is consulted.
export function conductProvider(unit: string) {
  const dir = unitDir(unit);
  return provingProvider({
    lookupKey: async name => ({ proverKey: new Uint8Array(0), verifierKey: new Uint8Array(0), ir: new Uint8Array(await readFile(join(dir, "zkir", `${name}.bzkir`))) }),
    getParams: async () => { throw new Error("conduct check must not load proving parameters"); },
  });
}

export interface PreparedCheck {
  readonly data: ProofData;
  /** Resolves to the ledger written by the proven call's guaranteed transcript: the disclosed statement. */
  check(): Promise<Record<string, unknown>>;
}

export async function prepareCheck(unit: string, name: string, witnesses: object, args: readonly unknown[]): Promise<PreparedCheck> {
  const module = await loadStripped(unit);
  const { state, address, data } = callCircuit(module, name, witnesses, args);
  return {
    data,
    async check() {
      const call = new ledger.PrePartitionContractCall(address, name, state.operation(name)!,
        new ledger.PreTranscript(new ledger.QueryContext(state.data, address), data.publicTranscript as never),
        data.privateTranscriptOutputs as never, data.input as never, data.output as never, ledger.communicationCommitmentRandomness(), name);
      const tx = ledger.Transaction.fromParts("undeployed").addCalls({ tag: "first" }, [call], ledger.LedgerParameters.initialParameters(), new Date(Date.now() + 3_600_000));
      const proven = await tx.prove(withFixtureProof(conductProvider(unit)), ledger.CostModel.initialCostModel());
      const [action, ...rest] = [...(proven.intents?.values() ?? [])].flatMap(intent => intent.actions);
      if (!(action instanceof ledger.ContractCall) || rest.length !== 0) throw new Error("expected exactly one contract call");
      if (!action.guaranteedTranscript || action.fallibleTranscript) throw new Error("expected one guaranteed transcript");
      const after = new ledger.QueryContext(state.data, address).runTranscript(action.guaranteedTranscript, ledger.CostModel.initialCostModel());
      return module.ledger(runtime.StateValue.decode(after.state.state.encode()));
    },
  };
}

export async function zkCheck(unit: string, name: string, witnesses: object, args: readonly unknown[]): Promise<Record<string, unknown>> {
  return (await prepareCheck(unit, name, witnesses, args)).check();
}
