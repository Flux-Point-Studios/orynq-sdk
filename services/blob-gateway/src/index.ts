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
import { operatorsRouter, initOperatorsDb } from "./routes/operators.js";
import { ensureDir } from "./storage.js";
import { initQuotaDb } from "./quota.js";
import { initHeartbeatDb, startHeartbeatCleanup } from "./heartbeat-store.js";
import { startCleanupTimer } from "./cleanup.js";

const app = express();

// Phase 4: No global auth middleware — each route handles its own auth.
// Read endpoints (locators, chunks, batches GET) are public.
// Write endpoints (manifest POST, chunk PUT, certified PATCH, batches POST/PUT)
// use resolveAuth() or verifyUploadSig() directly.

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

// Public routes
app.get("/health", healthHandler);
app.use(statusRouter);

// All routes — each handles its own auth (Phase 4)
app.use(blobsRouter);       // Manifest/chunk: sig or API key. Status: public.
app.use(locatorsRouter);    // Public (read-only resolution)
app.use(chunksRouter);      // Public (content-addressed, SHA-256 verified)
app.use(batchesRouter);     // Write: resolveAuth(). Read: public.
app.use(heartbeatsRouter);  // Handles own dual-mode auth (Phase 2)
app.use(operatorsRouter);   // Invite-only operator registration

async function start(): Promise<void> {
  // Initialize sr25519/ed25519 WASM (required for signatureVerify)
  await cryptoWaitReady();
  console.log("[blob-gateway] Polkadot crypto WASM initialized");

  // Ensure storage directories exist
  await ensureDir(config.storagePath);

  // Initialize SQLite databases
  initQuotaDb();
  initHeartbeatDb();
  initOperatorsDb();

  // Start cleanup timers
  startCleanupTimer();
  startHeartbeatCleanup();

  app.listen(config.port, () => {
    console.log(`[blob-gateway] Service started on port ${config.port}`);
    console.log(`[blob-gateway] Storage path: ${config.storagePath}`);
    console.log(`[blob-gateway] Health: http://localhost:${config.port}/health`);
    console.log(`[blob-gateway] Status: http://localhost:${config.port}/status`);
    console.log(`[blob-gateway] Heartbeats: http://localhost:${config.port}/heartbeats/status`);
    console.log(`[blob-gateway] RPC endpoint: ${config.materiosRpcUrl} (lazy connect)`);
  });
}

start();
