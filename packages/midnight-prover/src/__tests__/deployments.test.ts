import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { knownAuthors, rpcOnlySource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { PROOF_DEPLOYMENTS, PROOF_PINS, verifyPosted, type PostedProofRequest } from "../index.js";

const finalized = vi.hoisted(() => vi.fn());
vi.mock("@fluxpointstudios/orynq-sdk-anchors-midnight", async importOriginal => ({
  ...await importOriginal<typeof import("@fluxpointstudios/orynq-sdk-anchors-midnight")>(),
  verifyFinalizedTransaction: finalized,
}));

describe.each(["mainnet", "preprod"] as const)("%s proof deployment", network => {
  it("matches the pinned code and initial state", () => {
    const deployment = PROOF_DEPLOYMENTS[network];
    expect(deployment.codeHash).toBe(PROOF_PINS.codeHash);
    expect(deployment.initialStateSha256).toBe(PROOF_PINS.initialStateSha256);
  });

  it("uses canonical hashes, a positive block height and an accepted network", () => {
    const deployment = PROOF_DEPLOYMENTS[network];
    expect(deployment.network).toBe(network);
    for (const hash of [deployment.address, deployment.deployTxHash, deployment.codeHash,
      deployment.initialStateSha256, deployment.deployBlockHint.txHash, deployment.deployBlockHint.blockHash]) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(deployment.deployBlockHint.txHash).toBe(deployment.deployTxHash);
    expect(Number.isSafeInteger(deployment.deployBlockHint.blockHeight)).toBe(true);
    expect(deployment.deployBlockHint.blockHeight).toBeGreaterThan(0);
    expect(Object.keys(PROOF_DEPLOYMENTS).sort()).toEqual(["mainnet", "preprod"]);
  });

  it("freezes the catalog, deployment and nested block hint", () => {
    const deployment = PROOF_DEPLOYMENTS[network];
    for (const [object, key, value] of [
      [PROOF_DEPLOYMENTS, network, {}],
      [deployment, "address", "00".repeat(32)],
      [deployment.deployBlockHint, "blockHeight", 1],
    ] as const) {
      expect(Object.isFrozen(object)).toBe(true);
      expect(Reflect.set(object, key, value)).toBe(false);
    }
  });

  it("matches the recorded deployment evidence", () => {
    const deployment = PROOF_DEPLOYMENTS[network];
    const name = network === "mainnet" ? "mainnet-release" : "preprod-rehearsal";
    const evidence = JSON.parse(readFileSync(new URL(`../../onchain/${name}.json`, import.meta.url), "utf8"));
    expect(deployment).toEqual({
      network: evidence.network,
      address: evidence.transactions.deploy.address,
      deployTxHash: evidence.transactions.deploy.txHash,
      deployBlockHint: {
        txHash: evidence.transactions.deploy.txHash,
        blockHeight: evidence.transactions.deploy.blockHeight,
        blockHash: evidence.transactions.deploy.blockHash,
      },
      codeHash: evidence.pins.codeHash,
      initialStateSha256: evidence.pins.initialStateSha256,
    });
  });

  it("composes into verifyPosted and an RPC hint without network access", async () => {
    const deployment = PROOF_DEPLOYMENTS[network];
    const node = {
      call: vi.fn().mockRejectedValue(new Error("Unexpected network access")),
      batch: vi.fn().mockRejectedValue(new Error("Unexpected network access")),
    };
    const source = rpcOnlySource({ network: deployment.network, node, registries: [], hints: [deployment.deployBlockHint] });
    const request = {
      ...deployment,
      txHash: "11".repeat(32),
      statement: { circuit: "proveCapability", contextDigest: "22".repeat(32), commitment: "33".repeat(32), notAfter: 1793135584 },
    } satisfies PostedProofRequest;
    const trustRoot = {
      genesis: network === "mainnet" ? "1941ca8e2bb88146c14dea084d3be7eb6e96ca7135429c543848b628124f2854" : "df831b09a8baa92badf47762ce5ac439b7e47e3ed3d39600cfdd44fad552361b",
      checkpoints: network === "mainnet" ? knownAuthors().checkpoints(network) : [{
        setId: 1n, startsAfter: { height: 1, hash: "44".repeat(32) },
        authorities: [{ key: "55".repeat(32), weight: 1n }],
      }],
    };
    finalized.mockReset().mockRejectedValue(new Error("Offline finality boundary"));
    await expect(verifyPosted(request, { source, trustRoot })).rejects.toThrow("Offline finality boundary");
    expect(finalized).toHaveBeenCalledExactlyOnceWith(deployment.deployTxHash, { source, checkpoints: trustRoot.checkpoints });
    expect(node.call).not.toHaveBeenCalled();
    expect(node.batch).not.toHaveBeenCalled();
  });
});
