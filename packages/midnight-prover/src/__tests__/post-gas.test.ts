import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import * as L from "@midnight-ntwrk/ledger-v8";
import { post } from "../post.js";
import { buildProofDeploy } from "../onchain.js";
import { proofProvider } from "../proof-material.js";
import { proofLedger } from "../../tests/proof-ledger.js";
import { withFixtureProof } from "../../tests/fixture-prover.js";

vi.mock("../proof-material.js", async importOriginal => {
  const original = await importOriginal<typeof import("../proof-material.js")>();
  return { proofProvider: (dir: string) => withFixtureProof(original.proofProvider(dir)) };
});
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const capability = new Uint8Array(32).fill(1);
const refused = 'test node: author_submitExtrinsic failed: {"code":1010,"message":"Invalid Transaction","data":"Custom error: 104"}';
async function setup() {
  const ledger = proofLedger();
  const deploy = buildProofDeploy("preprod", new Date(Date.now() + 3500_000));
  ledger.apply((await deploy.tx.prove(proofProvider("unused"), L.CostModel.initialCostModel())).bind());
  const wallet = { network: "preprod" as const, payFee: vi.fn(async (tx: L.Transaction<L.SignatureEnabled, L.Proof, L.PreBinding>) => tx.bind()), submit: vi.fn(async (tx: L.FinalizedTransaction) => ledger.apply(tx)), discard: vi.fn(async () => {}) };
  const send = (id: string) => {
    const contextDigest = hash(id);
    return post({ network: "preprod", source: ledger.source, address: deploy.address, statement: { circuit: "proveCapability", contextDigest, commitment: createHash("sha256").update(capability).update(Buffer.from(contextDigest, "hex")).digest("hex"), notAfter: Math.floor(Date.now() / 1000) + 1800 }, witness: { capability }, paramsDir: "unused", wallet });
  };
  return { ledger, wallet, send };
}
describe("post gas on a growing presentation trie", () => {
  it("lands four sequential posts", async () => {
    const { send, ledger } = await setup();
    const reads = vi.spyOn(ledger.source.node, "batch");
    for (let i = 0; i < 4; i++) await expect(send(`sequential:${i}`)).resolves.toHaveProperty("txHash");
    expect(reads).toHaveBeenCalledTimes(4);
  });
  it("lands a concurrent racer across a trie-depth boundary", async () => {
    const { send, wallet, ledger } = await setup();
    await send("first");
    const waiting: L.FinalizedTransaction[] = [];
    wallet.submit.mockImplementation(async tx => {
      waiting.push(tx);
      if (waiting.length === 2) for (const held of waiting) ledger.apply(held);
    });
    await expect(Promise.all([send("racer:a"), send("racer:b")])).resolves.toHaveLength(2);
    expect(waiting).toHaveLength(2);
  });
  it("re-reads and re-proves after an out-of-gas rejection, at most three attempts", async () => {
    const { send, wallet, ledger } = await setup();
    const reads = vi.spyOn(ledger.source.node, "batch");
    wallet.submit.mockRejectedValueOnce(new Error(refused));
    await expect(send("retry")).resolves.toHaveProperty("txHash");
    expect(reads).toHaveBeenCalledTimes(2);
    expect(wallet.payFee).toHaveBeenCalledTimes(2);
    expect(wallet.discard).toHaveBeenCalledTimes(1);
    wallet.submit.mockRejectedValue(new Error(refused));
    await expect(send("bounded")).rejects.toThrow(refused);
    expect(wallet.submit).toHaveBeenCalledTimes(5);
  });
  it.each(["network timeout", "HTTP 502 ran out of gas budget", refused.replace("104", "136"), refused.replace("1010", "1013"), refused.replace("author_submitExtrinsic", "chain_getBlock"), 'test node: author_submitExtrinsic failed: {broken JSON}'])("does not retry or discard an unrelated or ambiguous failure: %s", async message => {
    const { send, wallet } = await setup();
    wallet.submit.mockRejectedValue(new Error(message));
    await expect(send("ambiguous")).rejects.toThrow(message);
    expect(wallet.payFee).toHaveBeenCalledOnce();
    expect(wallet.discard).not.toHaveBeenCalled();
  });
});
