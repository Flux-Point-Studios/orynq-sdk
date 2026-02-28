/**
 * Backup batch metadata POST to blob gateway.
 * Belt-and-suspenders: daemon posts directly, anchor worker posts as backup.
 * Uses idempotent PUT endpoint — safe to double-write.
 */

import { BLOB_GATEWAY_URL, BLOB_GATEWAY_API_KEY } from "./config.js";

export interface BatchMetadata {
  rootHash: string;
  leafCount: number;
  leafHashes: string[];
  blockRangeStart?: number;
  blockRangeEnd?: number;
  submitter?: string;
  timestamp?: string;
  source?: string;
  [key: string]: unknown;
}

/**
 * PUT batch metadata to blob gateway as backup.
 * Fire-and-forget with 5s timeout.
 */
export async function postBatchMetadataBackup(
  anchorId: string,
  metadata: BatchMetadata,
): Promise<void> {
  if (!BLOB_GATEWAY_URL) return;

  const anchorIdClean = anchorId.startsWith("0x") ? anchorId.slice(2) : anchorId;
  const payload = { ...metadata, source: "anchor_worker" };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (BLOB_GATEWAY_API_KEY) {
      headers["x-api-key"] = BLOB_GATEWAY_API_KEY;
    }

    const res = await fetch(`${BLOB_GATEWAY_URL}/batches/${anchorIdClean}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (res.ok) {
      console.log(`[materios-anchor] Batch metadata backup posted for anchor ${anchorIdClean.slice(0, 16)}...`);
    } else {
      console.warn(`[materios-anchor] Batch metadata backup failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.warn(`[materios-anchor] Batch metadata backup error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}
