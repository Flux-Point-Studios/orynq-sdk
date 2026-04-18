/**
 * Materios Anchor Worker Service - Express server for anchor submission.
 *
 * POST /anchor — same API shape as the Cardano anchor worker
 */

import express, { type Request, type Response, type NextFunction } from "express";
import { PORT, ANCHOR_WORKER_TOKEN, CARDANO_L1_ENABLED, validateEnv } from "./config.js";
import { getApi, submitAnchor, type AnchorRequest } from "./anchor.js";
import { healthHandler, readyHandler, statusHandler, setConnected, incrementAnchorCount } from "./health.js";
import { postBatchMetadataBackup, type BatchMetadata } from "./batch-metadata.js";
import { submitToCardano } from "./cardano.js";

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
app.get("/status", statusHandler);

/**
 * POST /anchor
 * Body: { contentHash, rootHash, manifestHash, anchorId?, batchMetadata? }
 *
 * Same request shape works against Cardano worker for API compatibility.
 */
app.post("/anchor", authMiddleware, async (req: Request, res: Response) => {
  try {
    const { contentHash, rootHash, manifestHash, anchorId, batchMetadata } = req.body as Partial<AnchorRequest & { batchMetadata?: BatchMetadata }>;

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

    incrementAnchorCount();

    // Post batch metadata backup to gateway (fire-and-forget)
    if (batchMetadata && result.anchorId) {
      postBatchMetadataBackup(result.anchorId, batchMetadata).catch(() => {});
    }

    // Cardano L1 settlement (materios-anchor-v2, label 8746). Fire-and-forget
    // so Cardano outages never block Materios anchoring. The request body
    // (req.body) is handed in raw so the BIP39 scan covers everything the
    // caller sent, not just fields we picked off.
    let cardanoTxHash: string | undefined;
    if (CARDANO_L1_ENABLED) {
      try {
        const cardano = await submitToCardano({
          rootHash,
          manifestHash,
          batchMetadata,
          rawBody: req.body,
        });
        cardanoTxHash = cardano.txHash;
      } catch (e) {
        console.error(`[materios-anchor] Cardano L1 submit failed (non-fatal):`, e);
      }
    }

    res.json({ success: true, ...result, cardanoTxHash });
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
