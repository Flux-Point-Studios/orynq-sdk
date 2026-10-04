import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as rt from "@midnight-ntwrk/compact-runtime";
import * as L from "@midnight-ntwrk/ledger-v8";
import { Contract, ledger } from "../contract/managed/contract/index.js";

export const REGISTRY_SCHEMA = "orynq-anchor-registry:v1";
export const REGISTRY_CIRCUITS = ["anchor", "anchor_hiding"] as const;
export type RegistryCircuit = (typeof REGISTRY_CIRCUITS)[number];
export type VerifierKeys = Record<RegistryCircuit, Uint8Array>;

// sha256 of contract/managed/keys/<circuit>.verifier. An independent compile of the same
// circuits from a source without the exported pure circuits produced the same keys.
export const REGISTRY_VERIFIER_KEY_SHA256: Readonly<Record<RegistryCircuit, string>> = {
  anchor: "85dc57a4269dd3aceb82867ecc6c145ef5f679c6f51767f200250e7c075777c5",
  anchor_hiding: "081384ce20f2a726e1dd79c0bbfbaabb0fe756ffa15ae429be4cee30b47e790f",
};

const managed = new URL("../contract/managed/", import.meta.url);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

export function compiledVerifierKeys(): VerifierKeys {
  const read = (name: RegistryCircuit) => {
    const key = new Uint8Array(readFileSync(new URL(`keys/${name}.verifier`, managed)));
    const digest = createHash("sha256").update(key).digest("hex");
    if (digest !== REGISTRY_VERIFIER_KEY_SHA256[name]) {
      throw new Error(`${name}.verifier hashes to ${digest}, pinned ${REGISTRY_VERIFIER_KEY_SHA256[name]}`);
    }
    return key;
  };
  return { anchor: read("anchor"), anchor_hiding: read("anchor_hiding") };
}

// Parsing through ContractOperation validates the key and yields its canonical encoding
// (ledger 8.1.3 rejects trailing bytes), so compiler output and on-chain state compare equal
// exactly when they denote the same key.
export function canonicalVerifierKey(raw: Uint8Array): string {
  const op = new L.ContractOperation();
  op.verifierKey = raw;
  return hex(op.serialize());
}

// With no committee, a MaintenanceUpdate needs `threshold` signatures from committee members,
// so threshold 1 makes every update impossible, while threshold 0 admits an unsigned one.
// Counter 0 proves no update ever applied.
export function assertImmutableAuthority(authority: L.ContractMaintenanceAuthority): void {
  if (authority.committee.length !== 0) throw new Error(`committee must be empty, got ${authority.committee.length}`);
  if (authority.threshold !== 1) throw new Error(`threshold must be exactly 1, got ${authority.threshold}`);
  if (authority.counter !== 0n) throw new Error(`counter must be 0, got ${authority.counter}`);
}

export function assertRegistryState(state: L.ContractState, verifierKeys: VerifierKeys = compiledVerifierKeys()): void {
  assertImmutableAuthority(state.maintenanceAuthority);
  const ops = state.operations().map((o) => (typeof o === "string" ? o : Buffer.from(o).toString("utf8")));
  if ([...ops].sort().join() !== [...REGISTRY_CIRCUITS].sort().join()) {
    throw new Error(`operations must be exactly ${REGISTRY_CIRCUITS.join(",")}, got ${ops.join(",")}`);
  }
  for (const name of REGISTRY_CIRCUITS) {
    const op = state.operation(name);
    if (!op || hex(op.serialize()) !== canonicalVerifierKey(verifierKeys[name])) throw new Error(`verifier key mismatch for ${name}`);
  }
  const data = ledger(rt.ContractState.deserialize(state.serialize()).data);
  const schema = Buffer.from(data.schema).toString("utf8").replace(/\0+$/, "");
  if (schema !== REGISTRY_SCHEMA) throw new Error(`schema must be ${REGISTRY_SCHEMA}, got ${schema}`);
}

const refuseWitness = (name: string) => () => {
  throw new Error(`witness ${name} is not available while constructing the registry`);
};

export function registryInitialState(verifierKeys: VerifierKeys = compiledVerifierKeys()): L.ContractState {
  const contract = new Contract({ author_secret: refuseWitness("author_secret"), hidden_entry: refuseWitness("hidden_entry") });
  const init = contract.initialState(rt.createConstructorContext(undefined, "00".repeat(32)));
  const state = L.ContractState.deserialize(init.currentContractState.serialize());
  for (const name of REGISTRY_CIRCUITS) {
    const op = new L.ContractOperation();
    op.verifierKey = verifierKeys[name];
    state.setOperation(name, op);
  }
  state.maintenanceAuthority = new L.ContractMaintenanceAuthority([], 1, 0n);
  return state;
}

export type DeployStage = "unproven" | "final";

const decode = (bytes: Uint8Array, stage: DeployStage) =>
  stage === "unproven"
    ? L.Transaction.deserialize("signature", "pre-proof", "pre-binding", bytes)
    : L.Transaction.deserialize("signature", "proof", "binding", bytes);

// Decodes a deploy transaction from the exact bytes that will be (or were) submitted and
// refuses it unless it deploys exactly the registry state registryInitialState() builds,
// byte for byte, and touches no other contract. Returns the address it deploys to.
export function assertRegistryDeployBytes(bytes: Uint8Array, stage: DeployStage): string {
  const actions = [...(decode(bytes, stage).intents?.values() ?? [])].flatMap((intent) => intent.actions);
  const deploys = actions.filter((a): a is L.ContractDeploy => a instanceof L.ContractDeploy);
  if (deploys.length !== 1 || actions.length !== 1) {
    throw new Error(`a registry deploy carries exactly one contract action, a ContractDeploy; got ${actions.length} with ${deploys.length} deploys`);
  }
  const deploy = deploys[0]!;
  assertRegistryState(deploy.initialState);
  if (hex(deploy.initialState.serialize()) !== hex(registryInitialState().serialize())) {
    throw new Error("the deployed state differs from the registry's initial state");
  }
  return String(deploy.address);
}

export function buildRegistryDeploy({ networkId, ttl }: { networkId: string; ttl: Date }): { tx: L.UnprovenTransaction; address: string } {
  const deploy = new L.ContractDeploy(registryInitialState());
  const tx = L.Transaction.fromParts(networkId, undefined, undefined, L.Intent.new(ttl).addDeploy(deploy));
  const address = assertRegistryDeployBytes(tx.serialize(), "unproven");
  if (address !== String(deploy.address)) throw new Error(`the serialized deploy targets ${address}, built ${String(deploy.address)}`);
  return { tx, address };
}
