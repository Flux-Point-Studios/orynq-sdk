import { verifyCheckpointAdvanceHistory, type CheckpointAdvance, type FinalityCheckpoint, type MidnightNetwork } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

export function readCheckpointHistory(file: string): CheckpointAdvance[] {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()) || stat.size > 512 * 1024 * 1024) throw new Error("Checkpoint history must be a bounded private file owned by its reader");
    const text = readFileSync(fd, "utf8");
    if (Buffer.byteLength(text) !== stat.size || fstatSync(fd).size !== stat.size) throw new Error("Checkpoint history changed while being read");
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error("Checkpoint history is not JSON"); }
    if (!Array.isArray(value) || value.length > 4096) throw new Error("Invalid checkpoint history list");
    return value as CheckpointAdvance[];
  } finally { closeSync(fd); }
}

// A descendant is acceleration state authenticated by the immutable original roots. It never
// changes the follower/accounting scope or replaces the offline author-policy trust roots.
export async function authenticateCheckpointHistory(network: MidnightNetwork, originals: readonly FinalityCheckpoint[], input: readonly CheckpointAdvance[]) {
  const result = await verifyCheckpointAdvanceHistory({ expectedNetwork: network, checkpoints: originals, artifacts: input });
  return { artifacts: result.artifacts, tips: new Map(result.tips.map(tip => [tip.rootId, tip])) };
}
