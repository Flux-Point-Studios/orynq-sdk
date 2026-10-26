import { describe, expect, it, vi } from "vitest";
import { chain, fresh, wallet } from "./fakes.js";
import { proofReleaseOperator, PROOF_RELEASE_LABELS, landedProofDeploy, proofReleaseComplete } from "../src/proof-release.js";
import { withFixtureProof } from "../../midnight-prover/tests/fixture-prover.js";

vi.mock("@fluxpointstudios/orynq-sdk-midnight-prover", async importOriginal => {
  const original = await importOriginal<typeof import("@fluxpointstudios/orynq-sdk-midnight-prover")>();
  return { ...original, proofProvider: (dir: string) => withFixtureProof(original.proofProvider(dir)) };
});

function setup(expiresAt = Date.now() + 3600_000) {
  const net = chain();
  const journalPath = fresh("proof-release.sqlite");
  const w = wallet(net, () => journalPath);
  const options = { network: "preprod" as const, source: net.source, wallet: w, paramsDir: "unused", journalPath, expiresAt };
  return { operator: proofReleaseOperator(options), reopen: () => proofReleaseOperator(options), w, journalPath };
}

describe("proof release journal", () => {
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
