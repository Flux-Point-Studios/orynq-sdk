import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { proofInitialState } from "../onchain.js";
import { post, type ProofWallet } from "../post.js";
import { withFixtureProof } from "../../tests/fixture-prover.js";

vi.mock("../proof-material.js", async importOriginal => {
  const original = await importOriginal<typeof import("../proof-material.js")>();
  return { proofProvider: (dir: string) => withFixtureProof(original.proofProvider(dir)) };
});

const source = { network: "preprod", operator: "test", node: { batch: async () => [Array(33).fill(0), Buffer.from(proofInitialState().serialize()).toString("hex")] } } as unknown as MidnightSource;
const discard = vi.fn(async () => {});
const capability = new Uint8Array(32).fill(13);
const contextDigest = "ac".repeat(32);
const statement = () => ({ circuit: "proveCapability" as const, contextDigest, commitment: createHash("sha256").update(capability).update(Buffer.from(contextDigest, "hex")).digest("hex"), notAfter: Math.floor(Date.now() / 1000) + 3500 });

describe("local proving before wallet handoff", () => {
  it.each(["prefix", "newline", "truncated"])("rejects a malformed event digest without exposing the witness: %s", async kind => {
    const eventDigest = createHash("sha256").update("private synthetic event").digest("hex");
    const bad = kind === "prefix" ? `0x${eventDigest}` : kind === "newline" ? `${eventDigest}\n` : eventDigest.slice(0, 63);
    const genesisHash = "ab".repeat(32);
    const payFee = vi.fn(), submit = vi.fn();
    let message = "";
    try {
      await post({ source, network: "preprod", address: "bb".repeat(32), statement: { circuit: "proveRolling1", contextDigest, genesisHash, rootHash: createHash("sha256").update(`poi-trace:roll:v1|${genesisHash}|${eventDigest}`).digest("hex"), anchorHash: "cd".repeat(32), notAfter: Math.floor(Date.now() / 1000) + 1800 }, witness: { eventDigest: bad }, paramsDir: "unused", wallet: { network: "preprod", payFee, submit, discard } });
    } catch (error) { message = (error as Error).message; }
    const decoded = Buffer.from([...message.matchAll(/\d+: (\d+)/g)].map(match => Number(match[1]))).toString("latin1");
    expect(message.includes(eventDigest.slice(0, 63)) || decoded.includes(eventDigest.slice(0, 63))).toBe(false);
    expect(message).toBe("A canonical event digest is required");
    expect(payFee).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
  it("hands only a proven transaction to the supplied wallet and returns the submitted hash", async () => {
    const submit = vi.fn();
    const payFee = vi.fn<ProofWallet["payFee"]>(async tx => {
      const bytes = Buffer.from(tx.serialize());
      expect(bytes.includes(Buffer.from(capability))).toBe(false);
      return tx.bind();
    });
    const result = await post({ source, network: "preprod", address: "bb".repeat(32), statement: statement(), witness: { capability }, paramsDir: "unused", wallet: { network: "preprod", payFee, submit, discard } });
    expect(payFee).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]![0].transactionHash()).toBe(result.txHash);
    expect(capability).toEqual(new Uint8Array(32).fill(13));
  });

  it("keeps the original network, address, wallet and statement while reading contract state", async () => {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const readingSource = { ...source, node: { batch: async () => {
      await barrier;
      return [Array(33).fill(0), Buffer.from(proofInitialState().serialize()).toString("hex")];
    } } } as unknown as MidnightSource;
    const originalWallet: ProofWallet = { network: "preprod", payFee: vi.fn(async tx => tx.bind()), submit: vi.fn(async () => {}), discard };
    const replacementWallet: ProofWallet = { network: "mainnet", payFee: vi.fn(async tx => tx.bind()), submit: vi.fn(async () => {}), discard };
    const options: Parameters<typeof post>[0] = { source: readingSource, network: "preprod", address: "bb".repeat(32), statement: statement(), witness: { capability }, paramsDir: "unused", wallet: originalWallet };
    const expected = { ...options.statement };
    const pending = post(options);
    options.network = "mainnet";
    options.address = "cc".repeat(32);
    options.wallet = replacementWallet;
    options.statement.contextDigest = "dd".repeat(32);
    release();
    const result = await pending;
    expect(result.address).toBe("bb".repeat(32));
    expect(result.statement).toEqual(expected);
    expect(originalWallet.payFee).toHaveBeenCalledOnce();
    expect(originalWallet.submit).toHaveBeenCalledOnce();
    expect(replacementWallet.payFee).not.toHaveBeenCalled();
    expect(replacementWallet.submit).not.toHaveBeenCalled();
  });

  it("reads a changing address getter once before asynchronous work", async () => {
    let reads = 0;
    const wallet: ProofWallet = { network: "preprod", payFee: vi.fn(async tx => tx.bind()), submit: vi.fn(async () => {}), discard };
    const options: Parameters<typeof post>[0] = { source, network: "preprod", address: "bb".repeat(32), statement: statement(), witness: { capability }, paramsDir: "unused", wallet };
    Object.defineProperty(options, "address", { get: () => ++reads === 1 ? "bb".repeat(32) : "cc".repeat(32) });
    const result = await post(options);
    expect(result.address).toBe("bb".repeat(32));
    expect(reads).toBe(1);
    expect(wallet.submit).toHaveBeenCalledOnce();
  });

  it("validates the captured event digest instead of re-reading a witness getter", async () => {
    const eventDigest = createHash("sha256").update("synthetic digest snapshot").digest("hex");
    const genesisHash = "ab".repeat(32);
    let reads = 0;
    const witness = { get eventDigest() { return ++reads === 1 ? eventDigest : `${eventDigest}\n`; } };
    const wallet: ProofWallet = { network: "preprod", payFee: vi.fn(async tx => tx.bind()), submit: vi.fn(async () => {}), discard };
    await post({ source, network: "preprod", address: "bb".repeat(32), statement: {
      circuit: "proveRolling1", contextDigest, genesisHash,
      rootHash: createHash("sha256").update(`poi-trace:roll:v1|${genesisHash}|${eventDigest}`).digest("hex"),
      anchorHash: "cd".repeat(32), notAfter: Math.floor(Date.now() / 1000) + 1800,
    }, witness, paramsDir: "unused", wallet });
    expect(reads).toBe(1);
    expect(wallet.submit).toHaveBeenCalledOnce();
  });

  it("refuses a wallet on another network before proving or submitting", async () => {
    const payFee = vi.fn(), submit = vi.fn();
    await expect(post({ source, network: "preprod", address: "bb".repeat(32), statement: statement(), witness: { capability }, paramsDir: "unused", wallet: { network: "mainnet", payFee, submit, discard } })).rejects.toThrow(/network/);
    expect(payFee).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses an invalid witness before contacting the wallet", async () => {
    const payFee = vi.fn(), submit = vi.fn();
    await expect(post({ source, network: "preprod", address: "bb".repeat(32), statement: statement(), witness: { capability: new Uint8Array(32) }, paramsDir: "unused", wallet: { network: "preprod", payFee, submit, discard } })).rejects.toThrow(/capability mismatch/);
    expect(payFee).not.toHaveBeenCalled();
  });
});
