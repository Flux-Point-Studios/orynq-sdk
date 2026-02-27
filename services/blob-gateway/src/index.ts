/**
 * Materios Blob Gateway Service - Express server for blob storage and retrieval.
 *
 * Provides:
 *   POST /blobs/:contentHash/manifest     — upload manifest
 *   PUT  /blobs/:contentHash/chunks/:i    — upload chunk binary
 *   GET  /blobs/:contentHash/status       — blob status (public)
 *   GET  /locators/:receiptId             — daemon-compatible locator
 *   GET  /chunks/:receiptId/:i            — download chunk binary
 *   POST /batches/:anchorId               — save batch metadata
 *   GET  /batches/:anchorId               — read batch metadata
 *   GET  /health                          — health check
 */

import express, { type Request, type Response, type NextFunction } from "express";
import { config } from "./config.js";
import { healthHandler } from "./health.js";
import { blobsRouter } from "./routes/blobs.js";
import { locatorsRouter } from "./routes/locators.js";
import { chunksRouter } from "./routes/chunks.js";
import { batchesRouter } from "./routes/batches.js";
import { ensureDir } from "./storage.js";

const app = express();

/**
 * Auth middleware - validates x-api-key header.
 * Skips auth for health and status endpoints.
 */
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip auth for health and status endpoints
  if (req.path === "/health" || req.path.match(/^\/blobs\/[^/]+\/status$/)) {
    next();
    return;
  }
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== config.apiKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// Raw body parser for chunk uploads - MUST come before JSON parser for chunk routes
app.put("/blobs/:contentHash/chunks/:i", express.raw({ type: "*/*", limit: "64mb" }));

// JSON parser for everything else
app.use(express.json({ limit: "2mb" }));

// Auth
app.use(authMiddleware);

// Routes
app.get("/health", healthHandler);
app.use(blobsRouter);
app.use(locatorsRouter);
app.use(chunksRouter);
app.use(batchesRouter);

async function start(): Promise<void> {
  // Ensure storage directories exist
  await ensureDir(config.storagePath);

  app.listen(config.port, () => {
    console.log(`[blob-gateway] Service started on port ${config.port}`);
    console.log(`[blob-gateway] Storage path: ${config.storagePath}`);
    console.log(`[blob-gateway] Health: http://localhost:${config.port}/health`);
  });
}

start();
