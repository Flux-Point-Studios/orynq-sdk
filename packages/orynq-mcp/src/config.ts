// packages/orynq-mcp/src/config.ts
// Runtime configuration for the orynq-mcp server.
// Reads environment variables and returns a typed Config object.
// Used by server.ts when creating the MCP server instance.

import type { CardanoNetwork } from "@fluxpointstudios/orynq-sdk-anchors-cardano";

export interface Config {
  blockfrostProjectId: string | undefined;
  koiosNetwork: string | undefined;
  cardanoNetwork: CardanoNetwork;
  cardanoSignerKey: string | undefined;
  transport: "stdio";
  port: number;
}

export function loadConfig(): Config {
  return {
    blockfrostProjectId: process.env["BLOCKFROST_PROJECT_ID"],
    koiosNetwork: process.env["KOIOS_NETWORK"],
    cardanoNetwork:
      (process.env["CARDANO_NETWORK"] as CardanoNetwork) ?? "preprod",
    cardanoSignerKey: process.env["CARDANO_SIGNER_KEY"],
    transport: "stdio",
    port: Number(process.env["ORYNQ_MCP_PORT"] ?? "3100"),
  };
}
