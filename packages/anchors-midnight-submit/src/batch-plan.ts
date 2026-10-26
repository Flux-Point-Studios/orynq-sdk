import { anchorId } from "@fluxpointstudios/orynq-sdk-core/checkpoint";
import { batchSetCommitment } from "@fluxpointstudios/orynq-sdk-anchors-midnight";

export interface BatchMember { anchorId: string; rootHash: string; manifestHash: string }
export interface BatchAnchorData { materiosGenesis: string; batches: readonly BatchMember[] }
const HASH = /^[0-9a-f]{64}$/;

export function batchAnchorCommitment(data: BatchAnchorData): Uint8Array {
  if (!HASH.test(data.materiosGenesis)) throw new Error("Batch genesis must be 64 lowercase hex characters");
  if (!Array.isArray(data.batches) || data.batches.length < 1 || data.batches.length > 1024) throw new Error("Batch set must contain 1..1024 members");
  const anchorIds = data.batches.map((member) => {
    if (member === null || typeof member !== "object" || Object.keys(member).sort().join(",") !== "anchorId,manifestHash,rootHash") throw new Error("Batch member has missing or unknown fields");
    if (![member.anchorId, member.rootHash, member.manifestHash].every((hash) => typeof hash === "string" && HASH.test(hash))) throw new Error("Batch member hashes must be 64 lowercase hex characters");
    if (anchorId(member.rootHash, member.manifestHash) !== `0x${member.anchorId}`) throw new Error("Batch anchor identity does not derive from its root and manifest");
    return member.anchorId;
  });
  return batchSetCommitment({ materiosGenesis: data.materiosGenesis, anchorIds });
}
