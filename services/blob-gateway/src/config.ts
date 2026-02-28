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
};
