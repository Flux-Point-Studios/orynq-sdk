import { sha256 } from "@noble/hashes/sha2.js";
import type { FinalityCheckpoint } from "./grandpa.js";
import { toHex } from "./scale.js";

export function checkpointId(checkpoint: FinalityCheckpoint): string {
  const body = [checkpoint.setId.toString(), checkpoint.startsAfter.height, checkpoint.startsAfter.hash, checkpoint.authorities.map((a) => [a.key, a.weight.toString()])];
  return toHex(sha256(new TextEncoder().encode(`orynq:finality-checkpoint:v1\n${JSON.stringify(body)}`)));
}

export function auditCheckpoints(previous: readonly FinalityCheckpoint[], next: readonly FinalityCheckpoint[]): void {
  if (next.length < previous.length || previous.some((c, i) => checkpointId(c) !== checkpointId(next[i]!))) {
    throw new Error("Checkpoint history must be a prefix extension; entries cannot be edited or dropped");
  }
}
