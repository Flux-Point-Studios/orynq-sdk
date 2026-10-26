import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTrace, addSpan, addEvent, closeSpan, finalizeTrace } from "@fluxpointstudios/orynq-sdk-process-trace";
import { createTraceStore } from "../store.js";
import { loadConfig } from "../config.js";
import { registerAnchorMateriosSubmit } from "../tools/anchor-materios-submit.js";

const calls = vi.hoisted(() => ({ submitted: [] as unknown[][], connections: 0 }));
vi.mock("@fluxpointstudios/orynq-sdk-anchors-materios", async original => {
  const sdk = await original<typeof import("@fluxpointstudios/orynq-sdk-anchors-materios")>();
  return {
    ...sdk,
    MateriosProvider: class {
      async connect() { calls.connections++; }
      async disconnect() {}
      getKeypair() { return { address: "5Fixture", sign: () => new Uint8Array(64) }; }
    },
    submitCertifiedReceipt: async (...args: unknown[]) => {
      calls.submitted.push(args);
      return { receiptId: (args[1] as { receiptId: string }).receiptId, certHash: `0x${"aa".repeat(32)}`, blockHash: `0x${"bb".repeat(32)}` };
    },
  };
});
afterEach(() => { calls.submitted.length = 0; calls.connections = 0; });

it.each([{ label: "single chunk", summary: "small" }, { label: "two chunks", summary: "x".repeat(270_000) }])("uses exact blob hashes in dry-run and submission ($label)", async ({ summary }) => {
  const run = await createTrace({ agentId: "mcp-receipt-test" });
  const span = addSpan(run, { name: "test", visibility: "public" });
  await addEvent(run, span.id, { kind: "observation", observation: summary, visibility: "public" });
  await closeSpan(run, span.id);
  const bundle = await finalizeTrace(run);
  const store = createTraceStore(); store.set(run.id, { run, bundle });
  const server = new McpServer({ name: "materios-test", version: "1" });
  registerAnchorMateriosSubmit(server, store, { ...loadConfig(), materiosRpcUrl: "wss://fixture.invalid", materiosSignerUri: "//Fixture" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (confirm: boolean) => {
    const result = await client.callTool({ name: "anchor_materios_submit", arguments: { traceId: run.id, confirm } });
    expect(result.isError).not.toBe(true);
    return JSON.parse((result.content as { text: string }[])[0]!.text);
  };
  try {
    const plan = (await call(false)).wouldSubmit;
    expect(calls.connections).toBe(0); expect(calls.submitted).toHaveLength(0);
    const result = await call(true);
    const [, input, content] = calls.submitted[0] as [unknown, Record<string, string>, Buffer];
    const hash = (data: Buffer) => createHash("sha256").update(data).digest();
    const expectedContentHash = `0x${hash(content).toString("hex")}`;
    const hashes: Buffer[] = [];
    for (let offset = 0; offset < content.length; offset += 256 * 1024) hashes.push(hash(content.subarray(offset, offset + 256 * 1024)));
    const expectedRoot = `0x${(hashes.length === 1 ? hashes[0]! : hash(Buffer.concat(hashes))).toString("hex")}`;
    expect(input.contentHash).toBe(expectedContentHash);
    expect(input.rootHash).toBe(expectedRoot);
    expect(input.contentHash).not.toBe(bundle.rootHash);
    expect(input.receiptId).toBe(`0x${hash(Buffer.from(expectedContentHash.slice(2), "hex")).toString("hex")}`);
    for (const field of ["receiptId", "contentHash", "rootHash", "manifestHash"]) expect(plan[field]).toBe(input[field]);
    expect(result.contentHash).toBe(expectedContentHash); expect(result.rootHash).toBe(expectedRoot);
    expect(result.certHash).toBe(`0x${"aa".repeat(32)}`);
    expect(hashes.length).toBe(summary.length > 256 * 1024 ? 2 : 1);
    if (hashes.length === 2) expect(input.rootHash).not.toBe(expectedContentHash);
  } finally { await client.close(); await server.close(); }
});
