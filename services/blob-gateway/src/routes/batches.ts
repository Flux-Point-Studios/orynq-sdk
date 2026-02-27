/**
 * Batch metadata routes.
 */

import { Router, type Request, type Response } from "express";
import { saveBatch, getBatch } from "../storage.js";

export const batchesRouter = Router();

/**
 * POST /batches/:anchorId
 * Saves batch metadata JSON.
 */
batchesRouter.post("/batches/:anchorId", async (req: Request, res: Response) => {
  try {
    const { anchorId } = req.params;
    const metadata = req.body;

    if (!metadata || typeof metadata !== "object") {
      res.status(400).json({ error: "Invalid metadata: expected JSON object" });
      return;
    }

    await saveBatch(anchorId, metadata);
    res.status(201).json({ status: "ok", anchorId });
  } catch (error) {
    console.error("[blob-gateway] Error saving batch:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

/**
 * GET /batches/:anchorId
 * Returns batch metadata JSON.
 */
batchesRouter.get("/batches/:anchorId", async (req: Request, res: Response) => {
  try {
    const { anchorId } = req.params;
    const batch = await getBatch(anchorId);

    if (!batch) {
      res.status(404).json({ error: "Batch not found" });
      return;
    }

    res.json(batch);
  } catch (error) {
    console.error("[blob-gateway] Error reading batch:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});
