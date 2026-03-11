/**
 * tools/trace-close-span.ts
 *
 * MCP tool: trace_close_span
 * Closes an open span within a trace, marking it as complete. Once closed,
 * no further events should be appended to the span. This is an async
 * SDK operation.
 *
 * Dependencies:
 *   - closeSpan from @fluxpointstudios/orynq-sdk-process-trace (async)
 *   - TraceStore (../store.js) for run lookup
 *   - safeTool / toolError (../errors.js) for MCP result formatting
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { closeSpan } from "@fluxpointstudios/orynq-sdk-process-trace";
import type { TraceStore } from "../store.js";
import type { Config } from "../config.js";
import { safeTool, toolError } from "../errors.js";

export function registerTraceCloseSpan(
  server: McpServer,
  store: TraceStore,
  _config: Config,
) {
  server.tool(
    "trace_close_span",
    "Close an open span within a trace, marking it as complete.",
    {
      traceId: z.string().describe("ID of the trace containing the span"),
      spanId: z.string().describe("ID of the span to close"),
    },
    async ({ traceId, spanId }) => {
      const entry = store.get(traceId);
      if (!entry) return toolError(`Trace not found: ${traceId}`);

      return safeTool(async () => {
        await closeSpan(entry.run, spanId);
        return {
          spanId,
          closed: true,
        };
      });
    },
  );
}
