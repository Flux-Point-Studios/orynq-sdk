// packages/orynq-mcp/src/index.ts
// CLI entry point for the orynq-mcp server.
// Boots the MCP server over stdio transport so it can be invoked
// by Claude Desktop, Claude Code, or any MCP-compatible client.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createOrynqServer } from "./server.js";

async function main() {
  const { server } = createOrynqServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("orynq-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
