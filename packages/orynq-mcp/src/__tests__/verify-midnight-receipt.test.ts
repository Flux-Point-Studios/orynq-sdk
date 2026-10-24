import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type Config } from "../config.js";
import { registerVerifyMidnightReceipt } from "../tools/verify-midnight-receipt.js";
import { receiptSurface } from "../../../anchors-midnight/src/__tests__/receipt-surface.js";

let surface: Awaited<ReturnType<typeof receiptSurface>>;
beforeAll(async () => { surface = await receiptSurface(); });
afterAll(async () => { await surface.close(); });
beforeEach(() => surface.corrupt(false));
async function client(overrides: Partial<Config> = {}) {
  const server = new McpServer({ name: "receipt-test", version: "1" });
  registerVerifyMidnightReceipt(server, { ...loadConfig(), midnightProofGatewayUrl: surface.gateway, midnightProofRpcUrl: surface.node, ...overrides },
    { registries: [surface.fixture.chain.registry], knownAuthors: surface.fixture.authors });
  const [a,b] = InMemoryTransport.createLinkedPair(), result = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(b),result.connect(a)]); return result;
}
it("verifies caller-bound receipt evidence through the real MCP and HTTP protocols", async () => {
  const connection = await client();
  try {
    const tool = (await connection.listTools()).tools[0]!;
    expect(tool.name).toBe("verify_midnight_receipt"); expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    const result = await connection.callTool({ name: tool.name, arguments: surface.query });
    expect(result.isError).not.toBe(true);
    const value = JSON.parse((result.content as {text:string}[])[0]!.text);
    expect(value.status).toBe("valid"); expect(value.verification.certificateHash).toBe(surface.query.certificateHash);
    expect(value.verification.anchor.assurance).toBe("consensus-verified");
  } finally { await connection.close(); }
});
it.each(["receiptId", "contentHash", "certificateHash"] as const)("refuses substitution of the caller's %s before asking the chain", async field => {
  const connection = await client(), before = surface.chainRequests();
  try {
    const result = await connection.callTool({ name: "verify_midnight_receipt", arguments: { ...surface.query, [field]: "aa".repeat(32) } });
    const value = JSON.parse((result.content as {text:string}[])[0]!.text);
    expect(value.status).toBe("unresolved"); expect(surface.chainRequests()).toBe(before);
  } finally { await connection.close(); }
});
it("requires the new explicit proof endpoints and never echoes credential-bearing configuration", async () => {
  for (const overrides of [{ midnightProofGatewayUrl: undefined, midnightProofRpcUrl: undefined, midnightRpcUrl: surface.node, materiosBlobGatewayUrl: surface.gateway },
    { midnightProofGatewayUrl: "https://operator:do-not-echo@invalid.example/?token=do-not-echo" }]) {
    const connection = await client(overrides), before = surface.requests();
    try {
      const result = await connection.callTool({ name: "verify_midnight_receipt", arguments: surface.query });
      expect(result.isError).toBe(true); const text = (result.content as {text:string}[])[0]!.text;
      expect(text).not.toContain("do-not-echo"); expect(surface.requests()).toBe(before);
    } finally { await connection.close(); }
  }
});
it("rejects model-supplied endpoint and key fields before making an HTTP request", async () => {
  const connection = await client(), before = surface.requests();
  try {
    const result = await connection.callTool({ name: "verify_midnight_receipt", arguments: { ...surface.query, gatewayUrl: "https://untrusted.example", keyFile: "/unreadable" } });
    expect(result.isError).toBe(true); expect(surface.requests()).toBe(before);
  } finally { await connection.close(); }
});
it("returns unresolved for corrupt retained evidence and never reports exhausted hints as absence", async () => {
  surface.corrupt(); const connection = await client();
  try {
    const result = await connection.callTool({ name: "verify_midnight_receipt", arguments: surface.query });
    const value = JSON.parse((result.content as {text:string}[])[0]!.text);
    expect(value.status).toBe("unresolved"); expect(value.continuation).not.toBeNull(); expect(value.exhaustedHints).toBe(false);
    surface.corrupt(false);
    const resumed = await connection.callTool({ name: "verify_midnight_receipt", arguments: { ...surface.query, continuation: value.continuation } });
    expect(JSON.parse((resumed.content as {text:string}[])[0]!.text).status).toBe("valid");
    const changed = await connection.callTool({ name: "verify_midnight_receipt", arguments: { ...surface.query, contentHash: "aa".repeat(32), continuation: value.continuation } });
    expect(changed.isError).toBe(true); expect((changed.content as {text:string}[])[0]!.text).toContain("continuation");
  } finally { await connection.close(); }
});
