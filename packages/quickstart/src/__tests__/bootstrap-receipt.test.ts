import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";

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
    submitReceipt: async (...args: unknown[]) => { calls.submit.push(args); return { receiptId: (args[1] as { receiptId: string }).receiptId, blockHash: `0x${"22".repeat(32)}` }; },
  };
});

const roots: string[] = [];
afterEach(() => {
  calls.upload.length = 0; calls.submit.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("uploads the blob under its content hash and puts its chunk Merkle root on chain", async () => {
  const { bootstrapAndTrace } = await import("../bootstrap.js");
  const { merkleRoot } = await import("@fluxpointstudios/orynq-sdk-anchors-materios");
  const root = mkdtempSync(join(tmpdir(), "quickstart-receipt-")); roots.push(root);
  const result = await bootstrapAndTrace({ configPath: join(root, "config.json"), skipFaucet: true, certTimeoutMs: 0 });
  const contentHash = result.bundle.manifestHash.replace(/^0x/, "");

  const [uploadKey, manifest] = calls.upload[0] as [string, { chunks: { sha256: string }[] }];
  expect(uploadKey).toBe(contentHash);
  const [, receipt] = calls.submit[0] as [unknown, { contentHash: string; rootHash: string }];
  expect(receipt.rootHash).toBe(merkleRoot(manifest.chunks.map((chunk) => chunk.sha256)));
  expect(receipt.rootHash).toBe(`0x${contentHash}`);
  expect(result.urls.blobStatus).toContain(`/blobs/${contentHash}/status`);
}, 30_000);
