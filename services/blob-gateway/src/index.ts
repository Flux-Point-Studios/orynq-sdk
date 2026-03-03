/**
 * Materios Blob Gateway Service - Express server for blob storage and retrieval.
 */

import express, { type Request, type Response, type NextFunction } from "express";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { config } from "./config.js";
import { healthHandler } from "./health.js";
import { blobsRouter } from "./routes/blobs.js";
import { locatorsRouter } from "./routes/locators.js";
import { chunksRouter } from "./routes/chunks.js";
import { batchesRouter } from "./routes/batches.js";
import { statusRouter } from "./routes/status.js";
import { heartbeatsRouter } from "./routes/heartbeats.js";
import { ensureDir } from "./storage.js";
import { initQuotaDb, resolveKey } from "./quota.js";
import { initHeartbeatDb, startHeartbeatCleanup } from "./heartbeat-store.js";
import { startCleanupTimer } from "./cleanup.js";

const app = express();

/**
 * Auth middleware - validates x-api-key via SQLite-backed quota system.
 * Skips auth for health, status, and blob status endpoints.
 */
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip auth for public endpoints
  if (
    req.path === "/health" ||
    req.path === "/status" ||
    req.path === "/heartbeats/status" ||
    req.path === "/heartbeats" ||
    req.path.match(/^\/blobs\/[^/]+\/status$/)
  ) {
    next();
    return;
  }
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (!apiKey) {
    res.status(401).json({ error: "Unauthorized: missing x-api-key header" });
    return;
  }
  const keyInfo = resolveKey(apiKey);
  if (!keyInfo) {
    res.status(401).json({ error: "Unauthorized: invalid or disabled API key" });
    return;
  }
  next();
}

// Request timeout middleware
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setTimeout(config.uploadTimeoutMs, () => {
    res.status(408).json({ error: "Request timeout" });
  });
  next();
});

// Raw body parser for chunk uploads - MUST come before JSON parser for chunk routes
app.put("/blobs/:contentHash/chunks/:i", express.raw({ type: "*/*", limit: `${config.maxChunkBytes}` }));

// JSON parser for everything else
app.use(express.json({ limit: "2mb" }));

// Public routes (before auth)
app.get("/health", healthHandler);
app.use(statusRouter);

// Auth
app.use(authMiddleware);

// Protected routes
app.use(blobsRouter);
app.use(locatorsRouter);
app.use(chunksRouter);
app.use(batchesRouter);
app.use(heartbeatsRouter);

async function start(): Promise<void> {
  // Initialize sr25519/ed25519 WASM (required for signatureVerify)
  await cryptoWaitReady();
  console.log("[blob-gateway] Polkadot crypto WASM initialized");

  // Ensure storage directories exist
  await ensureDir(config.storagePath);

  // Initialize SQLite databases
  initQuotaDb();
  initHeartbeatDb();

  // Start cleanup timers
  startCleanupTimer();
  startHeartbeatCleanup();

  app.listen(config.port, () => {
    console.log(`[blob-gateway] Service started on port ${config.port}`);
    console.log(`[blob-gateway] Storage path: ${config.storagePath}`);
    console.log(`[blob-gateway] Health: http://localhost:${config.port}/health`);
    console.log(`[blob-gateway] Status: http://localhost:${config.port}/status`);
    console.log(`[blob-gateway] Heartbeats: http://localhost:${config.port}/heartbeats/status`);
  });
}

start();
