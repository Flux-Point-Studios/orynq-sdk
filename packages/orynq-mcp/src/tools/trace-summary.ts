/**
 * tools/trace-summary.ts
 *
 * MCP tool: trace_summary
 * Returns a read-only summary of a trace's current state without modifying
 * anything. Useful for agents to inspect progress, check finalization status,
 * and determine whether an anchor has been prepared or submitted.
 *
 * Dependencies:
 *   - TraceStore (../store.js) for entry lookup
 *   - safeTool / toolError (../errors.js) for MCP result formatting
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  GovernanceAttestationEvent,
  ToolReceiptEvent,
} from "@fluxpointstudios/orynq-sdk-process-trace";
import type { TraceStore } from "../store.js";
import type { Config } from "../config.js";
import { safeTool, toolError } from "../errors.js";

export function registerTraceSummary(
  server: McpServer,
  store: TraceStore,
  _config: Config,
) {
  server.tool(
    "trace_summary",
    "Get a read-only summary of a trace's current state including event/span counts, finalization status, anchor info, governance attestations, tool receipts, and the pinned model manifest.",
    {
      traceId: z.string().describe("ID of the trace to summarize"),
    },
    async ({ traceId }) => {
      const entry = store.get(traceId);
      if (!entry) return toolError(`Trace not found: ${traceId}`);

      return safeTool(async () => {
        // Surface governance attestations distinctly (issue #58).
        const governanceAttestations = entry.run.events
          .filter((e): e is GovernanceAttestationEvent => e.kind === "governance-attestation")
          .map((e) => ({
            role: e.role,
            attestor: e.attestor.address,
            scheme: e.attestor.signatureScheme,
            policyRef: e.policyRef,
            decisionRef: e.decisionRef,
            signedAt: e.signedAt,
          }));

        // Surface tool-call receipts distinctly (issue #60).
        const toolReceipts = entry.run.events
          .filter((e): e is ToolReceiptEvent => e.kind === "tool-receipt")
          .map((e) => ({
            toolId: e.toolId,
            scheme: e.receipt.scheme,
            signer: e.receipt.signer,
          }));

        return {
          traceId,
          agentId: entry.run.agentId,
          status: entry.run.status,
          eventCount: entry.run.events.length,
          spanCount: entry.run.spans.length,
          isFinalized: !!entry.bundle,
          hasPreparedAnchor: !!entry.preparedAnchor,
          txHash: entry.cardanoTxHash,
          // Pre-execution model manifest pin (issue #59).
          modelManifestHash: entry.run.modelManifestHash,
          modelManifest: entry.run.modelManifest,
          governanceCount: governanceAttestations.length,
          governanceAttestations,
          toolReceiptCount: toolReceipts.length,
          toolReceipts,
        };
      });
    },
  );
}
