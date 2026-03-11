/**
 * tools/anchor-cardano-submit.ts
 *
 * MCP tool: anchor_cardano_submit
 * Submits a prepared anchor transaction to Cardano. Marked as destructive
 * because it would spend UTxOs on-chain. In v1 full payer integration is
 * not yet available, so the tool returns the serialized metadata and
 * instructions for manual submission via cardano-cli.
 *
 * Dependencies:
 *   - serializeForCardanoCli from @fluxpointstudios/orynq-sdk-anchors-cardano (sync)
 *   - TraceStore (../store.js) for trace lookup
 *   - Config (../config.js) for signer key and network settings
 *   - safeTool / toolError (../errors.js) for MCP result formatting
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { serializeForCardanoCli } from "@fluxpointstudios/orynq-sdk-anchors-cardano";
import type { TraceStore } from "../store.js";
import type { Config } from "../config.js";
import { safeTool, toolError } from "../errors.js";

export function registerAnchorCardanoSubmit(
  server: McpServer,
  store: TraceStore,
  config: Config,
) {
  server.tool(
    "anchor_cardano_submit",
    "Submit a prepared anchor transaction to Cardano. HIGH RISK — requires signer key and explicit confirmation.",
    {
      traceId: z.string().describe("ID of the trace whose anchor to submit"),
      confirm: z
        .literal(true)
        .describe("Must be true to confirm submission"),
    },
    { destructiveHint: true, readOnlyHint: false },
    async ({ traceId }) => {
      const entry = store.get(traceId);
      if (!entry) return toolError(`Trace not found: ${traceId}`);

      if (!entry.bundle) {
        return toolError("Trace not finalized.");
      }

      if (!entry.preparedAnchor) {
        return toolError(
          "Anchor not prepared. Call anchor_cardano_prepare first.",
        );
      }

      if (!config.cardanoSignerKey) {
        return toolError(
          "CARDANO_SIGNER_KEY not configured. Cannot submit without signer.",
        );
      }

      return safeTool(async () => {
        const serialized = serializeForCardanoCli(entry.preparedAnchor!);

        return {
          traceId,
          status: "manual_submission_required",
          network: config.cardanoNetwork,
          serializedMetadata: serialized,
          instructions:
            "Full payer integration pending. Use serialized metadata with cardano-cli to submit.",
        };
      });
    },
  );
}
