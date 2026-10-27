import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FinalityCheckpoint, MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { verifyPosted, type PostedProofRequest } from "../posted.js";

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
const options = { source: { network: "preprod" } as MidnightSource, trustRoot: { genesis: "df831b09a8baa92badf47762ce5ac439b7e47e3ed3d39600cfdd44fad552361b", checkpoints: [{} as FinalityCheckpoint] } };
const result = (name: string, height: number, index = 1) => ({ bytes: file(`${name}.bin`), block: { height, hash: "ab".repeat(32) }, timestamp: fixture.timestamp * 1000, extrinsicIndex: index });
beforeEach(() => finalized.mockReset());

// GRANDPA and execution checks have their own recorded-RPC tests. Here their result is the seam.
describe("posted proof composition with authenticated transaction results", () => {
  it.each(["testnet", "Mainnet", "undeployed", "__proto__", "constructor", "toString"])("refuses an unlisted network %s with an untagged trust root", async network => {
    finalized.mockResolvedValueOnce(result("deploy", 100)).mockResolvedValueOnce(result("proveCapability", 101));
    await expect(verifyPosted({ ...request, network } as never, { source: { network } as MidnightSource, trustRoot: { checkpoints: options.trustRoot.checkpoints } as never })).rejects.toThrow(/genesis/);
    expect(finalized).not.toHaveBeenCalled();
  });
  it.each(["deploy", "call", "both"])("refuses preprod %s bytes in a mainnet-tagged checkpoint bundle", async wrong => {
    const deploy = result("deploy", 100), call = result("proveCapability", 101);
    const relabel = (bytes: Uint8Array) => {
      const changed = Buffer.from(bytes), offset = changed.indexOf("preprod");
      expect(offset).toBeGreaterThan(0);
      changed.set(Buffer.from("mainnet"), offset);
      return changed;
    };
    if (wrong === "call") deploy.bytes = Buffer.from(relabel(deploy.bytes));
    if (wrong === "deploy") call.bytes = Buffer.from(relabel(call.bytes));
    finalized.mockResolvedValueOnce(deploy).mockResolvedValueOnce(call);
    await expect(verifyPosted({ ...request, network: "mainnet" }, { source: { network: "mainnet" } as MidnightSource, trustRoot: { genesis: "1941ca8e2bb88146c14dea084d3be7eb6e96ca7135429c543848b628124f2854", checkpoints: options.trustRoot.checkpoints } })).rejects.toThrow(/network/i);
  });
  it("refuses preprod trust roots relabelled as mainnet before reading transactions", async () => {
    finalized.mockResolvedValueOnce(result("deploy", 100)).mockResolvedValueOnce(result("proveCapability", 101));
    await expect(verifyPosted({ ...request, network: "mainnet" }, { ...options, source: { network: "mainnet" } as MidnightSource, trustRoot: { genesis: "df831b09a8baa92badf47762ce5ac439b7e47e3ed3d39600cfdd44fad552361b", checkpoints: options.trustRoot.checkpoints } })).rejects.toThrow(/genesis/);
    expect(finalized).not.toHaveBeenCalled();
  });
  it("accepts exact real proof bytes at their historical authenticated timestamp", async () => {
    finalized.mockResolvedValueOnce(result("deploy", 100)).mockResolvedValueOnce(result("proveCapability", 101));
    await expect(verifyPosted(request, options)).resolves.toMatchObject({ valid: true, assurance: "consensus-verified", txHash: request.txHash, timestamp: fixture.timestamp * 1000, block: { height: 101 } });
    expect(finalized.mock.calls.map(call => call[0])).toEqual([request.deployTxHash, request.txHash]);
  });
  it("does not relabel a verified transaction when the caller changes its hash during the read", async () => {
    const mutableRequest = structuredClone(request);
    finalized.mockResolvedValueOnce(result("deploy", 100)).mockImplementationOnce(async () => {
      mutableRequest.txHash = "cc".repeat(32);
      return result("proveCapability", 101);
    });
    const verified = await verifyPosted(mutableRequest, options);
    expect(finalized.mock.calls[1]![0]).toBe(request.txHash);
    expect(verified.txHash).toBe(request.txHash);
  });
  it("keeps the expected request and trust root fixed across asynchronous reads", async () => {
    const mutableStatement = structuredClone(statement);
    const mutableRequest: PostedProofRequest = { ...request, statement: mutableStatement };
    const checkpoint: FinalityCheckpoint = { setId: 1n, startsAfter: { height: 99, hash: "11".repeat(32) }, authorities: [{ key: "22".repeat(32), weight: 1n }] };
    const mutableOptions = { ...options, trustRoot: { ...options.trustRoot, checkpoints: [checkpoint] } };
    const expectedCheckpoint = structuredClone(checkpoint);
    finalized.mockImplementationOnce(async () => {
      mutableRequest.txHash = "cc".repeat(32);
      mutableRequest.deployTxHash = "dd".repeat(32);
      mutableRequest.address = "ee".repeat(32);
      mutableRequest.network = "mainnet";
      mutableStatement.commitment = "ff".repeat(32);
      checkpoint.setId = 999n;
      checkpoint.startsAfter.hash = "99".repeat(32);
      checkpoint.authorities[0]!.key = "88".repeat(32);
      return result("deploy", 100);
    }).mockResolvedValueOnce(result("proveCapability", 101));

    const verified = await verifyPosted(mutableRequest, mutableOptions);
    expect(verified).toMatchObject({ txHash: request.txHash, address: request.address, statement: request.statement });
    expect(finalized.mock.calls.map(call => call[0])).toEqual([request.deployTxHash, request.txHash]);
    for (const call of finalized.mock.calls) expect(call[1].checkpoints).toEqual([expectedCheckpoint]);
    mutableStatement.contextDigest = "77".repeat(32);
    expect(verified.statement).toEqual(request.statement);
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
