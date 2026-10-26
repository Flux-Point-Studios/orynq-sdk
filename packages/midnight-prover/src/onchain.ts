import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as rt from "@midnight-ntwrk/compact-runtime";
import * as L from "@midnight-ntwrk/ledger-v8";
import { Contract, ledger, pureCircuits, type Presentation } from "../onchain/managed/contract/index.js";

export type ProofStatement = {
  contextDigest: string;
  notAfter: number;
} & ({ circuit: "proveCapability"; commitment: string } | {
  circuit: "proveRolling1"; genesisHash: string; rootHash: string; anchorHash: string;
});
export type ProofWitness = { capability: Uint8Array } | { eventDigest: string };
export type ProofNetwork = "mainnet" | "preprod";
export const PROOF_CIRCUITS = ["proveCapability", "proveRolling1"] as const;
export const PROOF_PINS = Object.freeze(JSON.parse(readFileSync(new URL("../onchain/pins.json", import.meta.url), "utf8")) as {
  codeHash: string; initialStateSha256: string; verifierKeys: Record<typeof PROOF_CIRCUITS[number], string>; files: Record<string, string>;
});

export function proofArtifact(path: string): Uint8Array {
  const pin = PROOF_PINS.files[path];
  if (!pin || path.split("/").includes("..")) throw new Error("Unpinned proof artifact");
  const bytes = new Uint8Array(readFileSync(new URL(`../onchain/managed/${path}`, import.meta.url)));
  if (createHash("sha256").update(bytes).digest("hex") !== pin) throw new Error("Proof artifact differs from its pin");
  return bytes;
}

export function proofInitialState(): L.ContractState {
  return L.ContractState.deserialize(proofArtifact("initial-state.bin"));
}

export function assertProofDeploy(bytes: Uint8Array, stage: "unproven" | "final"): string {
  const tx = stage === "unproven" ? L.Transaction.deserialize("signature", "pre-proof", "pre-binding", bytes) : L.Transaction.deserialize("signature", "proof", "binding", bytes);
  if (!Buffer.from(tx.serialize()).equals(Buffer.from(bytes))) throw new Error("Noncanonical deploy transaction");
  const actions = [...(tx.intents?.values() ?? [])].flatMap(intent => intent.actions);
  if (actions.length !== 1 || !(actions[0] instanceof L.ContractDeploy)) throw new Error("Expected exactly one proof contract deploy");
  if (!Buffer.from(actions[0].initialState.serialize()).equals(Buffer.from(proofInitialState().serialize()))) throw new Error("Deploy differs from the pinned proof state");
  return String(actions[0].address);
}

export function buildProofDeploy(network: ProofNetwork, ttl: Date): { tx: L.UnprovenTransaction; address: string } {
  const deploy = new L.ContractDeploy(proofInitialState());
  const tx = L.Transaction.fromParts(network, undefined, undefined, L.Intent.new(ttl).addDeploy(deploy));
  return { tx, address: assertProofDeploy(tx.serialize(), "unproven") };
}

function bytes32(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Expected a canonical SHA-256 digest");
  return new Uint8Array(Buffer.from(value, "hex"));
}

export function presentation(statement: ProofStatement): Presentation {
  if (!Number.isSafeInteger(statement.notAfter) || statement.notAfter < 0) throw new Error("Invalid proof deadline");
  const common = { contextDigest: bytes32(statement.contextDigest), notAfter: BigInt(statement.notAfter) };
  if (statement.circuit === "proveCapability") return { ...common, kind: 2n, genesisHash: new Uint8Array(64), rootHash: new Uint8Array(32), anchorHash: new Uint8Array(32), commitment: bytes32(statement.commitment) };
  if (statement.circuit !== "proveRolling1") throw new Error("Unknown proof circuit");
  return { ...common, kind: 1n, genesisHash: new TextEncoder().encode(statement.genesisHash), rootHash: bytes32(statement.rootHash), anchorHash: bytes32(statement.anchorHash), commitment: new Uint8Array(32) };
}

export function presentationId(statement: ProofStatement): Uint8Array {
  return pureCircuits.presentationId(presentation(statement));
}

export function buildProofCall({ network, address, statement, witness }: { network: ProofNetwork; address: string; statement: ProofStatement; witness: ProofWitness }) {
  bytes32(address);
  const record = presentation(statement);
  const state = proofInitialState();
  const contract = new Contract<undefined>({
    capability: ({ privateState }) => {
      if (!("capability" in witness) || witness.capability.length !== 32) throw new Error("A 32-byte capability is required");
      return [privateState, witness.capability];
    },
    eventDigestHex: ({ privateState }) => {
      if (!("eventDigest" in witness)) throw new Error("An event digest is required");
      return [privateState, new TextEncoder().encode(witness.eventDigest)];
    },
  });
  const context = rt.createCircuitContext(address, "00".repeat(32), rt.ContractState.deserialize(state.serialize()), undefined);
  const result = statement.circuit === "proveCapability"
    ? contract.circuits.proveCapability(context, record.commitment, record.contextDigest, record.notAfter)
    : contract.circuits.proveRolling1(context, record.genesisHash, record.rootHash, record.anchorHash, record.contextDigest, record.notAfter);
  const query = context.currentQueryContext;
  const ledgerQuery = new L.QueryContext(new L.ChargedState(L.StateValue.decode(query.state.state.encode())), address);
  ledgerQuery.block = query.block;
  ledgerQuery.effects = query.effects;
  const operation = state.operation(statement.circuit);
  if (!operation) throw new Error("Missing pinned proof operation");
  const call = new L.PrePartitionContractCall(address, statement.circuit, operation,
    new L.PreTranscript(ledgerQuery, result.proofData.publicTranscript), result.proofData.privateTranscriptOutputs,
    result.proofData.input, result.proofData.output, L.communicationCommitmentRandomness(), statement.circuit);
  const ttl = new Date(statement.notAfter * 1000);
  const tx = L.Transaction.fromParts(network).addCalls({ tag: "first" }, [call], L.LedgerParameters.initialParameters(), ttl);
  return { tx, after: ledger(result.context.currentQueryContext.state), program: result.proofData.publicTranscript, ttl };
}
