import { describe, expect, it, vi } from "vitest";
import { chain, fresh, wallet } from "./fakes.js";
import { proofReleaseOperator, PROOF_RELEASE_LABELS, landedProofDeploy, proofReleaseComplete } from "../src/proof-release.js";
import { withFixtureProof } from "../../midnight-prover/tests/fixture-prover.js";
import { proofLedger } from "../../midnight-prover/tests/proof-ledger.js";
import * as L from "@midnight-ntwrk/ledger-v8";
import { buildProofCall, proofProvider } from "@fluxpointstudios/orynq-sdk-midnight-prover";
import { PROOF_RELEASE_CAPABILITY, proofReleaseStatements } from "../runner/proof-release-intent.js";

vi.mock("@fluxpointstudios/orynq-sdk-midnight-prover", async importOriginal => {
  const original = await importOriginal<typeof import("@fluxpointstudios/orynq-sdk-midnight-prover")>();
  return { ...original, proofProvider: (dir: string) => withFixtureProof(original.proofProvider(dir)) };
});

function setup(expiresAt = Date.now() + 3600_000, execute = false) {
  const net = chain();
  const ledger = proofLedger();
  if (execute) {
    const land = net.land;
    net.land = tx => { ledger.apply(tx); land(tx); };
    const batch = net.source.node.batch;
    net.source.node.batch = calls => calls.some(([method]) => method === "midnight_contractState") ? ledger.source.node.batch(calls) : batch(calls);
  }
  const journalPath = fresh("proof-release.sqlite");
  const w = wallet(net, () => journalPath);
  const options = { network: "preprod" as const, source: net.source, wallet: w, paramsDir: "unused", journalPath, expiresAt };
  return { operator: proofReleaseOperator(options), reopen: () => proofReleaseOperator(options), w, journalPath, ledger, net };
}

describe("proof release journal", () => {
  it("keeps gas-rejected bytes until journal retirement, then re-proves against current state", async () => {
    const { operator, w, net, ledger } = setup(Date.now() + 24 * 3600_000, true);
    try {
      await operator.submit(await operator.prepare("deploy"));
      const prepared = await operator.prepare("proveCapability");
      const submit = w.submit;
      w.submit = async () => { throw new Error("ran out of gas budget"); };
      await expect(operator.submit(prepared)).rejects.toThrow(/gas budget/);
      expect((await operator.held("proveCapability"))?.txHash).toBe(prepared.txHash);
      const outsider = buildProofCall({ network: "preprod", state: ledger.read(prepared.address)!, address: prepared.address, statement: proofReleaseStatements(Math.floor(Date.now() / 1000) + 3500)[0]!, witness: { capability: PROOF_RELEASE_CAPABILITY } });
      net.land((await outsider.tx.prove(proofProvider("unused"), L.CostModel.initialCostModel())).bind());
      net.advance(4_000_000);
      expect(await operator.held("proveCapability")).toBeNull();
      w.submit = submit;
      const replacement = await operator.prepare("proveCapability");
      expect(replacement.txHash).not.toBe(prepared.txHash);
      await expect(operator.submit(replacement)).resolves.toMatchObject({ state: "landed" });
    } finally { operator.close(); }
  });
  it("finishes both release calls after an outsider posts between deploy and release", async () => {
    const { operator, w, journalPath, ledger } = setup(Date.now() + 3600_000, true);
    try {
      const deployed = await operator.prepare("deploy");
      await operator.submit(deployed);
      const statement = proofReleaseStatements(Math.floor(Date.now() / 1000) + 1800)[0]!;
      const outsider = buildProofCall({ network: "preprod", state: ledger.read(deployed.address)!, address: deployed.address, statement, witness: { capability: PROOF_RELEASE_CAPABILITY } });
      await w.submit((await outsider.tx.prove(proofProvider("unused"), L.CostModel.initialCostModel())).bind());
      for (const label of ["proveCapability", "proveRolling1"] as const) await operator.submit(await operator.prepare(label));
      expect(proofReleaseComplete("preprod", journalPath)).toBe(true);
    } finally { operator.close(); }
  });
  it("discards wallet bytes whose actual TTL differs from the approved summary", async () => {
    const { operator, w } = setup();
    w.payFee = async tx => {
      const intents = tx.intents!;
      for (const intent of intents.values()) intent.ttl = new Date(intent.ttl.getTime() + 7200_000);
      tx.intents = intents;
      return tx.bind();
    };
    try {
      await expect(operator.prepare("deploy")).rejects.toThrow(/TTL/);
      expect(w.discarded).toHaveLength(1);
      expect(w.submitted).toHaveLength(0);
    } finally { operator.close(); }
  });
  it("allows only the three release labels", async () => {
    const { operator } = setup();
    try {
      await expect(operator.prepare("other" as "deploy")).rejects.toThrow(/release label/);
      await expect(operator.held("other" as "deploy")).rejects.toThrow(/release label/);
    } finally { operator.close(); }
  });
  it("revalidates the label before submitting supplied prepared bytes", async () => {
    const { operator, w } = setup();
    try {
      await operator.submit(await operator.prepare("deploy"));
      const call = await operator.prepare("proveCapability");
      await expect(operator.submit({ ...call, label: "other" as "proveCapability" })).rejects.toThrow(/release label/);
      expect(w.submitted).toHaveLength(1);
    } finally { operator.close(); }
  });
  it("refuses to prepare after expiry", async () => {
    const { operator, w } = setup(Date.now() - 1);
    try {
      await expect(operator.prepare("deploy")).rejects.toThrow(/expired/);
      expect(w.submitted).toHaveLength(0);
    } finally { operator.close(); }
  });
  it("requires the pinned deployment before either call", async () => {
    const { operator } = setup();
    try {
      await expect(operator.prepare("proveCapability")).rejects.toThrow(/deploy has not landed/);
      await expect(operator.prepare("proveRolling1")).rejects.toThrow(/deploy has not landed/);
    } finally { operator.close(); }
  });
  it("journals each transaction before submitting and resumes exactly those bytes", async () => {
    const test = setup();
    let operator = test.operator;
    try {
      for (const label of PROOF_RELEASE_LABELS) {
        expect(proofReleaseComplete("preprod", test.journalPath)).toBe(false);
        const prepared = await operator.prepare(label);
        const row = await operator.submit(prepared);
        expect(row.state).toBe("landed");
        expect(test.w.rowsAtSubmit.at(-1)).toContainEqual(expect.objectContaining({ tx_hash: prepared.txHash, state: "pending" }));
        operator.close();
        operator = test.reopen();
        const held = await operator.held(label);
        expect(held?.txHash).toBe(prepared.txHash);
        expect(held?.bytes).toEqual(prepared.bytes);
        const count = test.w.submitted.length;
        await operator.submit(held!);
        expect(test.w.submitted).toHaveLength(count);
      }
      expect(test.w.submitted).toHaveLength(3);
      expect(proofReleaseComplete("preprod", test.journalPath)).toBe(true);
      expect(landedProofDeploy("preprod", test.journalPath)?.address).toMatch(/^[0-9a-f]{64}$/);
    } finally { operator.close(); }
  });
});
