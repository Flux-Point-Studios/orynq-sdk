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
import { operatorsRouter, initOperatorsDb, getOperatorsDb } from "./routes/operators.js";
import { ensureDir } from "./storage.js";
import { initQuotaDb } from "./quota.js";
import { initHeartbeatDb, startHeartbeatCleanup } from "./heartbeat-store.js";
import { startCleanupTimer } from "./cleanup.js";
import { startReceiptIndexer } from "./receipt-indexer.js";
import { initApiTokensDb } from "./api-tokens.js";
import { registerTokenRoutes } from "./routes/tokens.js";
import { chainInfoRouter, initChainInfoPoller } from "./routes/chain-info.js";
// initChainInfoPoller is re-exported for consumers that want to pre-warm the
// cache at startup; we also call it in start() so the first /chain-info hit
// after cold-start returns 200 instead of 503.

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
app.use(chainInfoRouter);   // Public: /chain-info — used by flux1 explorer + cert-daemon auto-discovery
registerTokenRoutes(app);   // Bearer-token lifecycle (admin-only)

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
  // Bearer-token store (shares the SAME handle as operators.db so we never
  // have two competing connections to the same file).
  initApiTokensDb(getOperatorsDb());

  // Start cleanup timers
  startCleanupTimer();
  startHeartbeatCleanup();

  // Pre-warm /chain-info cache so the first hit after cold-start returns 200
  // instead of 503. Fire-and-forget; errors are handled inside the poller.
  void initChainInfoPoller();

  // Start receipt indexer (polls chain for receipt→content_hash mapping)
  startReceiptIndexer().catch((err) =>
    console.error("[receipt-indexer] Failed to start:", err),
  );

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
