import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import * as runtime from "@midnight-ntwrk/compact-runtime";
import * as ledger from "@midnightntwrk/ledger-v8";
import { provingProvider } from "@midnightntwrk/zkir-v2";
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
// columns no longer match the compiled source map, so it names none.
async function loadStripped(unit: string): Promise<UnitModule> {
  const file = contractFile(unit);
  const { source, removed } = stripAsserts(generatedSource(unit).replace(/^\/\/# sourceMappingURL=.*$/m, ""));
  if (removed === 0) throw new Error(`no generated assertions to strip in ${unit}`);
  const stripped = join(file, "../index.stripped.js");
  const temp = `${stripped}.${randomUUID()}`;
  writeFileSync(temp, source);
  renameSync(temp, stripped);
  return import(pathToFileURL(stripped).href);
}

export function outcome(run: () => unknown): Outcome {
  try {
    return Number(run());
  } catch (error) {
    return { throws: (error as Error).message };
  }
}

function callCircuit(module: UnitModule, name: string, witnesses: object, args: readonly unknown[]) {
  const contract = new module.Contract(witnesses);
  const coinKey = ledger.sampleCoinPublicKey();
  const initial = contract.initialState(runtime.createConstructorContext(undefined, coinKey));
  const state = ledger.ContractState.deserialize(initial.currentContractState.serialize());
  state.setOperation(name, new ledger.ContractOperation());
  const address = new ledger.ContractDeploy(state).address;
  const context = runtime.createCircuitContext(address, coinKey, initial.currentContractState as never, undefined);
  const circuit = contract.circuits[name];
  if (typeof circuit !== "function") throw new TypeError(`contract.circuits.${name} is not a function`);
  return { state, address, data: circuit(context, ...args).proofData };
}

export async function runCircuit(unit: string, name: string, witnesses: object, args: readonly unknown[]): Promise<ProofData> {
  return callCircuit(await loadUnit(unit), name, witnesses, args).data;
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
