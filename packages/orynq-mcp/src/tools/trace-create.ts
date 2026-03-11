/**
 * tools/trace-create.ts
 *
 * MCP tool: trace_create
 * Creates a new trace run for a given agent. This is the entry point of the
 * trace lifecycle -- every trace begins here and later moves through span
 * creation, event appending, and finalization.
 *
 * Dependencies:
 *   - createTrace from @fluxpointstudios/orynq-sdk-process-trace (async)
 *   - TraceStore (../store.js) for in-memory run persistence
 *   - safeTool / toolError (../errors.js) for MCP result formatting
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createTrace } from "@fluxpointstudios/orynq-sdk-process-trace";
import type { TraceStore } from "../store.js";
import type { Config } from "../config.js";
import { safeTool } from "../errors.js";

export function registerTraceCreate(
  server: McpServer,
  store: TraceStore,
  _config: Config,
) {
  server.tool(
    "trace_create",
    "Create a new trace run for an agent. Returns the trace ID, initial status, and start timestamp.",
    {
      agentId: z.string().describe("Unique identifier of the agent initiating the trace"),
      description: z.string().optional().describe("Optional human-readable description of the trace purpose"),
      metadata: z.record(z.unknown()).optional().describe("Optional key-value metadata to attach to the trace"),
    },
    async ({ agentId, description, metadata }) => {
      return safeTool(async () => {
        const opts = { agentId, ...(description !== undefined && { description }), ...(metadata !== undefined && { metadata }) };
        const run = await createTrace(opts);
        store.set(run.id, { run });
        return {
          traceId: run.id,
          status: run.status,
          startedAt: run.startedAt,
        };
      });
    },
  );
}
