/**
 * tools/verify-cardano-anchor.ts
 *
 * MCP tool: verify_cardano_anchor
 * Verifies a Cardano anchor by looking up a transaction on-chain and checking
 * whether its metadata matches the expected root hash. Read-only -- only
 * queries chain data via Blockfrost or Koios provider.
 *
 * Dependencies:
 *   - verifyAnchor, createBlockfrostProvider, createKoiosProvider
 *     from @fluxpointstudios/orynq-sdk-anchors-cardano (async)
 *   - Config (../config.js) for provider credentials and network
 *   - safeTool / toolError (../errors.js) for MCP result formatting
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  verifyAnchor,
  createBlockfrostProvider,
  createKoiosProvider,
} from "@fluxpointstudios/orynq-sdk-anchors-cardano";
import type { TraceStore } from "../store.js";
import type { Config } from "../config.js";
import { safeTool, toolError } from "../errors.js";

export function registerVerifyCardanoAnchor(
  server: McpServer,
  _store: TraceStore,
  config: Config,
) {
  server.tool(
    "verify_cardano_anchor",
    "Verify a Cardano anchor by transaction hash. Read-only — queries chain data.",
    {
      txHash: z
        .string()
        .describe("Cardano transaction hash containing the anchor metadata"),
      expectedRootHash: z
        .string()
        .describe("Expected root hash to verify against the on-chain data"),
    },
    async ({ txHash, expectedRootHash }) => {
      // Resolve a chain provider from configuration
      if (!config.blockfrostProjectId && !config.koiosNetwork) {
        return toolError(
          "No chain provider configured. Set BLOCKFROST_PROJECT_ID or KOIOS_NETWORK.",
        );
      }

      return safeTool(async () => {
        const provider = config.blockfrostProjectId
          ? createBlockfrostProvider({
              projectId: config.blockfrostProjectId,
              network: config.cardanoNetwork,
            })
          : createKoiosProvider({
              network: config.cardanoNetwork,
            });

        const result = await verifyAnchor(provider, txHash, expectedRootHash);

        return {
          valid: result.valid,
          txInfo: result.txInfo,
          entries: result.anchor ? [result.anchor] : [],
          errors: result.errors,
          warnings: result.warnings,
        };
      });
    },
  );
}
