import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { post, type ProofWallet } from "../post.js";
import { withFixtureProof } from "../../tests/fixture-prover.js";

vi.mock("../proof-material.js", async importOriginal => {
  const original = await importOriginal<typeof import("../proof-material.js")>();
  return { proofProvider: (dir: string) => withFixtureProof(original.proofProvider(dir)) };
});

const capability = new Uint8Array(32).fill(13);
const contextDigest = "ac".repeat(32);
const statement = () => ({ circuit: "proveCapability" as const, contextDigest, commitment: createHash("sha256").update(capability).update(Buffer.from(contextDigest, "hex")).digest("hex"), notAfter: Math.floor(Date.now() / 1000) + 3500 });

describe("local proving before wallet handoff", () => {
  it("hands only a proven transaction to the supplied wallet and returns the submitted hash", async () => {
    const submit = vi.fn();
    const payFee = vi.fn<ProofWallet["payFee"]>(async tx => {
      const bytes = Buffer.from(tx.serialize());
      expect(bytes.includes(Buffer.from(capability))).toBe(false);
      return tx.bind();
    });
    const result = await post({ network: "preprod", address: "bb".repeat(32), statement: statement(), witness: { capability }, paramsDir: "unused", wallet: { network: "preprod", payFee, submit } });
    expect(payFee).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]![0].transactionHash()).toBe(result.txHash);
    expect(capability).toEqual(new Uint8Array(32).fill(13));
  });

  it("refuses a wallet on another network before proving or submitting", async () => {
    const payFee = vi.fn(), submit = vi.fn();
    await expect(post({ network: "preprod", address: "bb".repeat(32), statement: statement(), witness: { capability }, paramsDir: "unused", wallet: { network: "mainnet", payFee, submit } })).rejects.toThrow(/network/);
    expect(payFee).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses an invalid witness before contacting the wallet", async () => {
    const payFee = vi.fn(), submit = vi.fn();
    await expect(post({ network: "preprod", address: "bb".repeat(32), statement: statement(), witness: { capability: new Uint8Array(32) }, paramsDir: "unused", wallet: { network: "preprod", payFee, submit } })).rejects.toThrow(/capability mismatch/);
    expect(payFee).not.toHaveBeenCalled();
  });
});
