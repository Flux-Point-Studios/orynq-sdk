import { createHash } from "node:crypto";
import * as L from "@midnight-ntwrk/ledger-v8";
import { describe, expect, it, vi } from "vitest";
import { buildProofCall, buildProofDeploy } from "../onchain.js";
import { assertPostedProof, verifyPosted } from "../posted.js";
import { proofProvider } from "../proof-material.js";
import { withFixtureProof } from "../../tests/fixture-prover.js";
import type { MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";

const capability = new Uint8Array(32).fill(9);
const contextDigest = "ab".repeat(32);
const statement = { circuit: "proveCapability" as const, contextDigest, commitment: createHash("sha256").update(capability).update(Buffer.from(contextDigest, "hex")).digest("hex"), notAfter: Math.floor(Date.now() / 1000) + 3500 };
const deployment = buildProofDeploy("preprod", new Date(statement.notAfter * 1000));
const zkir = proofProvider("unused");
// Fixture proof bytes exercise decoding only; finality acceptance is tested independently.
const call = async () => (await buildProofCall({ network: "preprod", address: deployment.address, statement, witness: { capability } }).tx.prove(withFixtureProof(zkir), L.CostModel.initialCostModel())).bind().serialize();

describe("posted proof verification", () => {
  it("decodes the expected presentation from the transaction's own transcript", async () => {
    const bytes = await call();
    expect(() => assertPostedProof(bytes, deployment.address, statement, Date.now())).not.toThrow();
  });
  it("rejects another contract", async () => {
    const bytes = await call();
    expect(() => assertPostedProof(bytes, "cc".repeat(32), statement, Date.now())).toThrow(/contract/);
  });
  it("rejects another circuit", async () => {
    const bytes = await call();
    expect(() => assertPostedProof(bytes, deployment.address, { circuit: "proveRolling1", genesisHash: "11".repeat(32), rootHash: "22".repeat(32), anchorHash: "33".repeat(32), contextDigest, notAfter: statement.notAfter }, Date.now())).toThrow(/circuit/);
  });
  it.each(["commitment", "contextDigest"] as const)("rejects a changed %s", async field => {
    const bytes = await call();
    expect(() => assertPostedProof(bytes, deployment.address, { ...statement, [field]: "00".repeat(32) }, Date.now())).toThrow(/expected proof/);
  });
  it("checks the authenticated block time against the proved deadline", async () => {
    const bytes = await call();
    expect(() => assertPostedProof(bytes, deployment.address, statement, statement.notAfter * 1000)).toThrow(/deadline/);
  });
  it("rejects deploy bytes presented as a call", () => {
    expect(() => assertPostedProof(deployment.tx.mockProve().serialize(), deployment.address, statement, Date.now())).toThrow(/call/);
  });
  it("requires finality trust supplied independently of the posted receipt", async () => {
    const transactions = vi.fn();
    const source = { network: "preprod", indexer: { transactions } } as unknown as MidnightSource;
    await expect(verifyPosted({ network: "preprod", address: deployment.address, deployTxHash: "11".repeat(32), txHash: "22".repeat(32), statement }, { source, checkpoints: [] })).rejects.toThrow(/checkpoint/);
    expect(transactions).not.toHaveBeenCalled();
  });
});
