import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as L from "@midnight-ntwrk/ledger-v8";
import * as rt from "@midnight-ntwrk/compact-runtime";
import { buildProofDeploy, buildProofCall, proofInitialState, presentationId } from "../src/onchain.js";
import { proofProvider } from "../src/proof-material.js";
import { assertPostedProof } from "../src/posted.js";
import { ledger } from "../onchain/managed/contract/index.js";

const params = process.env["ORYNQ_MIDNIGHT_PARAMS_DIR"];
if (!params) throw new Error("ORYNQ_MIDNIGHT_PARAMS_DIR must name pinned local parameters");
const record = process.argv.includes("--record");
const out = resolve(import.meta.dirname, "../native/tests/fixtures/onchain");
const timestamp = Math.floor(Date.now() / 1000);
const deadline = timestamp + 3500;
const ttl = new Date(deadline * 1000);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const capability = new Uint8Array(32).fill(19);
const contextDigest = hash("orynq:onchain:synthetic-integration");
const capabilityStatement = { circuit: "proveCapability" as const, contextDigest, notAfter: deadline, commitment: createHash("sha256").update(capability).update(Buffer.from(contextDigest, "hex")).digest("hex") };
const eventDigest = hash("synthetic event");
const genesisHash = hash("synthetic genesis");
const rollingStatement = { circuit: "proveRolling1" as const, contextDigest, notAfter: deadline, genesisHash, rootHash: hash(`poi-trace:roll:v1|${genesisHash}|${eventDigest}`), anchorHash: hash("synthetic anchor") };
const provider = proofProvider(params);
const native = process.env["ORYNQ_MIDNIGHT_NATIVE_VERIFIER"] ?? resolve(import.meta.dirname, "../native/target/release/orynq-midnight-verifier");
const strictness = new L.WellFormedStrictness();
strictness.enforceBalancing = false;
const block = { secondsSinceEpoch: BigInt(timestamp), secondsSinceEpochErr: 0, parentBlockHash: "0".repeat(64), lastBlockTime: BigInt(timestamp - 1) };
let state = L.LedgerState.blank("preprod");
const write = async (name: string, data: Uint8Array | string) => { if (record) { await mkdir(out, { recursive: true }); await writeFile(resolve(out, name), data); } };
await write("blank.bin", state.serialize());
const deploy = buildProofDeploy("preprod", ttl);
const finalDeploy = (await deploy.tx.prove(provider, L.CostModel.initialCostModel())).bind();
const apply = (tx: L.FinalizedTransaction) => {
  const [next, result] = state.apply(tx.wellFormed(state, strictness, new Date(timestamp * 1000)), new L.TransactionContext(state, block));
  assert.equal(result.type, "success");
  state = next;
};
apply(finalDeploy);
await write("deploy.bin", finalDeploy.serialize());
await write("deployed.bin", state.serialize());
const referenceStateBase64 = Buffer.from(state.serialize()).toString("base64");
const evidence: Array<{ circuit: string; txHash: string; bytes: number }> = [];
// Both calls are built against the initial state before either one changes the ledger.
const calls = [
  { statement: capabilityStatement, witness: { capability } },
  { statement: rollingStatement, witness: { eventDigest } },
].map(input => ({ ...input, built: buildProofCall({ ...input, state: proofInitialState(), network: "preprod", address: deploy.address }) }));
for (const { statement, built } of calls) {
  const tx = (await built.tx.prove(provider, L.CostModel.initialCostModel())).bind();
  const bytes = tx.serialize();
  const verification = spawnSync(native, ["--registry", resolve(import.meta.dirname, "../onchain/registry.json")], { input: JSON.stringify({ circuitId: statement.circuit, transactionBase64: Buffer.from(bytes).toString("base64"), referenceStateBase64, verificationTimeUnixSeconds: Math.floor(Date.now() / 1000) }), encoding: "utf8", timeout: 60_000 });
  assert.equal(verification.status, 0, "native proof verification failed");
  assert.deepEqual(JSON.parse(verification.stdout), { valid: true, code: "verified" });
  assertPostedProof(bytes, deploy.address, statement, timestamp * 1000);
  assert(!Buffer.from(bytes).includes(Buffer.from(capability)), "capability leaked");
  assert(!Buffer.from(bytes).includes(Buffer.from(eventDigest, "ascii")), "event witness leaked");
  apply(tx);
  await write(`${statement.circuit}.bin`, bytes);
  evidence.push({ circuit: statement.circuit, txHash: tx.transactionHash(), bytes: bytes.length });
  console.log(`${statement.circuit}: real proof generated; local ledger applied`);
}
const final = state.index(deploy.address);
assert(final);
const records = ledger(rt.ContractState.deserialize(final.serialize()).data).presentations;
assert.equal(records.size(), 2n);
assert(records.member(presentationId(capabilityStatement)));
assert(records.member(presentationId(rollingStatement)));
await write("final.bin", state.serialize());
await write("fixture.json", JSON.stringify({ timestamp, deadline, address: deploy.address, deployTxHash: finalDeploy.transactionHash(), calls: evidence }, null, 2) + "\n");
console.log("Two independent calls retain both records; this is a local ledger rehearsal, not network finality");
