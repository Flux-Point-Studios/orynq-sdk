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
};
