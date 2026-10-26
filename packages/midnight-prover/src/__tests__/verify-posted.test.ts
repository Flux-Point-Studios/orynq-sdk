import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FinalityCheckpoint, MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { verifyPosted } from "../posted.js";

const finalized = vi.hoisted(() => vi.fn());
vi.mock("@fluxpointstudios/orynq-sdk-anchors-midnight", async importOriginal => ({
  ...await importOriginal<typeof import("@fluxpointstudios/orynq-sdk-anchors-midnight")>(),
  verifyFinalizedTransaction: finalized,
}));

const file = (name: string) => readFileSync(new URL(`../../native/tests/fixtures/onchain/${name}`, import.meta.url));
const fixture = JSON.parse(file("fixture.json").toString());
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const contextDigest = hash("orynq:onchain:synthetic-integration");
const statement = { circuit: "proveCapability" as const, contextDigest, notAfter: fixture.deadline as number, commitment: createHash("sha256").update(new Uint8Array(32).fill(19)).update(Buffer.from(contextDigest, "hex")).digest("hex") };
const request = { network: "preprod" as const, address: fixture.address as string, deployTxHash: fixture.deployTxHash as string, txHash: fixture.calls[0].txHash as string, statement };
const options = { source: { network: "preprod" } as MidnightSource, checkpoints: [{} as FinalityCheckpoint] };
const result = (name: string, height: number, index = 1) => ({ bytes: file(`${name}.bin`), block: { height, hash: "ab".repeat(32) }, timestamp: fixture.timestamp * 1000, extrinsicIndex: index });
beforeEach(() => finalized.mockReset());

// GRANDPA and execution checks have their own recorded-RPC tests. Here their result is the seam.
describe("posted proof composition with authenticated transaction results", () => {
  it("accepts exact real proof bytes at their historical authenticated timestamp", async () => {
    finalized.mockResolvedValueOnce(result("deploy", 100)).mockResolvedValueOnce(result("proveCapability", 101));
    await expect(verifyPosted(request, options)).resolves.toMatchObject({ valid: true, assurance: "consensus-verified", txHash: request.txHash, timestamp: fixture.timestamp * 1000, block: { height: 101 } });
    expect(finalized.mock.calls.map(call => call[0])).toEqual([request.deployTxHash, request.txHash]);
  });
  it("refuses a deployment receipt for another address", async () => {
    finalized.mockResolvedValueOnce(result("deploy", 100));
    await expect(verifyPosted({ ...request, address: "cc".repeat(32) }, options)).rejects.toThrow(/deployment address/);
    expect(finalized).toHaveBeenCalledTimes(1);
  });
  it.each([[102, 1], [101, 2]])("requires deployment before the call (%i, %i)", async (height, index) => {
    finalized.mockResolvedValueOnce(result("deploy", height, index)).mockResolvedValueOnce(result("proveCapability", 101));
    await expect(verifyPosted(request, options)).rejects.toThrow(/precedes/);
  });
  it("propagates failed finality without a positive verdict", async () => {
    finalized.mockResolvedValueOnce(result("deploy", 100)).mockRejectedValueOnce(new Error("Unverified finality"));
    await expect(verifyPosted(request, options)).rejects.toThrow(/finality/);
  });
  it("refuses a source for another network before making reads", async () => {
    await expect(verifyPosted(request, { ...options, source: { network: "mainnet" } as MidnightSource })).rejects.toThrow(/network/);
    expect(finalized).not.toHaveBeenCalled();
  });
});
