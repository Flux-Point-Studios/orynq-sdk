/**
 * Environment configuration for Materios blob gateway.
 */

export const config = {
  port: parseInt(process.env.PORT || "3000"),
  storagePath: process.env.STORAGE_PATH || "/data/blobs",
  apiKey: process.env.BLOB_GATEWAY_API_KEY || "",
  maxChunkSize: parseInt(process.env.MAX_CHUNK_SIZE || String(64 * 1024 * 1024)),
  gatewayBaseUrl: process.env.GATEWAY_BASE_URL || "http://materios-blob-gateway.materios.svc.cluster.local:3000",
  // Content limits
  maxChunksPerManifest: parseInt(process.env.MAX_CHUNKS_PER_MANIFEST || "256"),
  maxBlobBytesPerManifest: parseInt(process.env.MAX_BLOB_BYTES_PER_MANIFEST || String(256 * 1024 * 1024)),
  maxChunkBytes: parseInt(process.env.MAX_CHUNK_BYTES || String(64 * 1024 * 1024)),
  uploadTimeoutMs: parseInt(process.env.UPLOAD_TIMEOUT_MS || "300000"),
  // TTL
  blobTtlAfterCertDays: parseInt(process.env.BLOB_TTL_AFTER_CERT_DAYS || "30"),
  blobTtlMaxDays: parseInt(process.env.BLOB_TTL_MAX_DAYS || "90"),
  // Keys file for multi-key auth
  keysFilePath: process.env.KEYS_FILE_PATH || "/data/blobs/keys.json",
  // Push-notify daemon
  daemonNotifyUrl: process.env.DAEMON_NOTIFY_URL || "",
  daemonNotifyToken: process.env.DAEMON_NOTIFY_TOKEN || "",
  // Status page upstream URLs
  certDaemonAliceUrl: process.env.CERT_DAEMON_ALICE_URL || "http://materios-cert-daemon.materios.svc.cluster.local:8080",
  certDaemonBobUrl: process.env.CERT_DAEMON_BOB_URL || "http://materios-cert-daemon-bob.materios.svc.cluster.local:8080",
  anchorWorkerUrl: process.env.ANCHOR_WORKER_URL || "http://anchor-worker-materios.materios.svc.cluster.local:3334",
  // RPC for on-chain queries (balance check, receipt-exists cleanup)
  materiosRpcUrl: process.env.MATERIOS_RPC_URL || "ws://materios-rpc.materios.svc.cluster.local:9945",
  // Minimum MATRA balance to upload without API key. MATRA is 6 decimals on
  // Materios v5 (Cardano cMATRA-compatible, u64 cap). Default = 1e6 base = 1
  // MATRA. Override via MIN_UPLOAD_BALANCE env. The old 1e12 default came
  // from the 12-decimal v4 era when that equaled "1 MATRA"; if it leaks
  // through on a 6-decimal chain it would mean "1,000,000 MATRA" and lock
  // out every operator.
  minUploadBalance: BigInt(process.env.MIN_UPLOAD_BALANCE || "1000000"), // 1 MATRA (6 decimals)
  // Balance cache TTL
  balanceCacheTtlMs: parseInt(process.env.BALANCE_CACHE_TTL_MS || "300000"), // 5 min
  // Upload sig clock skew tolerance
  uploadSigMaxAgeSec: parseInt(process.env.UPLOAD_SIG_MAX_AGE_SEC || "120"),
  // Default quotas for sig-only uploaders (no API key)
  sigOnlyMaxReceiptsPerDay: parseInt(process.env.SIG_ONLY_MAX_RECEIPTS_PER_DAY || "10"),
  sigOnlyMaxBytesPerDay: parseInt(process.env.SIG_ONLY_MAX_BYTES_PER_DAY || String(256 * 1024 * 1024)),
  sigOnlyMaxConcurrentUploads: parseInt(process.env.SIG_ONLY_MAX_CONCURRENT_UPLOADS || "3"),
  // Grace period before orphaned blobs (no on-chain receipt) get cleaned up
  receiptGraceHours: parseInt(process.env.RECEIPT_GRACE_HOURS || "24"),
  // Sponsored-receipt submitter (opt-in; disabled when URL is empty).
  // Community abilities (OpenHome, etc.) can upload blobs via Bearer or
  // api-key auth but cannot sign the `orinqReceipts.submitReceipt`
  // extrinsic — their sandbox has no sr25519 primitives. Without a
  // receipt the blob is an orphan the cert-daemon never touches.
  //
  // When this URL is set, on a COMPLETE upload whose auth tier is
  // sponsored (bearer | api-key | api-key-legacy-ss58), the gateway
  // fires a fire-and-forget POST to the submitter with
  //   { contentHash, operator, rootHash, manifestHash, source: "blob-gateway" }
  // and the submitter is expected to build + sign + send the receipt
  // extrinsic using its own operator keypairs. Signing infra never
  // touches the gateway process. HTTP 202 from the submitter means
  // "accepted, will submit async"; any non-2xx is logged and does NOT
  // affect the upload's 200 OK response.
  sponsoredReceiptSubmitterUrl: process.env.SPONSORED_RECEIPT_SUBMITTER_URL || "",
  sponsoredReceiptSubmitterToken: process.env.SPONSORED_RECEIPT_SUBMITTER_TOKEN || "",
  sponsoredReceiptNotifyTimeoutMs: parseInt(process.env.SPONSORED_RECEIPT_NOTIFY_TIMEOUT_MS || "5000"),
  // Evidence-submitter Bearer for the daemon-facing chain-submission routes
  // (`GET /v2/attestation_evidence/pending` + `POST .../mark_submitted` —
  // see routes/attestation_evidence_submission.ts). Day-one fallback to the
  // sponsored-receipt submitter token preserves operational simplicity
  // (operators don't need to set a second secret to roll out task #143);
  // operators that want to split the privileged paths can set
  // EVIDENCE_SUBMITTER_TOKEN to an independent value at any point.
  // The fallback is RUNTIME — read at call time — so a flip in env between
  // process restarts is honoured. Empty string here means "no token wired
  // up", and the auth helper will reject every request (401), which is the
  // safe default if neither env var is set.
  evidenceSubmitterToken:
    process.env.EVIDENCE_SUBMITTER_TOKEN ||
    process.env.SPONSORED_RECEIPT_SUBMITTER_TOKEN ||
    "",

  // Phase 2.A — pay-per-use billing enforcement (HTTP 402 via pallet-billing).
  //
  // Staged rollout across three modes:
  //   "off"         — middleware bypasses entirely (no chain reads, no logs).
  //                   Default; safe even before pallet-billing is wired into
  //                   the runtime. No behavior change vs Phase 1.
  //   "measurement" — middleware reads balance/price, logs every request
  //                   that WOULD 402 (`would_402: true` audit line + Prom
  //                   counter), but lets the request through. Used to size
  //                   the FPS treasury budget against real traffic before
  //                   actual charges go live.
  //   "live"        — middleware returns 402 + x402 headers when balance <
  //                   price. After 2.A part 4 (sdk-payer-materios-x402)
  //                   ships, clients can retry with payment. Note: even in
  //                   "live" mode the pallet's own `DebitsEnabled` switch
  //                   can be `false`, in which case the gateway-side 402
  //                   gating is real but no MATRA is actually debited yet
  //                   (pallet's pay_request dry-run). The two layers are
  //                   independent — gateway shapes the wire protocol, pallet
  //                   shapes the on-chain effect.
  //
  // Toggle via `BILLING_ENFORCEMENT_PHASE` env. Misconfigured value falls
  // back to "off" (fail-open is the right default for billing).
  billingEnforcementPhase: (() => {
    // L1 (#225): trim whitespace BEFORE lowercasing so an env value like
    // `"  live  "` (common when an operator copy-pastes from a runbook)
    // is honoured rather than silently falling back to the "off" default.
    const raw = (process.env.BILLING_ENFORCEMENT_PHASE || "off")
      .trim()
      .toLowerCase();
    return raw === "measurement" || raw === "live" ? raw : "off";
  })() as "off" | "measurement" | "live",

  // FPS treasury SS58 — the account whose pallet-billing::Balances is
  // debited for every api-key-authed request. Set via env at deploy.
  // Empty string means "treasury sponsorship is disabled" — every
  // api-key-authed request will be treated as if the treasury balance
  // were zero (and 402'd in "live" mode). Self-pay clients are unaffected.
  fpsTreasurySs58: process.env.FPS_TREASURY_SS58 || "",
};
