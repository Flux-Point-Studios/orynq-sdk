import type {
  AnnotatedSpan,
  TraceBundlePublicView,
  TraceEvent,
  TraceRun,
} from "./types.js";
import { compareCodeUnits } from "./order.js";

/**
 * The public view of a run: its public spans with their public events in
 * `spanSeq` and `seq` order, and the hashes of its other spans ordered by the
 * UTF-16 code units of their span IDs. A run without an end time reports its
 * start time.
 *
 * @param run - The finalized trace run
 * @param merkleRoot - The Merkle root of the run's spans
 * @returns The public view of the run
 */
export function createPublicView(
  run: TraceRun,
  merkleRoot: string
): TraceBundlePublicView {
  const eventMap = new Map(run.events.map((event) => [event.id, event]));

  const publicSpans: AnnotatedSpan[] = [];
  const redactedSpanHashes: Array<{ spanId: string; hash: string }> = [];

  for (const span of run.spans) {
    if (span.visibility === "public") {
      const events = span.eventIds
        .map((id) => eventMap.get(id))
        .filter((event): event is TraceEvent => event?.visibility === "public")
        .sort((a, b) => a.seq - b.seq);
      publicSpans.push({ ...span, events });
    } else if (span.hash) {
      redactedSpanHashes.push({ spanId: span.id, hash: span.hash });
    }
  }

  publicSpans.sort((a, b) => a.spanSeq - b.spanSeq);
  redactedSpanHashes.sort((a, b) => compareCodeUnits(a.spanId, b.spanId));

  return {
    runId: run.id,
    agentId: run.agentId,
    schemaVersion: run.schemaVersion,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? run.startedAt,
    durationMs: run.durationMs ?? 0,
    status: run.status,
    totalEvents: run.events.length,
    totalSpans: run.spans.length,
    rootHash: run.rootHash ?? "",
    merkleRoot,
    publicSpans,
    redactedSpanHashes,
  };
}
