import { afterEach, expect, it, vi } from "vitest";
import { merkleRoot, prepareBlobData, submitCertifiedReceipt } from "../index.js";
import type { MateriosProvider } from "../provider.js";

// submitCertifiedReceipt against a stubbed gateway and a provider whose submit_receipt extrinsic
// records its positional arguments and stops the flow there, so the test sees the exact receipt
// the chain would get: argument 2 is base_root_sha256 and argument 10 is schema_hash.
const STOP = new Error("receipt captured");
function capturingProvider() {
  const seen: unknown[][] = [];
  const api = { tx: { orinqReceipts: { submitReceipt: (...args: unknown[]) => { seen.push(args); throw STOP; } } } };
  const provider = { getApi: () => api, getKeypair: () => ({ address: "5Fixture", sign: () => new Uint8Array(64) }) } as unknown as MateriosProvider;
  return { provider, seen };
}
const slot = (args: unknown[] | undefined, index: number) => `0x${Buffer.from(args![index] as number[]).toString("hex")}`;
const gateway = { blobGateway: { baseUrl: "http://gateway.test", apiKey: "test-key" } };
const traceRoot = "ab".repeat(32);
const twoChunks = () => prepareBlobData(`0x${"00".repeat(32)}`, Buffer.alloc(300 * 1024, 7)).manifest.chunks;
afterEach(() => { vi.unstubAllGlobals(); });

it("submits the Merkle root of the uploaded chunks as a blob receipt's base root", async () => {
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 201 }));
  const { provider, seen } = capturingProvider();
  await expect(submitCertifiedReceipt(provider, { contentHash: traceRoot, rootHash: traceRoot, manifestHash: traceRoot }, Buffer.alloc(300 * 1024, 7), gateway)).rejects.toBe(STOP);
  const chunks = twoChunks();
  expect(chunks).toHaveLength(2);
  expect(slot(seen[0], 2)).toBe(merkleRoot(chunks.map((chunk) => chunk.sha256)));
});

it("treats an all-zero schema hash as a blob receipt", async () => {
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 201 }));
  const { provider, seen } = capturingProvider();
  await expect(submitCertifiedReceipt(provider, { contentHash: traceRoot, rootHash: traceRoot, manifestHash: traceRoot, schemaHash: "00".repeat(32) }, Buffer.alloc(300 * 1024, 7), gateway)).rejects.toBe(STOP);
  expect(slot(seen[0], 2)).toBe(merkleRoot(twoChunks().map((chunk) => chunk.sha256)));
});

it("treats a null schema hash from a JavaScript caller as a blob receipt", async () => {
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 201 }));
  const { provider, seen } = capturingProvider();
  const input = { contentHash: traceRoot, rootHash: traceRoot, manifestHash: traceRoot, schemaHash: null as unknown as string };
  await expect(submitCertifiedReceipt(provider, input, Buffer.alloc(300 * 1024, 7), gateway)).rejects.toBe(STOP);
  expect(slot(seen[0], 2)).toBe(merkleRoot(twoChunks().map((chunk) => chunk.sha256)));
  expect(slot(seen[0], 10)).toBe(`0x${"00".repeat(32)}`);
});

it("keeps the caller's root for a receipt class named by a schema hash", async () => {
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 201 }));
  const { provider, seen } = capturingProvider();
  await expect(submitCertifiedReceipt(provider, { contentHash: traceRoot, rootHash: traceRoot, manifestHash: traceRoot, schemaHash: "11".repeat(32) }, Buffer.from("record"), gateway)).rejects.toBe(STOP);
  expect(slot(seen[0], 2)).toBe(`0x${traceRoot}`);
});
