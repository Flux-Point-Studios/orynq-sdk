import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { RealMidnightProver } from "../src/real-prover.js";

const packageDir = resolve(import.meta.dirname, "..");
const prover = new RealMidnightProver({
  artifactsDir: resolve(packageDir, "managed"),
  nativeVerifierPath: process.env["ORYNQ_MIDNIGHT_NATIVE_VERIFIER"] ?? resolve(packageDir, "native/target/release/orynq-midnight-verifier"),
  paramsDir: process.env["ORYNQ_MIDNIGHT_PARAMS_DIR"] ?? resolve(packageDir, "managed/params"),
});
const capability = randomBytes(32);
const originalCapability = Buffer.from(capability);
const contextDigest = createHash("sha256").update("synthetic approved task").digest("hex");
const commitment = createHash("sha256").update(capability).update(Buffer.from(contextDigest, "hex")).digest("hex");
const proof = await prover.proveCapability({ capability, contextDigest, commitment });
assert.equal(await prover.verify(proof), true, "genuine capability proof rejected");
assert.equal(await prover.verify({ ...proof, simulation: true }), false);
assert.equal(await prover.verify({ ...proof, publicInputs: { ...proof.publicInputs, contextDigest: "00".repeat(32) } }), false);
assert.equal(await prover.verify({ ...proof, publicInputs: { ...proof.publicInputs, commitment: "00".repeat(32) } }), false);
const corrupted = Buffer.from(proof.transactionBase64, "base64");
corrupted[corrupted.length - 70] = (corrupted[corrupted.length - 70] ?? 0) ^ 1;
assert.equal(await prover.verify({ ...proof, transactionBase64: corrupted.toString("base64") }), false);
assert.deepEqual(capability, originalCapability, "proving changed the caller's witness");
assert.equal(Buffer.from(proof.transactionBase64, "base64").includes(originalCapability), false);
await assert.rejects(prover.proveCapability({ capability: randomBytes(32), contextDigest, commitment }));

const genesisHash = "01".repeat(32);
const eventHashes = ["02".repeat(32), "03".repeat(32)];
const rootHash = eventHashes.reduce((previous, hash) => createHash("sha256").update(`poi-trace:roll:v1|${previous}|${hash}`).digest("hex"), genesisHash);
const chain = await prover.proveRollingHashChain({ eventHashes, genesisHash, rootHash, anchorHash: "04".repeat(32), contextDigest });
assert.equal(await prover.verify(chain), true);
assert.equal(await prover.verify({ ...chain, publicInputs: { ...chain.publicInputs, eventCount: 1 } }), false);
assert.equal(await prover.verify({ ...chain, publicInputs: { ...chain.publicInputs, anchorHash: "05".repeat(32) } }), false);
assert.equal(await prover.verify({ ...chain, links: [...chain.links].reverse() }), false);
assert.equal(JSON.stringify(chain).includes(eventHashes[0]!), false);
assert.deepEqual({
  snapshotVersion: await prover.verify({ ...proof, toJSON: () => ({ ...proof, version: 2 }) }),
  snapshotSimulation: await prover.verify({ ...proof, toJSON: () => ({ ...proof, simulation: true }) }),
  nestedSimulation: await prover.verify({ ...chain, links: chain.links.map(link => ({ ...link, simulation: true })) }),
}, { snapshotVersion: false, snapshotSimulation: false, nestedSimulation: false });
capability.fill(0);
originalCapability.fill(0);
console.log(JSON.stringify({ genuineCapability: true, genuineRollingChain: true, tamperingRejected: true, privateWitnessAbsent: true }));
