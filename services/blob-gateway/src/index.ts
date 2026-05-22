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
import { explorerValidatorsRouter } from "./routes/explorer-validators.js";
import { explorerSpoRewardsRouter } from "./routes/explorer-spo-rewards.js";
import { traceRouter } from "./routes/trace.js";
import { faucetRouter } from "./routes/faucet.js";
import { registerAdminKeysRoutes } from "./routes/admin-keys.js";
import { meteringRouter } from "./routes/metering.js";
import { billingRouter } from "./routes/billing.js";
import { billing402Middleware } from "./middleware/billing-402.js";
import {
  metricsRegistry,
  startDefaultMetricsCollection,
} from "./metrics.js";
import { initWorkerBoundsDb } from "./worker_bounds.js";
import { initFleetOperatorsDb } from "./fleet_operators.js";
import { initObserversDb } from "./observers.js";
import { initWitnessTargetsDb } from "./witness_targets.js";
import { initAttestationEvidenceAttestorsDb } from "./attestation_evidence_attestors.js";
import { initReceiptAttestationEvidenceDb } from "./receipt_attestation_evidence.js";
import {
  initMultisigSigsDb,
  startMultisigSigsCleanup,
} from "./multisig_sigs_store.js";
import { registerMultisigSigsRoutes } from "./routes/multisig_sigs.js";
import { registerFleetOperatorRoutes } from "./routes/fleet_operators.js";
import { registerObserverRoutes } from "./routes/observers.js";
import { registerWitnessTargetRoutes } from "./routes/witness_targets.js";
import { registerAttestorSelfRegisterRoutes } from "./routes/attestor_self_register.js";
import { registerAttestationEvidenceAttestorRoutes } from "./routes/attestation_evidence_attestors.js";
import { attestationEvidenceRouter } from "./routes/attestation_evidence.js";
import { attestationEvidenceSubmissionRouter } from "./routes/attestation_evidence_submission.js";
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

// Phase 2.A — pay-per-use billing admission control. No-op when
// BILLING_ENFORCEMENT_PHASE=off (default). Always runs AFTER body parsers
// so Content-Length is reliable for PerByte endpoints.
app.use(billing402Middleware());

// Public routes
app.get("/health", healthHandler);

// Prometheus exposition (#227). Public, unauthenticated — same posture as
// /health, scraped by ops dashboards. Counters: see src/metrics.ts.
app.get("/metrics", async (_req: Request, res: Response) => {
  try {
    res.setHeader("Content-Type", metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
  } catch (err) {
    console.error("[blob-gateway] /metrics serialization failed", err);
    res.status(500).end();
  }
});

app.use(statusRouter);

// All routes — each handles its own auth (Phase 4)
app.use(blobsRouter);       // Manifest/chunk: sig or API key. Status: public.
app.use(locatorsRouter);    // Public (read-only resolution)
app.use(chunksRouter);      // Public (content-addressed, SHA-256 verified)
app.use(batchesRouter);     // Write: resolveAuth(). Read: public.
app.use(heartbeatsRouter);  // Handles own dual-mode auth (Phase 2)
app.use(operatorsRouter);   // Invite-only operator registration
app.use(chainInfoRouter);   // Public: /chain-info — used by flux1 explorer + cert-daemon auto-discovery
app.use(explorerValidatorsRouter); // Task #337: GET /preprod-explorer/api/validators — public committee snapshot for SPO operators.
app.use(explorerSpoRewardsRouter); // Task #341: GET /preprod-explorer/api/spo-rewards — dual-stream MATRA+ADA lifetime rewards by operator.
app.use(traceRouter);       // Task #271: GET /trace/:contentHash — first-party trace-detail explorer page (HTML).
app.use(faucetRouter);      // Public: /faucet/drip — operator onboarding (MATRA + MOTRA bootstrap). Volume-mounted overrides accepted; see ops compose templates.
app.use(meteringRouter);    // Task #109: POST /metering/submit — compute_metering_v1 ingestion + sponsored-receipt forwarding.
app.use(billingRouter);     // Task #112: GET /billing/usage — verifiable compute-metering billing query.
app.use(attestationEvidenceRouter); // Wave 3 Phase 2: POST /v2/attestation_evidence — TEE-attestor evidence sink (worker bearer auth).
app.use(attestationEvidenceSubmissionRouter); // Task #143: GET pending / POST mark_submitted — cert-daemon's chain-submission feeder.
registerTokenRoutes(app);   // Bearer-token lifecycle (admin-only)
registerAdminKeysRoutes(app); // Task #94: api_keys.bound_validator_aura get/set/clear (admin-only)
registerFleetOperatorRoutes(app); // Wave 1+2: compute_metering_v2 hardware-attestor registry (admin-only)
registerObserverRoutes(app);      // Wave 1+2: compute_metering_v2 optional co-signer registry (admin-only)
registerAttestationEvidenceAttestorRoutes(app); // Wave 3 Phase 2: TEE attestor pubkey registry (admin-only)
registerWitnessTargetRoutes(app); // Witness Network: probe-target URL roster — public GET, admin POST/DELETE
registerAttestorSelfRegisterRoutes(app); // Witness Network: POST /v2/attestor_self_register — phones self-onboard via Android Key Attestation cert chain
registerMultisigSigsRoutes(app); // Task #286: GET/POST /v2/multisig_sigs/{kind}/{key} — cert-daemon M-of-N envelope coordination (settle/expire)

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
  // Compute metering v1 — per-worker hardware bounds + monotonic period_start.
  initWorkerBoundsDb();
  // Compute metering v2 — fleet operator + observer trust registries.
  // Each lives in its own SQLite file (fleet_operators.db, observers.db) so
  // schema migrations stay isolated from operators.db / quota.db.
  initFleetOperatorsDb();
  initObserversDb();
  // Witness Network: per-URL probe-target roster (witness_targets.db).
  initWitnessTargetsDb();
  // Wave 3 Phase 2 — TEE attestor registry + per-receipt evidence vector.
  initAttestationEvidenceAttestorsDb();
  initReceiptAttestationEvidenceDb();
  // Task #286 — ephemeral M-of-N sig bulletin board for settle_claim +
  // expire_policy. Daemons publish per-pubkey sigs here so any one can
  // assemble the full envelope before submitting the M-sig extrinsic.
  initMultisigSigsDb();

  // Start cleanup timers
  startCleanupTimer();
  startHeartbeatCleanup();
  // 24h hard TTL for multisig sig rows; on-chain SettlementRequestTtl is
  // ~4h so this leaves margin for post-mortem queries.
  startMultisigSigsCleanup();

  // Start default Node-process metrics collection (heap, event-loop lag,
  // GC). Lazy-started here so unit tests don't leak the collection timer.
  startDefaultMetricsCollection();

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
