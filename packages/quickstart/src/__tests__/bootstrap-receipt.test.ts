import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { bootstrapAndTrace } from "../bootstrap.js";
import { merkleRoot } from "@fluxpointstudios/orynq-sdk-anchors-materios";

// bootstrapAndTrace with the chain and gateway calls stubbed and the SDK's blob layout and Merkle
// rule kept real, so what it uploads and what it puts on chain are what the committee checks:
// the gateway resolves a receipt to its content hash and reads the manifest stored under it, and
// the daemon requires the on-chain root to equal the Merkle root of the uploaded chunk hashes.
const calls = vi.hoisted(() => ({ upload: [] as unknown[][], submit: [] as unknown[][] }));
vi.mock("@fluxpointstudios/orynq-sdk-anchors-materios", async (original) => {
  const sdk = await original<typeof import("@fluxpointstudios/orynq-sdk-anchors-materios")>();
  class MateriosProvider {
    async connect() {}
    async disconnect() {}
    getKeypair() { return { address: "5Fixture", sign: () => new Uint8Array(64) }; }
  }
  return {
    ...sdk,
    MateriosProvider,
    waitForMotra: async () => 10n ** 13n,
    uploadBlobs: async (...args: unknown[]) => { calls.upload.push(args); return { success: true, storageLocatorHash: `0x${"11".repeat(32)}` }; },
    waitForCertification: async () => ({ certHash: `0x${"33".repeat(32)}` }),
    submitReceipt: async (...args: unknown[]) => { calls.submit.push(args); return { receiptId: (args[1] as { receiptId: string }).receiptId, blockHash: `0x${"22".repeat(32)}` }; },
  };
});

const roots: string[] = [];
afterEach(() => {
  calls.upload.length = 0; calls.submit.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("uploads the blob under its content hash and puts its chunk Merkle root on chain", async () => {
  const root = mkdtempSync(join(tmpdir(), "quickstart-receipt-")); roots.push(root);
  const result = await bootstrapAndTrace({ configPath: join(root, "config.json"), skipFaucet: true, certTimeoutMs: 0 });
  const contentHash = result.bundle.manifestHash.replace(/^0x/, "");

  const [uploadKey, manifest] = calls.upload[0] as [string, { chunks: { sha256: string }[] }];
  expect(uploadKey).toBe(contentHash);
  const [, receipt] = calls.submit[0] as [unknown, { contentHash: string; rootHash: string }];
  expect(receipt.rootHash).toBe(merkleRoot(manifest.chunks.map((chunk) => chunk.sha256)));
  expect(receipt.rootHash).toBe(`0x${contentHash}`);
  expect(result.contentHash).toBe(`0x${contentHash}`);
  expect(result.rootHash).toBe(receipt.rootHash);
  expect(result.certHash).toBeUndefined();
  expect(result.urls.blobStatus).toContain(`/blobs/${contentHash}/status`);
}, 30_000);


it("submits the complete two-chunk root and returns the full verification identities", async () => {
  const root = mkdtempSync(join(tmpdir(), "quickstart-large-receipt-")); roots.push(root);
  const result = await bootstrapAndTrace({ configPath: join(root, "config.json"), skipFaucet: true, summary: "x".repeat(270_000) });
  const content = Buffer.from(result.bundle.content, "utf8");
  const hash = (value: Buffer) => createHash("sha256").update(value).digest();
  expect(content.length).toBeGreaterThan(256 * 1024);
  expect(content.length).toBeLessThan(512 * 1024);
  const first = hash(content.subarray(0, 256 * 1024));
  const second = hash(content.subarray(256 * 1024));
  const expectedRoot = `0x${hash(Buffer.concat([first, second])).toString("hex")}`;
  const [, receipt] = calls.submit[0] as [unknown, { contentHash: string; rootHash: string }];
  expect(receipt.rootHash).toBe(expectedRoot);
  expect(receipt.rootHash).not.toBe(`0x${hash(content).toString("hex")}`);
  expect(receipt.rootHash).not.toBe(`0x${first.toString("hex")}`);
  expect(result.contentHash).toBe(`0x${hash(content).toString("hex")}`);
  expect(result.rootHash).toBe(expectedRoot);
  expect(result.certHash).toBe(`0x${"33".repeat(32)}`);
}, 30_000);
