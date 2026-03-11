/**
 * tools/estimate-cost.ts
 *
 * MCP tool: estimate_cost
 * Estimates the ADA fee for anchoring a trace to Cardano. Accepts either a
 * traceId (to measure a previously prepared anchor) or an explicit byte size.
 * The formula is a linear approximation based on Cardano fee parameters.
 *
 * Dependencies:
 *   - serializeForCardanoCli from @fluxpointstudios/orynq-sdk-anchors-cardano (sync)
 *   - TraceStore (../store.js) for trace lookup when traceId is provided
 *   - Config (../config.js) for network info
 *   - safeTool / toolError (../errors.js) for MCP result formatting
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { serializeForCardanoCli } from "@fluxpointstudios/orynq-sdk-anchors-cardano";
import type { TraceStore } from "../store.js";
import type { Config } from "../config.js";
import { safeTool, toolError } from "../errors.js";

export function registerEstimateCost(
  server: McpServer,
  store: TraceStore,
  config: Config,
) {
  server.tool(
    "estimate_cost",
    "Estimate the ADA fee for anchoring a trace to Cardano.",
    {
      traceId: z
        .string()
        .optional()
        .describe(
          "ID of a trace with a prepared anchor. Used to compute metadata size automatically.",
        ),
      metadataSizeBytes: z
        .number()
        .optional()
        .describe(
          "Explicit metadata size in bytes. Used when traceId is not provided.",
        ),
    },
    async ({ traceId, metadataSizeBytes }) => {
      let sizeBytes: number;

      if (traceId) {
        const entry = store.get(traceId);
        if (!entry) return toolError(`Trace not found: ${traceId}`);

        if (!entry.preparedAnchor) {
          return toolError(
            "Anchor not prepared for this trace. Call anchor_cardano_prepare first.",
          );
        }

        sizeBytes = serializeForCardanoCli(entry.preparedAnchor).length;
      } else if (metadataSizeBytes !== undefined) {
        sizeBytes = metadataSizeBytes;
      } else {
        return toolError(
          "Provide either traceId (with prepared anchor) or metadataSizeBytes.",
        );
      }

      return safeTool(async () => {
        const estimatedAdaFee = 0.17 + sizeBytes * 0.0000155;

        return {
          estimatedAdaFee: Number(estimatedAdaFee.toFixed(6)),
          metadataSizeBytes: sizeBytes,
          network: config.cardanoNetwork,
          note: "Estimate only. Actual fee depends on transaction size and network parameters.",
        };
      });
    },
  );
}
