/**
 * tools/trace-add-span.ts
 *
 * MCP tool: trace_add_span
 * Adds a new span to an existing trace run. Spans represent logical units
 * of work within a trace (e.g. a tool invocation, a reasoning step). Spans
 * can be nested via parentSpanId. The addSpan SDK call is synchronous.
 *
 * Dependencies:
 *   - addSpan from @fluxpointstudios/orynq-sdk-process-trace (sync)
 *   - TraceStore (../store.js) for run lookup
 *   - safeTool / toolError (../errors.js) for MCP result formatting
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { addSpan } from "@fluxpointstudios/orynq-sdk-process-trace";
import type { TraceStore } from "../store.js";
import type { Config } from "../config.js";
import { safeTool, toolError } from "../errors.js";

export function registerTraceAddSpan(
  server: McpServer,
  store: TraceStore,
  _config: Config,
) {
  server.tool(
    "trace_add_span",
    "Add a span to an existing trace. Spans group related events and can be nested. Returns the new span ID and name.",
    {
      traceId: z.string().describe("ID of the trace to add the span to"),
      name: z.string().describe("Human-readable name for the span"),
      parentSpanId: z.string().optional().describe("Optional parent span ID for nesting"),
      visibility: z.enum(["public", "private"]).optional().describe("Span visibility level (defaults to public)"),
      metadata: z.record(z.unknown()).optional().describe("Optional key-value metadata to attach to the span"),
    },
    async ({ traceId, name, parentSpanId, visibility, metadata }) => {
      const entry = store.get(traceId);
      if (!entry) return toolError(`Trace not found: ${traceId}`);

      return safeTool(async () => {
        const opts = { name, ...(parentSpanId !== undefined && { parentSpanId }), ...(visibility !== undefined && { visibility }), ...(metadata !== undefined && { metadata }) };
        const span = addSpan(entry.run, opts);
        return {
          spanId: span.id,
          name: span.name,
          traceId,
        };
      });
    },
  );
}
