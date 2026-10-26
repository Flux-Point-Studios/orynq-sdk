import { expect, it } from "vitest";
import { reviewCheckpointSigning } from "../signing-review.js";
import { deriveCheckpointAdvance, checkpointToJson } from "../checkpoint-advance.js";
import { finalityRpc } from "../source.js";
import type { KnownAuthors } from "../known-authors.js";
import { followerChain } from "./follower-chain.js";

async function setup() {
  const chain = followerChain();
  const artifact = await deriveCheckpointAdvance({ network: "mainnet", predecessor: chain.checkpoint, rpc: finalityRpc(chain.source), block: chain.ref(1601) });
  const policy: KnownAuthors = { serial: 1, authors: () => [], checkpoints: network => network === "mainnet" ? [chain.checkpoint] : [], author: () => ({ status: "unknown" }) };
  const document = { format: "orynq-known-authors/v1", serial: 2, issued: "2026-10-26T00:00:00Z", networks: { mainnet: { authors: [], checkpoints: [checkpointToJson(chain.checkpoint), artifact.successor] } } };
  return { artifact, policy, document };
}

it("permits a checkpoint append only after replaying its exact derivation from the existing pin", async () => {
  const { artifact, policy, document } = await setup();
  await expect(reviewCheckpointSigning(JSON.stringify(document), [artifact], policy)).resolves.toBeUndefined();
  await expect(reviewCheckpointSigning(JSON.stringify(document), [], policy)).rejects.toThrow(/exactly one/);
  await expect(reviewCheckpointSigning(JSON.stringify(document), [artifact, artifact], policy)).rejects.toThrow(/exactly one/);
});

it("refuses attacker-prepared authority sets even when the document and evidence agree about them", async () => {
  const { artifact, policy, document } = await setup();
  artifact.successor.authorities[0]!.key = "00".repeat(32);
  document.networks.mainnet.checkpoints[1] = artifact.successor;
  await expect(reviewCheckpointSigning(JSON.stringify(document), [artifact], policy)).rejects.toThrow(/authenticated/);
});

it("refuses checkpoint rollback, unreviewed bootstrap and unrelated evidence", async () => {
  const { artifact, policy, document } = await setup();
  const dropped = structuredClone(document); dropped.networks.mainnet.checkpoints = [];
  await expect(reviewCheckpointSigning(JSON.stringify(dropped), [], policy)).rejects.toThrow(/prefix extension/);
  const bootstrap = structuredClone(document); bootstrap.networks.mainnet.checkpoints = [artifact.successor];
  await expect(reviewCheckpointSigning(JSON.stringify(bootstrap), [artifact], { ...policy, checkpoints: () => [] })).rejects.toThrow(/bootstrap/);
  const unchanged = structuredClone(document); unchanged.networks.mainnet.checkpoints.pop();
  await expect(reviewCheckpointSigning(JSON.stringify(unchanged), [artifact], policy)).rejects.toThrow(/unused derivations/);
});
