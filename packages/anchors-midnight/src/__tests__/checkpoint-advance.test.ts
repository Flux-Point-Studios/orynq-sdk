import { expect, it } from "vitest";
import { followerChain } from "./follower-chain.js";
import { finalityRpc } from "../source.js";
import { checkpointId } from "../checkpoints.js";
import { deriveCheckpointAdvance, verifyCheckpointAdvance } from "../checkpoint-advance.js";

async function fixture() {
  const chain = followerChain(), predecessor = chain.checkpoint;
  const artifact = await deriveCheckpointAdvance({ network: "mainnet", predecessor, rpc: finalityRpc(chain.source), block: chain.ref(1601) });
  return { chain, predecessor, artifact };
}
it("derives a portable successor using only the predecessor's GRANDPA chain", async () => {
  const { predecessor, artifact, chain } = await fixture();
  const result = await verifyCheckpointAdvance({ artifact, predecessor, expectedNetwork: "mainnet", expectedSequence: 1, previousDigest: null });
  expect(result.checkpoint.setId).toBeGreaterThan(predecessor.setId);
  expect(result.checkpoint.startsAfter.height).toBeGreaterThan(predecessor.startsAfter.height);
  expect(result.block).toEqual(chain.ref(1601)); expect(result.sequence).toBe(1);
  expect(artifact.proofs.length).toBeGreaterThan(0); expect(artifact.headers.length).toBeGreaterThan(0);
});
it.each(["authority", "fork", "proof", "missing", "network", "sequence", "rollback"] as const)("refuses a %s advancement without accepting caller trust", async mode => {
  const { artifact, predecessor } = await fixture();
  if (mode === "authority") artifact.successor.authorities[0]!.key = "00".repeat(32);
  if (mode === "fork") artifact.block.hash = "00".repeat(32);
  if (mode === "proof") artifact.proofs[0]![1] = "00";
  if (mode === "missing") artifact.headers = [];
  if (mode === "network") artifact.network = "preprod";
  if (mode === "sequence") artifact.sequence = 2;
  if (mode === "rollback") artifact.successor.startsAfter.height = predecessor.startsAfter.height;
  await expect(verifyCheckpointAdvance({ artifact, predecessor, expectedNetwork: "mainnet", expectedSequence: 1, previousDigest: null })).rejects.toThrow();
});
it("extends an immutable transcript chain without recurring root signatures", async () => {
  const first = await fixture(), verified = await verifyCheckpointAdvance({ artifact: first.artifact, predecessor: first.predecessor, expectedNetwork: "mainnet", expectedSequence: 1, previousDigest: null });
  const artifact = await deriveCheckpointAdvance({ network: "mainnet", predecessor: verified.checkpoint, rpc: finalityRpc(first.chain.source), block: first.chain.ref(1901), sequence: 2, previousDigest: verified.digest, rootId: checkpointId(first.predecessor) });
  const second = await verifyCheckpointAdvance({ artifact, predecessor: verified.checkpoint, expectedNetwork: "mainnet", expectedSequence: 2, previousDigest: verified.digest, rootId: first.artifact.rootId });
  expect(second.checkpoint.setId).toBeGreaterThan(verified.checkpoint.setId);
  await expect(verifyCheckpointAdvance({ artifact, predecessor: verified.checkpoint, expectedNetwork: "mainnet", expectedSequence: 2, previousDigest: "00".repeat(32), rootId: first.artifact.rootId })).rejects.toThrow(/continuity/i);
});
