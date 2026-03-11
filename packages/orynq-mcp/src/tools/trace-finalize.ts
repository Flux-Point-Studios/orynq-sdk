/**
 * tools/trace-finalize.ts
 *
 * MCP tool: trace_finalize
 * Finalizes a trace run, producing a TraceBundle with root hash, merkle root,
 * and public view summary. The bundle is persisted back into the store for
 * later anchoring or verification. After finalization the trace is immutable.
 *
 * Dependencies:
 *   - finalizeTrace from @fluxpointstudios/orynq-sdk-process-trace (async)
 *   - TraceStore (../store.js) for run lookup and bundle persistence
 *   - safeTool / toolError (../errors.js) for MCP result formatting
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { finalizeTrace } from "@fluxpointstudios/orynq-sdk-process-trace";
import type { TraceStore } from "../store.js";
import type { Config } from "../config.js";
import { safeTool, toolError } from "../errors.js";

export function registerTraceFinalize(
  server: McpServer,
  store: TraceStore,
  _config: Config,
) {
  server.tool(
    "trace_finalize",
    "Finalize a trace run, producing an immutable bundle with root hash and merkle root. The trace cannot be modified after finalization.",
    {
      traceId: z.string().describe("ID of the trace to finalize"),
    },
    async ({ traceId }) => {
      const entry = store.get(traceId);
      if (!entry) return toolError(`Trace not found: ${traceId}`);

      return safeTool(async () => {
        const bundle = await finalizeTrace(entry.run);
        store.set(traceId, { ...entry, bundle });
        return {
          traceId,
          rootHash: bundle.rootHash,
          merkleRoot: bundle.merkleRoot,
          itemCount: bundle.publicView.totalEvents,
          status: "finalized",
        };
      });
    },
  );
}
