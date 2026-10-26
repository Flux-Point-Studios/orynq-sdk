import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RealMidnightProver } from "../real-prover.js";

describe("real Midnight proof boundary", () => {
  it("rejects legacy simulations before invoking a verifier", async () => {
    const prover = new RealMidnightProver({
      artifactsDir: "/missing-artifacts",
      nativeVerifierPath: "/missing-verifier",
      paramsDir: "/missing-params",
    });
    expect(await prover.verify({ proofType: "hash-chain", proof: new Uint8Array([1, 2, 3]) })).toBe(false);
  });

  it("fails generation when trusted compiled artifacts are absent", async () => {
    const prover = new RealMidnightProver({
      artifactsDir: "/missing-artifacts",
      nativeVerifierPath: "/missing-verifier",
      paramsDir: "/missing-params",
    });
    await expect(prover.proveCapability({
      capability: new Uint8Array(32).fill(3),
      contextDigest: "01".repeat(32),
      commitment: "02".repeat(32),
    })).rejects.toThrow();
  });

  it("preserves the caller's Buffer when wiping a failed proof's witness", async () => {
    const capability = Buffer.alloc(32, 7);
    const prover = new RealMidnightProver({
      artifactsDir: "/missing-artifacts",
      nativeVerifierPath: "/missing-verifier",
      paramsDir: "/missing-params",
    });
    await expect(prover.proveCapability({
      capability,
      contextDigest: "01".repeat(32),
      commitment: "02".repeat(32),
    })).rejects.toThrow();
    expect(capability).toEqual(Buffer.alloc(32, 7));
  });

  it("keeps its trusted artifact configuration when the caller mutates options", async () => {
    const options = {
      artifactsDir: "/trusted-missing-artifacts",
      nativeVerifierPath: "/missing-verifier",
      paramsDir: "/missing-params",
    };
    const prover = new RealMidnightProver(options);
    options.artifactsDir = "/attacker-controlled-artifacts";
    await expect(prover.proveCapability({
      capability: new Uint8Array(32),
      contextDigest: "01".repeat(32),
      commitment: "02".repeat(32),
    })).rejects.toThrow("/trusted-missing-artifacts/");
  });

  it("binds capability metadata to the values supplied before proving awaits", async () => {
    const prover = new RealMidnightProver({ artifactsDir: "/missing-artifacts", nativeVerifierPath: "/missing-verifier", paramsDir: "/missing-params" });
    const input = { capability: new Uint8Array(32), contextDigest: "01".repeat(32), commitment: "02".repeat(32), notAfter: Math.floor(Date.now() / 1000) + 600 };
    const original = { contextDigest: input.contextDigest, commitment: input.commitment, notAfter: input.notAfter };
    vi.spyOn(prover as unknown as { proveCircuit: () => Promise<object> }, "proveCircuit").mockImplementation(async () => {
      input.contextDigest = "03".repeat(32);
      input.commitment = "04".repeat(32);
      input.notAfter += 1;
      return {};
    });
    expect((await prover.proveCapability(input)).publicInputs).toEqual(original);
  });

  it("snapshots rolling digests and metadata across asynchronous proving", async () => {
    const prover = new RealMidnightProver({ artifactsDir: "/missing-artifacts", nativeVerifierPath: "/missing-verifier", paramsDir: "/missing-params" });
    const genesisHash = "01".repeat(32);
    const input = { genesisHash, eventHashes: ["02".repeat(32)], rootHash: createHash("sha256").update(`poi-trace:roll:v1|${genesisHash}|${"02".repeat(32)}`).digest("hex"), anchorHash: "03".repeat(32), contextDigest: "04".repeat(32), notAfter: Math.floor(Date.now() / 1000) + 600 };
    const original = { genesisHash, rootHash: input.rootHash, anchorHash: input.anchorHash, contextDigest: input.contextDigest, eventCount: 1, notAfter: input.notAfter };
    vi.spyOn(prover as unknown as { proveCircuit: () => Promise<object> }, "proveCircuit").mockImplementation(async () => {
      input.genesisHash = "05".repeat(32);
      input.rootHash = "06".repeat(32);
      input.anchorHash = "07".repeat(32);
      input.contextDigest = "08".repeat(32);
      input.eventHashes[0] = "09".repeat(32);
      input.notAfter += 1;
      return {};
    });
    expect((await prover.proveRollingHashChain(input)).publicInputs).toEqual(original);
  });

  it("rejects a proof with an unsupported circuit rather than using a fallback", async () => {
    const prover = new RealMidnightProver({
      artifactsDir: "/missing-artifacts",
      nativeVerifierPath: "/missing-verifier",
      paramsDir: "/missing-params",
    });
    expect(await prover.verify({
      version: 2,
      proofType: "lease-capability-v1",
      circuitId: "attacker-circuit",
      transactionBase64: "AA==",
      referenceStateBase64: "AA==",
      verificationTimeUnixSeconds: 0,
      publicInputs: { contextDigest: "01".repeat(32), commitment: "02".repeat(32), notAfter: Math.floor(Date.now() / 1000) + 600 },
    })).toBe(false);
  });
});
