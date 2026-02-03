import {
  createTrace,
  addSpan,
  addEvent,
  closeSpan,
  finalizeTrace,
  createManifest,
  type CustomEvent
} from "@fluxpointstudios/orynq-sdk-process-trace";
import type { SpoolEvent } from "./spool.js";

type CustomEventInput = Omit<CustomEvent, "id" | "seq" | "timestamp" | "hash">;

export async function buildTraceFromSpool(params: {
  agentId: string;
  spoolEvents: SpoolEvent[];
  chunkSize?: number;
}) {
  const { agentId, spoolEvents } = params;

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

  return { bundle, manifest, chunks };
}
