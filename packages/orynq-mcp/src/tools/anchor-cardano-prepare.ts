/**
 * tools/anchor-cardano-prepare.ts
 *
 * MCP tool: anchor_cardano_prepare
 * Prepares Cardano anchor metadata from a finalized trace bundle. This is a
 * read-only preparation step that computes hashes and serializes metadata
 * without touching the chain. The prepared anchor is stored back in the
 * TraceStore so that anchor_cardano_submit can pick it up later.
 *
 * Dependencies:
 *   - createAnchorEntryFromBundle, buildAnchorMetadata, serializeForCardanoCli
 *     from @fluxpointstudios/orynq-sdk-anchors-cardano (all sync)
 *   - TraceStore (../store.js) for trace lookup and update
 *   - safeTool / toolError (../errors.js) for MCP result formatting
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createAnchorEntryFromBundle,
  buildAnchorMetadata,
  serializeForCardanoCli,
} from "@fluxpointstudios/orynq-sdk-anchors-cardano";
import type { TraceStore } from "../store.js";
import type { Config } from "../config.js";
import { safeTool, toolError } from "../errors.js";

export function registerAnchorCardanoPrepare(
  server: McpServer,
  store: TraceStore,
  _config: Config,
) {
  server.tool(
    "anchor_cardano_prepare",
    "Prepare Cardano anchor metadata from a finalized trace. Does NOT sign or submit — safe to call.",
    {
      traceId: z.string().describe("ID of the finalized trace to anchor"),
      storageUri: z
        .string()
        .optional()
        .describe("Optional URI where the trace bundle is stored off-chain"),
    },
    async ({ traceId, storageUri }) => {
      const entry = store.get(traceId);
      if (!entry) return toolError(`Trace not found: ${traceId}`);

      if (!entry.bundle) {
        return toolError("Trace not finalized. Call trace_finalize first.");
      }

      return safeTool(async () => {
        const opts = storageUri !== undefined ? { storageUri } : {};
        const anchorEntry = createAnchorEntryFromBundle(entry.bundle!, opts);
        const txResult = buildAnchorMetadata(anchorEntry);
        const serialized = serializeForCardanoCli(txResult);

        store.set(traceId, { ...entry, preparedAnchor: txResult, anchorEntry });

        return {
          traceId,
          label: txResult.label,
          rootHash: anchorEntry.rootHash,
          manifestHash: anchorEntry.manifestHash,
          merkleRoot: anchorEntry.merkleRoot,
          serializedMetadata: serialized,
          status: "prepared",
        };
      });
    },
  );
}
