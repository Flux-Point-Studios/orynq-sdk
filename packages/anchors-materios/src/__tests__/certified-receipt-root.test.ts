import { afterEach, expect, it, vi } from "vitest";
import { merkleRoot, prepareBlobData, submitCertifiedReceipt } from "../index.js";
import type { MateriosProvider } from "../provider.js";

// submitCertifiedReceipt against a stubbed gateway and a provider whose submit_receipt extrinsic
// records its positional arguments and stops the flow there, so the test sees the exact receipt
// the chain would get: argument 2 is base_root_sha256.
const STOP = new Error("receipt captured");
function capturingProvider() {
  const seen: unknown[][] = [];
  const api = { tx: { orinqReceipts: { submitReceipt: (...args: unknown[]) => { seen.push(args); throw STOP; } } } };
  const provider = { getApi: () => api, getKeypair: () => ({ address: "5Fixture", sign: () => new Uint8Array(64) }) } as unknown as MateriosProvider;
  return { provider, seen };
}
const baseRoot = (args: unknown[] | undefined) => `0x${Buffer.from(args![2] as number[]).toString("hex")}`;
const gateway = { blobGateway: { baseUrl: "http://gateway.test", apiKey: "test-key" } };
const traceRoot = "ab".repeat(32);
afterEach(() => { vi.unstubAllGlobals(); });

it("submits the Merkle root of the uploaded chunks as a blob receipt's base root", async () => {
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 201 }));
  const content = Buffer.alloc(300 * 1024, 7);
  const { provider, seen } = capturingProvider();
  await expect(submitCertifiedReceipt(provider, { contentHash: traceRoot, rootHash: traceRoot, manifestHash: traceRoot }, content, gateway)).rejects.toBe(STOP);
  const chunks = prepareBlobData(`0x${"00".repeat(32)}`, content).manifest.chunks;
  expect(chunks).toHaveLength(2);
  expect(baseRoot(seen[0])).toBe(merkleRoot(chunks.map((chunk) => chunk.sha256)));
});

it("treats an all-zero schema hash as a blob receipt", async () => {
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 201 }));
  const content = Buffer.from("one chunk");
  const { provider, seen } = capturingProvider();
  await expect(submitCertifiedReceipt(provider, { contentHash: traceRoot, rootHash: traceRoot, manifestHash: traceRoot, schemaHash: "00".repeat(32) }, content, gateway)).rejects.toBe(STOP);
  const chunks = prepareBlobData(`0x${"00".repeat(32)}`, content).manifest.chunks;
  expect(baseRoot(seen[0])).toBe(merkleRoot(chunks.map((chunk) => chunk.sha256)));
});

it("keeps the caller's root for a receipt class named by a schema hash", async () => {
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 201 }));
  const { provider, seen } = capturingProvider();
  await expect(submitCertifiedReceipt(provider, { contentHash: traceRoot, rootHash: traceRoot, manifestHash: traceRoot, schemaHash: "11".repeat(32) }, Buffer.from("record"), gateway)).rejects.toBe(STOP);
  expect(baseRoot(seen[0])).toBe(`0x${traceRoot}`);
});
