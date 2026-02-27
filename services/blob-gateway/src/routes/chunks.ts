/**
 * Chunk download routes.
 */

import { Router, type Request, type Response } from "express";
import { resolveReceiptId, getChunk } from "../storage.js";

export const chunksRouter = Router();

/**
 * GET /chunks/:receiptId/:i
 * Downloads a chunk binary by receiptId and chunk index.
 * Resolves receiptId to contentHash, then reads the chunk.
 * Returns application/octet-stream.
 */
chunksRouter.get("/chunks/:receiptId/:i", async (req: Request, res: Response) => {
  try {
    const { receiptId, i } = req.params;
    const chunkIndex = parseInt(i, 10);

    if (isNaN(chunkIndex) || chunkIndex < 0) {
      res.status(400).json({ error: "Invalid chunk index" });
      return;
    }

    // receiptId could be a contentHash directly or a receiptId that needs resolving
    // Try resolving as receiptId first, fall back to using as contentHash
    let contentHash = await resolveReceiptId(receiptId);
    if (!contentHash) {
      // Try using it directly as a contentHash (strip 0x if present)
      contentHash = receiptId.startsWith("0x") ? receiptId.slice(2) : receiptId;
    }

    const data = await getChunk(contentHash, chunkIndex);
    if (!data) {
      res.status(404).json({ error: "Chunk not found" });
      return;
    }

    res.set("Content-Type", "application/octet-stream");
    res.set("Content-Length", String(data.length));
    res.send(data);
  } catch (error) {
    console.error("[blob-gateway] Error reading chunk:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});
