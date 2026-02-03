import {
  createTrace,
  addSpan,
  addEvent,
  closeSpan,
  finalizeTrace,
  createManifest
} from "@fluxpointstudios/orynq-sdk-process-trace";
import type { SpoolEvent } from "./spool.js";

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
    const data = {
      kind: e.kind,
      sessionId: e.sessionId,
      contentHash: e.contentHash,
      ...(e.content ? { content: e.content } : {}),
      meta: e.meta ?? {}
    };

    await addEvent(run, root.id, {
      kind: "custom",
      eventType: "openclaw_event",
      data,
      visibility: "private"
    });
  }

  await closeSpan(run, root.id, "completed");
  const bundle = await finalizeTrace(run);

  const { manifest, chunks } = await createManifest(bundle, {
    chunkSize: params.chunkSize ?? 500_000,
    compression: "none"
  });

  // keep bundle.manifestHash aligned for downstream usage
  bundle.manifestHash = manifest.manifestHash;

  return { bundle, manifest, chunks };
}
