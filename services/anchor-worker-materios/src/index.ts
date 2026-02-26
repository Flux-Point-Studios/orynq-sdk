/**
 * Materios Anchor Worker Service - Express server for anchor submission.
 *
 * POST /anchor — same API shape as the Cardano anchor worker
 */

import express, { type Request, type Response, type NextFunction } from "express";
import { PORT, ANCHOR_WORKER_TOKEN, validateEnv } from "./config.js";
import { getApi, submitAnchor, type AnchorRequest } from "./anchor.js";
import { healthHandler, readyHandler, setConnected } from "./health.js";

validateEnv();

const app = express();
app.use(express.json({ limit: "1mb" }));

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers["x-internal-token"];
  if (!token || token !== ANCHOR_WORKER_TOKEN) {
    res.status(403).json({ error: "Forbidden: Invalid or missing token" });
    return;
  }
  next();
}

app.get("/health", healthHandler);
app.get("/ready", readyHandler);

/**
 * POST /anchor
 * Body: { contentHash, rootHash, manifestHash, anchorId? }
 *
 * Same request shape works against Cardano worker for API compatibility.
 */
app.post("/anchor", authMiddleware, async (req: Request, res: Response) => {
  try {
    const { contentHash, rootHash, manifestHash, anchorId } = req.body as Partial<AnchorRequest>;

    if (!rootHash) {
      res.status(400).json({ error: "Missing required field: rootHash" });
      return;
    }
    if (!manifestHash) {
      res.status(400).json({ error: "Missing required field: manifestHash" });
      return;
    }
    if (!contentHash) {
      res.status(400).json({ error: "Missing required field: contentHash" });
      return;
    }

    console.log(`[materios-anchor] Submitting anchor: rootHash=${rootHash}`);

    const result = await submitAnchor({ contentHash, rootHash, manifestHash, anchorId });

    console.log(`[materios-anchor] Anchor submitted: blockHash=${result.blockHash}, anchorId=${result.anchorId}`);

    res.json({ success: true, ...result });
  } catch (error) {
    console.error("[materios-anchor] Error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ success: false, error: message });
  }
});

// Connect to Materios node, then start server
async function start(): Promise<void> {
  try {
    console.log("[materios-anchor] Connecting to Materios node...");
    await getApi();
    setConnected(true);
    console.log("[materios-anchor] Connected to Materios node");
  } catch (error) {
    console.error("[materios-anchor] Failed to connect:", error);
    // Start server anyway — will retry connection on first request
  }

  app.listen(PORT, () => {
    console.log(`[materios-anchor] Service started on port ${PORT}`);
    console.log(`[materios-anchor] Health: http://localhost:${PORT}/health`);
  });
}

start();
