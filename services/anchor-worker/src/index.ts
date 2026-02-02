/**
 * Anchor Worker Service - Express server for processing trace anchoring.
 *
 * Location: services/anchor-worker/src/index.ts
 */

import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { PORT, ANCHOR_WORKER_TOKEN, validateEnv } from "./env.js";
import { anchorProcessTrace, type ManifestData } from "./anchor.js";

// Validate environment before starting
validateEnv();

const app = express();

// Request size limit 1MB
app.use(express.json({ limit: "1mb" }));

/**
 * Authentication middleware for internal service calls.
 * Rejects requests without valid X-Internal-Token header.
 */
function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const token = req.headers["x-internal-token"];

  if (!token || token !== ANCHOR_WORKER_TOKEN) {
    res.status(403).json({ error: "Forbidden: Invalid or missing token" });
    return;
  }

  next();
}

/**
 * Health check endpoint.
 * Does not require authentication.
 */
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "anchor-worker" });
});

/**
 * Process trace anchor endpoint.
 * Requires X-Internal-Token authentication.
 *
 * POST /anchor/process-trace
 * Body: {
 *   requestId: string,
 *   manifest: ManifestData,
 *   storageUri?: string
 * }
 */
app.post(
  "/anchor/process-trace",
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { requestId, manifest, storageUri } = req.body as {
        requestId?: string;
        manifest?: ManifestData;
        storageUri?: string;
      };

      // Validate required fields
      if (!requestId) {
        res.status(400).json({ error: "Missing required field: requestId" });
        return;
      }

      if (!manifest) {
        res.status(400).json({ error: "Missing required field: manifest" });
        return;
      }

      if (!manifest.rootHash) {
        res
          .status(400)
          .json({ error: "Missing required field: manifest.rootHash" });
        return;
      }

      if (!manifest.manifestHash) {
        res
          .status(400)
          .json({ error: "Missing required field: manifest.manifestHash" });
        return;
      }

      console.log(`[anchor] Processing request: ${requestId}`);

      const result = await anchorProcessTrace(requestId, manifest, storageUri);

      console.log(
        `[anchor] Request ${requestId} completed: txHash=${result.txHash}`
      );

      res.json({
        success: true,
        ...result,
      });
    } catch (error) {
      console.error("[anchor] Error processing request:", error);

      const message =
        error instanceof Error ? error.message : "Unknown error occurred";

      res.status(500).json({
        success: false,
        error: message,
      });
    }
  }
);

// Start server
app.listen(PORT, () => {
  console.log(`[anchor-worker] Service started on port ${PORT}`);
  console.log(`[anchor-worker] Health check: http://localhost:${PORT}/health`);
});
