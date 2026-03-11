/**
 * tools/trace-append-events.ts
 *
 * MCP tool: trace_append_events
 * Appends one or more events to a span within an existing trace. Events are
 * the atomic units of a trace record (commands, outputs, decisions, etc.).
 * Each event is added sequentially via the async addEvent SDK call.
 *
 * Dependencies:
 *   - addEvent from @fluxpointstudios/orynq-sdk-process-trace (async)
 *   - TraceStore (../store.js) for run lookup
 *   - safeTool / toolError (../errors.js) for MCP result formatting
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { addEvent } from "@fluxpointstudios/orynq-sdk-process-trace";
import type { TraceStore } from "../store.js";
import type { Config } from "../config.js";
import { safeTool, toolError } from "../errors.js";

export function registerTraceAppendEvents(
  server: McpServer,
  store: TraceStore,
  _config: Config,
) {
  server.tool(
    "trace_append_events",
    "Append one or more events to a span in a trace. Events capture discrete actions like commands, outputs, decisions, or errors.",
    {
      traceId: z.string().describe("ID of the trace containing the target span"),
      spanId: z.string().describe("ID of the span to append events to"),
      events: z
        .array(
          z.object({
            kind: z
              .enum(["command", "output", "decision", "observation", "error", "custom"])
              .describe("Category of the event"),
            content: z.string().optional().describe("Event content / body text"),
            command: z.string().optional().describe("Command string if kind is 'command'"),
            visibility: z
              .enum(["public", "private"])
              .optional()
              .describe("Event visibility level"),
            metadata: z
              .record(z.unknown())
              .optional()
              .describe("Optional key-value metadata"),
          }),
        )
        .min(1)
        .describe("Array of events to append (at least one required)"),
    },
    async ({ traceId, spanId, events }) => {
      const entry = store.get(traceId);
      if (!entry) return toolError(`Trace not found: ${traceId}`);

      return safeTool(async () => {
        const eventIds: string[] = [];
        for (const event of events) {
          const cleaned: Record<string, unknown> = { kind: event.kind };
          if (event.content !== undefined) cleaned["content"] = event.content;
          if (event.command !== undefined) cleaned["command"] = event.command;
          if (event.visibility !== undefined) cleaned["visibility"] = event.visibility;
          if (event.metadata !== undefined) cleaned["metadata"] = event.metadata;
          const result = await addEvent(entry.run, spanId, cleaned as Parameters<typeof addEvent>[2]);
          eventIds.push(result.id);
        }
        return {
          appended: eventIds.length,
          eventIds,
          traceId,
        };
      });
    },
  );
}
