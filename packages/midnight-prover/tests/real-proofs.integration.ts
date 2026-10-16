import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as ledger from "@midnight-ntwrk/ledger-v8";
import { RealMidnightProver, type CircuitProof } from "../src/real-prover.js";
import { withCorruptedProof, withTtl } from "./tampering.js";

const packageDir = resolve(import.meta.dirname, "..");
const artifactsDir = resolve(packageDir, "managed");
const nativeVerifierPath = process.env["ORYNQ_MIDNIGHT_NATIVE_VERIFIER"] ?? resolve(packageDir, "native/target/release/orynq-midnight-verifier");
const prover = new RealMidnightProver({
  artifactsDir,
  nativeVerifierPath,
  paramsDir: process.env["ORYNQ_MIDNIGHT_PARAMS_DIR"] ?? resolve(packageDir, "managed/params"),
});
const nowSeconds = () => Math.floor(Date.now() / 1000);

function nativeCode(proof: CircuitProof): string {
  const request = { circuitId: proof.circuitId, transactionBase64: proof.transactionBase64, referenceStateBase64: proof.referenceStateBase64, verificationTimeUnixSeconds: nowSeconds() };
  const result = spawnSync(nativeVerifierPath, ["--registry", resolve(artifactsDir, "registry.json")], { input: JSON.stringify(request) });
  return (JSON.parse(result.stdout.toString("utf8")) as { code: string }).code;
}

function withLedgerTtl<T extends CircuitProof>(proof: T, globalTtlSeconds: bigint): T {
  const state = ledger.LedgerState.deserialize(Buffer.from(proof.referenceStateBase64, "base64"));
  const parameters = Buffer.from(state.parameters.serialize());
  const initial = Buffer.from(ledger.LedgerParameters.initialParameters().serialize());
  const oneHour = Buffer.from(new BigUint64Array([3600n]).buffer);
  const offset = initial.indexOf(oneHour);
  assert.ok(offset > 0 && initial.indexOf(oneHour, offset + 1) === -1 && parameters.equals(initial), "global_ttl not located");
  parameters.writeBigUInt64LE(globalTtlSeconds, offset);
  state.parameters = ledger.LedgerParameters.deserialize(parameters);
  return { ...proof, referenceStateBase64: Buffer.from(state.serialize()).toString("base64") };
}

const capability = randomBytes(32);
const originalCapability = Buffer.from(capability);
const contextDigest = createHash("sha256").update("synthetic approved task").digest("hex");
const commitment = createHash("sha256").update(capability).update(Buffer.from(contextDigest, "hex")).digest("hex");
const proof = await prover.proveCapability({ capability, contextDigest, commitment });
assert.equal(await prover.verify(proof), true, "genuine capability proof rejected");
assert.ok(proof.publicInputs.notAfter > nowSeconds() && proof.publicInputs.notAfter <= nowSeconds() + 3600, "default deadline is not within the next hour");
assert.equal(await prover.verify({ ...proof, simulation: true }), false);
assert.equal(await prover.verify({ ...proof, publicInputs: { ...proof.publicInputs, contextDigest: "00".repeat(32) } }), false);
assert.equal(await prover.verify({ ...proof, publicInputs: { ...proof.publicInputs, commitment: "00".repeat(32) } }), false);
assert.equal(await prover.verify({ ...proof, publicInputs: { ...proof.publicInputs, notAfter: proof.publicInputs.notAfter - 1 } }), false);
const corrupted = withCorruptedProof(proof);
assert.equal(nativeCode(corrupted), "invalid-proof");
assert.equal(await prover.verify(corrupted), false);
const craftedLedger = withLedgerTtl(withTtl(proof, nowSeconds() + 10 * 365 * 24 * 3600), 400_000_000n);
assert.equal(nativeCode(craftedLedger), "untrusted-state");
assert.equal(await prover.verify(craftedLedger), false);
assert.deepEqual(capability, originalCapability, "proving changed the caller's witness");
assert.equal(Buffer.from(proof.transactionBase64, "base64").includes(originalCapability), false);
await assert.rejects(prover.proveCapability({ capability: randomBytes(32), contextDigest, commitment }));
await assert.rejects(prover.proveCapability({ capability, contextDigest, commitment, notAfter: nowSeconds() + 3601 }), /notAfter/);
await assert.rejects(prover.proveCapability({ capability, contextDigest, commitment, notAfter: nowSeconds() }), /notAfter/);

const shortLived = await prover.proveCapability({ capability, contextDigest, commitment, notAfter: nowSeconds() + 60 });
assert.equal(await prover.verify(shortLived), true, "short-lived proof rejected inside its window");
await sleep(Math.max(0, (shortLived.publicInputs.notAfter - nowSeconds() + 1) * 1000));
assert.equal(await prover.verify(shortLived), false, "proof accepted after its deadline");
const redated = withTtl(shortLived, nowSeconds() + 1800);
assert.equal(nativeCode(redated), "verified", "native verification should accept a refreshed TTL");
assert.equal(await prover.verify(redated), false, "refreshed TTL extended the proved deadline");

const genesisHash = "01".repeat(32);
const eventHashes = ["02".repeat(32), "03".repeat(32)];
const rootHash = eventHashes.reduce((previous, hash) => createHash("sha256").update(`poi-trace:roll:v1|${previous}|${hash}`).digest("hex"), genesisHash);
const chain = await prover.proveRollingHashChain({ eventHashes, genesisHash, rootHash, anchorHash: "04".repeat(32), contextDigest });
assert.equal(await prover.verify(chain), true);
assert.equal(await prover.verify({ ...chain, publicInputs: { ...chain.publicInputs, eventCount: 1 } }), false);
assert.equal(await prover.verify({ ...chain, publicInputs: { ...chain.publicInputs, anchorHash: "05".repeat(32) } }), false);
assert.equal(await prover.verify({ ...chain, publicInputs: { ...chain.publicInputs, notAfter: chain.publicInputs.notAfter + 1 } }), false);
assert.equal(await prover.verify({ ...chain, links: [...chain.links].reverse() }), false);
const corruptedLink = withCorruptedProof(chain.links[1]!);
assert.equal(nativeCode(corruptedLink), "invalid-proof");
assert.equal(await prover.verify({ ...chain, links: [chain.links[0]!, corruptedLink] }), false);
for (const link of chain.links) {
  for (const encoded of [link.transactionBase64, link.referenceStateBase64]) {
    const bytes = Buffer.from(encoded, "base64");
    for (const event of eventHashes) {
      assert.equal(bytes.includes(Buffer.from(event, "ascii")), false, "rolling link discloses an event digest");
      assert.equal(bytes.includes(Buffer.from(event, "hex")), false, "rolling link discloses an event digest");
    }
  }
}
assert.deepEqual({
  snapshotVersion: await prover.verify({ ...proof, toJSON: () => ({ ...proof, version: 1 }) }),
  snapshotSimulation: await prover.verify({ ...proof, toJSON: () => ({ ...proof, simulation: true }) }),
  nestedSimulation: await prover.verify({ ...chain, links: chain.links.map(link => ({ ...link, simulation: true })) }),
}, { snapshotVersion: false, snapshotSimulation: false, nestedSimulation: false });
capability.fill(0);
originalCapability.fill(0);
console.log(JSON.stringify({ genuineCapability: true, genuineRollingChain: true, tamperingRejected: true, deadlineEnforced: true, privateWitnessAbsent: true }));
