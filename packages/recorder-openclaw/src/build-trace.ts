import {
  createTrace,
  addSpan,
  addEvent,
  closeSpan,
  finalizeTrace,
  createManifest,
  type CustomEvent
} from "@fluxpointstudios/orynq-sdk-process-trace";
import { createHash } from "node:crypto";
import type { SpoolEvent } from "./spool.js";

/**
 * Deterministic JSON: object keys sorted at every level.
 *
 * JSON.stringify preserves insertion order, so two structurally identical
 * `data` objects built by different code paths could serialise differently and
 * produce different digests. Sorting removes that.
 */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

type CustomEventInput = Omit<CustomEvent, "id" | "seq" | "timestamp" | "hash">;

export async function buildTraceFromSpool(params: {
  agentId: string;
  spoolEvents: SpoolEvent[];
  chunkSize?: number;
}) {
  const { agentId, spoolEvents } = params;

  // Digest of exactly what goes into the anchored trace.
  //
  // This is the dedup key, and it MUST cover precisely the inputs to the
  // anchored root — no more, no less. More causes spurious re-anchoring (the
  // original bug: the manifest hash moved every cycle because createTrace,
  // addEvent and closeSpan all stamp the clock). Less causes SILENT gaps: a
  // first attempt keyed on (kind|contentHash) alone would have missed changes
  // to meta or sessionId, declared the bundle unchanged, and never anchored
  // the new root.
  //
  // Computed here, beside the events it describes, so the bytes the dedup
  // hashes and the bytes that get anchored cannot drift apart.
  const digestParts: string[] = [];
  const run = await createTrace({ agentId });
  const root = addSpan(run, { name: "OpenClawTrace", visibility: "private" });

  // We store only hashes by default, so represent each event as an observation/custom.
  for (const e of spoolEvents) {
    const data: Record<string, unknown> = {
      kind: e.kind,
      contentHash: e.contentHash,
      meta: e.meta ?? {}
    };
    if (e.sessionId !== undefined) data.sessionId = e.sessionId;
    if (e.content !== undefined && e.content !== null) data.content = e.content;

    const customEvent: CustomEventInput = {
      kind: "custom",
      eventType: "openclaw_event",
      data,
      visibility: "private"
    };

    digestParts.push(canonical(data));
    await addEvent(run, root.id, customEvent);
  }

  await closeSpan(run, root.id, "completed");
  const bundle = await finalizeTrace(run);

  const { manifest, chunks } = await createManifest(bundle, {
    chunkSize: params.chunkSize ?? 500_000,
    compression: "none"
  });

  // keep bundle.manifestHash aligned for downstream usage
  (bundle as { manifestHash?: string | undefined }).manifestHash = manifest.manifestHash;

  const contentDigest = createHash("sha256")
    .update(`${agentId}\n${digestParts.join("\n")}`)
    .digest("hex");

  return { bundle, manifest, chunks, contentDigest };
}
