import { checkpointFromJson, verifyCheckpointAdvance, type CheckpointAdvance } from "./checkpoint-advance.js";
import { auditCheckpoints, checkpointId } from "./checkpoints.js";
import { knownAuthorsSigningSummary, type KnownAuthors, type KnownAuthorsDocument } from "./known-authors.js";
import { parseStrictJson } from "./strict-json.js";

// A signing operator cannot introduce a prepared authority set on the strength of its JSON.
// Existing pins remain a prefix; every append is replayed from its pinned predecessor.
export async function reviewCheckpointSigning(document: string, evidence: unknown, policy: KnownAuthors): Promise<void> {
  knownAuthorsSigningSummary(document);
  const parsed = parseStrictJson(document) as KnownAuthorsDocument;
  if (!Array.isArray(evidence) || evidence.length > 64) throw new Error("Checkpoint signing evidence must be a bounded list");
  const unused = new Set(evidence.map((_, index) => index));
  for (const network of ["mainnet", "preprod"] as const) {
    const previous = policy.checkpoints(network);
    const next = (parsed.networks[network]?.checkpoints ?? []).map(checkpointFromJson);
    auditCheckpoints(previous, next);
    for (let index = previous.length; index < next.length; index++) {
      const predecessor = next[index - 1];
      if (!predecessor) throw new Error("Checkpoint bootstrap needs an independently reviewed pinned predecessor");
      const target = checkpointId(next[index]!);
      const matching = [...unused].filter(i => {
        const artifact = evidence[i] as Partial<CheckpointAdvance> | null;
        if (!artifact || artifact.network !== network) return false;
        try { return checkpointId(checkpointFromJson(artifact.successor)) === target; } catch { return false; }
      });
      if (matching.length !== 1) throw new Error("Every new checkpoint needs exactly one predecessor-authenticated derivation");
      const selected = matching[0]!;
      await verifyCheckpointAdvance({ artifact: evidence[selected], predecessor, expectedNetwork: network, expectedSequence: 1, previousDigest: null });
      unused.delete(selected);
    }
  }
  if (unused.size) throw new Error("Checkpoint signing evidence contains unused derivations");
}
