// packages/orynq-mcp/src/server.ts
// Factory for the orynq-mcp MCP server instance.
// Composes configuration, in-memory store, and tool registrations
// into a ready-to-connect McpServer. Called by index.ts (the CLI
// entry point) and can also be imported for programmatic use.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { createTraceStore } from "./store.js";
import { registerAllTools } from "./tools/index.js";

export function createOrynqServer() {
  const config = loadConfig();
  const store = createTraceStore();

  const server = new McpServer({
    name: "orynq-mcp",
    version: "0.1.0",
  });

  registerAllTools(server, store, config);

  return { server, config, store };
}
