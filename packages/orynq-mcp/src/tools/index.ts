/**
 * tools/index.ts
 *
 * Tool registration orchestrator for the orynq-mcp server. Imports all
 * individual tool modules and registers them with the MCP server instance.
 *
 * Tools are grouped into three categories:
 *   1. Trace lifecycle: create, add-span, append-events, close-span, finalize, summary
 *   2. Cardano anchoring: anchor-cardano-prepare, anchor-cardano-submit
 *   3. Verification & cost: verify-cardano-anchor, estimate-cost
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TraceStore } from "../store.js";
import type { Config } from "../config.js";

import { registerTraceCreate } from "./trace-create.js";
import { registerTraceAddSpan } from "./trace-add-span.js";
import { registerTraceAppendEvents } from "./trace-append-events.js";
import { registerTraceCloseSpan } from "./trace-close-span.js";
import { registerTraceFinalize } from "./trace-finalize.js";
import { registerTraceSummary } from "./trace-summary.js";
import { registerAnchorCardanoPrepare } from "./anchor-cardano-prepare.js";
import { registerAnchorCardanoSubmit } from "./anchor-cardano-submit.js";
import { registerAnchorMateriosSubmit } from "./anchor-materios-submit.js";
import { registerVerifyCardanoAnchor } from "./verify-cardano-anchor.js";
import { registerEstimateCost } from "./estimate-cost.js";

export function registerAllTools(
  server: McpServer,
  store: TraceStore,
  config: Config,
) {
  // Trace lifecycle tools
  registerTraceCreate(server, store, config);
  registerTraceAddSpan(server, store, config);
  registerTraceAppendEvents(server, store, config);
  registerTraceCloseSpan(server, store, config);
  registerTraceFinalize(server, store, config);
  registerTraceSummary(server, store, config);

  // Cardano direct anchoring (metadata label 2222 on Cardano L1)
  registerAnchorCardanoPrepare(server, store, config);
  registerAnchorCardanoSubmit(server, store, config);

  // Materios partner-chain anchoring (with automatic L1 checkpoint settlement)
  registerAnchorMateriosSubmit(server, store, config);

  // Verification & cost estimation tools
  registerVerifyCardanoAnchor(server, store, config);
  registerEstimateCost(server, store, config);
}
