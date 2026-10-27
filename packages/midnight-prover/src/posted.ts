import { isDeepStrictEqual } from "node:util";
import * as L from "@midnight-ntwrk/ledger-v8";
import * as rt from "@midnight-ntwrk/compact-runtime";
import { verifyFinalizedTransaction, type MidnightSource, type FinalityCheckpoint } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { ledger } from "../onchain/managed/contract/index.js";
import { assertProofDeploy, presentation, presentationId, proofInitialState, type ProofStatement, type ProofNetwork } from "./onchain.js";

// This decodes a claim. Cryptographic acceptance comes only after authenticated chain execution.
export function assertPostedProof(bytes: Uint8Array, address: string, statement: ProofStatement, timestamp: number): void {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp >= statement.notAfter * 1000) throw new Error("Proof deadline passed at the authenticated block time");
  const tx = L.Transaction.deserialize("signature", "proof", "binding", bytes);
  if (!Buffer.from(tx.serialize()).equals(Buffer.from(bytes))) throw new Error("Noncanonical proof transaction");
  const actions = [...(tx.intents?.values() ?? [])].flatMap(intent => intent.actions);
  if (actions.length !== 1 || !(actions[0] instanceof L.ContractCall)) throw new Error("Expected exactly one proof call");
  const call = actions[0];
  if (String(call.address) !== address) throw new Error("Wrong proof contract");
  const entryPoint = typeof call.entryPoint === "string" ? call.entryPoint : Buffer.from(call.entryPoint).toString("utf8");
  if (entryPoint !== statement.circuit) throw new Error("Wrong proof circuit");
  if (call.fallibleTranscript || !call.guaranteedTranscript) throw new Error("Proof requires one guaranteed transcript");
  const state = proofInitialState();
  const query = new L.QueryContext(state.data, address);
  const seconds = BigInt(Math.floor(timestamp / 1000));
  query.block = { ...query.block, secondsSinceEpoch: seconds, secondsSinceEpochErr: 0, lastBlockTime: seconds - 1n };
  const after = query.runTranscript(call.guaranteedTranscript, L.CostModel.initialCostModel());
  const result = ledger(rt.StateValue.decode(after.state.state.encode()));
  if (result.presentations.size() !== 1n || !result.presentations.member(presentationId(statement)) || !isDeepStrictEqual(result.presentations.lookup(presentationId(statement)), presentation(statement))) throw new Error("Transaction does not record the expected proof statement");
}

export interface PostedProofRequest {
  network: ProofNetwork;
  address: string;
  deployTxHash: string;
  txHash: string;
  statement: ProofStatement;
}

export interface ProofTrustRoot {
  genesis: string;
  checkpoints: readonly FinalityCheckpoint[];
}

const GENESIS: Record<ProofNetwork, string> = {
  mainnet: "1941ca8e2bb88146c14dea084d3be7eb6e96ca7135429c543848b628124f2854",
  preprod: "df831b09a8baa92badf47762ce5ac439b7e47e3ed3d39600cfdd44fad552361b",
};

export async function verifyPosted(request: PostedProofRequest, options: { source: MidnightSource; trustRoot: ProofTrustRoot }) {
  if (!Object.hasOwn(GENESIS, request.network) || !options.trustRoot || options.trustRoot.genesis !== GENESIS[request.network]) throw new Error("Proof trust-root genesis mismatch");
  if (options.trustRoot.checkpoints.length === 0) throw new Error("An independently trusted finality checkpoint is required");
  if (options.source.network !== request.network) throw new Error("Proof source network mismatch");
  const verification = { source: options.source, checkpoints: options.trustRoot.checkpoints };
  const deploy = await verifyFinalizedTransaction(request.deployTxHash, verification);
  if (assertProofDeploy(deploy.bytes, "final") !== request.address) throw new Error("Proof deployment address mismatch");
  const call = await verifyFinalizedTransaction(request.txHash, verification);
  // Ledger 8 has no network getter; merging an empty transaction checks its encoded network id.
  const network = L.Transaction.fromParts(request.network).eraseProofs();
  for (const { bytes } of [deploy, call]) L.Transaction.deserialize("signature", "proof", "binding", bytes).eraseProofs().merge(network);
  if (deploy.block.height > call.block.height || (deploy.block.height === call.block.height && (deploy.block.hash !== call.block.hash || deploy.extrinsicIndex >= call.extrinsicIndex))) throw new Error("Proof call precedes its deployment");
  assertPostedProof(call.bytes, request.address, request.statement, call.timestamp);
  return { valid: true as const, assurance: "consensus-verified" as const, txHash: request.txHash, address: request.address, block: call.block, timestamp: call.timestamp, presentationId: Buffer.from(presentationId(request.statement)).toString("hex"), statement: request.statement };
}
