/**
 * Batch metadata routes.
 *
 * Phase 4: Write (POST/PUT) requires auth. Read (GET) is public.
 */

import { Router, type Request, type Response } from "express";
import { saveBatch, getBatch } from "../storage.js";
import { resolveAuth } from "../auth.js";

export const batchesRouter = Router();

/**
 * PUT /batches/:anchorId (also accepts POST for backwards compat)
 * Idempotent upsert of batch metadata JSON.
 * Requires auth: API key or sr25519 signature.
 */
async function upsertBatch(req: Request, res: Response): Promise<void> {
  try {
    const { anchorId } = req.params;

    // Auth: sig or API key (anchorId used as contentHash for sig verification)
    const auth = await resolveAuth(req, anchorId);
    if (!auth.authenticated) {
      res.status(401).json({ error: auth.error });
      return;
    }

    const metadata = req.body;

    if (!metadata || typeof metadata !== "object") {
      res.status(400).json({ error: "Invalid metadata: expected JSON object" });
      return;
    }

    await saveBatch(anchorId, metadata);
    res.status(200).json({ status: "ok", anchorId });
  } catch (error) {
    console.error("[blob-gateway] Error saving batch:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
}

batchesRouter.post("/batches/:anchorId", upsertBatch);
batchesRouter.put("/batches/:anchorId", upsertBatch);

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
