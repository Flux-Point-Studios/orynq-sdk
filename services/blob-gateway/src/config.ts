/**
 * Environment configuration for Materios blob gateway.
 */

export const config = {
  port: parseInt(process.env.PORT || "3000"),
  storagePath: process.env.STORAGE_PATH || "/data/blobs",
  apiKey: process.env.BLOB_GATEWAY_API_KEY || "",
  maxChunkSize: parseInt(process.env.MAX_CHUNK_SIZE || String(64 * 1024 * 1024)), // 64MB
  gatewayBaseUrl: process.env.GATEWAY_BASE_URL || "http://materios-blob-gateway.materios.svc.cluster.local:3000",
};
