/**
 * Locator routes for cert daemon compatibility.
 */

import { Router, type Request, type Response } from "express";
import { resolveReceiptId, getManifest } from "../storage.js";
import { config } from "../config.js";

export const locatorsRouter = Router();

interface ManifestChunk {
  index: number;
  sha256: string;
  size: number;
  url?: string;
  path?: string;
}

interface Manifest {
  total_size?: number;
  chunks: ManifestChunk[];
  [key: string]: unknown;
}

/**
 * GET /locators/:receiptId
 * Resolves receiptId to contentHash, reads manifest, transforms chunk URLs
 * to point to this gateway's /chunks/ endpoint.
 * Returns daemon-compatible locator format.
 */
locatorsRouter.get("/locators/:receiptId", async (req: Request, res: Response) => {
  try {
    const { receiptId } = req.params;
    const contentHash = await resolveReceiptId(receiptId);

    if (!contentHash) {
      res.status(404).json({ error: "Receipt not found" });
      return;
    }

    const manifest = await getManifest(contentHash) as Manifest | null;
    if (!manifest) {
      res.status(404).json({ error: "Manifest not found" });
      return;
    }

    // Ensure receiptId has 0x prefix for response
    const receiptIdPrefixed = receiptId.startsWith("0x") ? receiptId : "0x" + receiptId;
    const contentHashPrefixed = contentHash.startsWith("0x") ? contentHash : "0x" + contentHash;

    // Compute total size from chunks
    const totalSize = manifest.total_size ?? manifest.chunks.reduce((sum, c) => sum + (c.size || 0), 0);

    // Transform chunks to include full gateway URLs
    const baseUrl = config.gatewayBaseUrl.replace(/\/$/, "");
    const transformedChunks = manifest.chunks.map((chunk, idx) => ({
      index: chunk.index ?? idx,
      sha256: chunk.sha256,
      size: chunk.size,
      url: `${baseUrl}/chunks/${contentHashPrefixed}/${chunk.index ?? idx}`,
    }));

    res.json({
      receipt_id: receiptIdPrefixed,
      content_hash: contentHashPrefixed,
      total_size: totalSize,
      chunk_count: manifest.chunks.length,
      chunks: transformedChunks,
    });
  } catch (error) {
    console.error("[blob-gateway] Error resolving locator:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});
