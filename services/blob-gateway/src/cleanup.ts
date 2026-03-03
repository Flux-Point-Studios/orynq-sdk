/**
 * TTL-based blob cleanup using explicit metadata timestamps.
 *
 * Uses receipt.meta.json for createdAt/certifiedAt timestamps.
 * Two-phase deletion with .deleting sentinel for crash safety.
 */

import { readdir, readFile, writeFile, rm, access } from "fs/promises";
import { join } from "path";
import { config } from "./config.js";
import { checkReceiptStatus } from "./rpc-client.js";
import { computeReceiptId, updateReceiptMeta } from "./storage.js";

interface ReceiptMeta {
  createdAt: string;
  certifiedAt: string | null;
  keyName: string;
  uploaderAddress?: string;
  lastReceiptCheck?: string | null;
  receiptOnChain?: boolean | null;
}

const MS_PER_DAY = 86400_000;

export function startCleanupTimer(intervalMs = 3600_000): void {
  // Run first cleanup after 5 minutes, then hourly
  setTimeout(() => {
    runCleanup();
    setInterval(runCleanup, intervalMs);
  }, 300_000);
  console.log("[blob-gateway] Cleanup timer started (hourly)");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function runCleanup(): Promise<void> {
  const receiptsPath = join(config.storagePath, "receipts");
  const indexPath = join(config.storagePath, "index", "receipt-to-content");
  const now = Date.now();
  let deleted = 0;
  let bytesFreed = 0;

  try {
    const entries = await readdir(receiptsPath);

    for (const contentHash of entries) {
      const receiptDir = join(receiptsPath, contentHash);
      const metaPath = join(receiptDir, "receipt.meta.json");
      const deletingPath = join(receiptDir, ".deleting");

      // Resume interrupted deletions
      if (await fileExists(deletingPath)) {
        bytesFreed += await deleteReceipt(receiptDir, contentHash, indexPath);
        deleted++;
        continue;
      }

      // Read metadata
      let meta: ReceiptMeta;
      try {
        const raw = await readFile(metaPath, "utf-8");
        meta = JSON.parse(raw);
      } catch {
        // No meta.json — skip (legacy receipt or in-progress upload)
        continue;
      }

      const createdAt = new Date(meta.createdAt).getTime();
      const certifiedAt = meta.certifiedAt ? new Date(meta.certifiedAt).getTime() : null;

      // Delete if: certified and past cert TTL
      if (certifiedAt && (now - certifiedAt) > config.blobTtlAfterCertDays * MS_PER_DAY) {
        await writeFile(deletingPath, "");
        bytesFreed += await deleteReceipt(receiptDir, contentHash, indexPath);
        deleted++;
        continue;
      }

      // Delete if: past max TTL regardless of certification
      if ((now - createdAt) > config.blobTtlMaxDays * MS_PER_DAY) {
        await writeFile(deletingPath, "");
        bytesFreed += await deleteReceipt(receiptDir, contentHash, indexPath);
        deleted++;
        continue;
      }
    }

    if (deleted > 0) {
      console.log(`[blob-gateway] Cleanup: deleted ${deleted} receipts, freed ~${(bytesFreed / 1024 / 1024).toFixed(1)}MB`);
    }

    // Phase 3: Deferred receipt-exists cleanup for orphaned blobs
    await runReceiptExistsCheck(receiptsPath, indexPath);
  } catch (err) {
    console.error(`[blob-gateway] Cleanup error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Deferred receipt-exists cleanup: checks if uncertified blobs have an on-chain receipt.
 * Deletes orphaned blobs (no on-chain receipt after grace period).
 * Updates local meta for receipts that were certified on-chain but missed the PATCH.
 */
async function runReceiptExistsCheck(receiptsPath: string, indexPath: string): Promise<void> {
  const graceMs = config.receiptGraceHours * 3600_000;
  const now = Date.now();
  let checked = 0;
  let orphansDeleted = 0;

  let entries: string[];
  try {
    entries = await readdir(receiptsPath);
  } catch {
    return;
  }

  for (const contentHash of entries) {
    const metaPath = join(receiptsPath, contentHash, "receipt.meta.json");
    let meta: ReceiptMeta;
    try {
      meta = JSON.parse(await readFile(metaPath, "utf-8"));
    } catch {
      continue;
    }

    // Skip if already certified or already confirmed on-chain
    if (meta.certifiedAt || meta.receiptOnChain === true) continue;

    // Skip if created recently (within grace period)
    const age = now - new Date(meta.createdAt).getTime();
    if (age < graceMs) continue;

    // Skip if checked recently (no more than once per hour per blob)
    if (meta.lastReceiptCheck) {
      const lastCheck = new Date(meta.lastReceiptCheck).getTime();
      if (now - lastCheck < 3600_000) continue;
    }

    // Query chain
    const receiptId = computeReceiptId(contentHash);
    const status = await checkReceiptStatus(receiptId);
    checked++;

    if (status === "rpc_error") continue; // Don't delete on RPC errors

    if (status === "not_found") {
      // Receipt never submitted — orphaned blob → delete
      console.log(`[cleanup] Orphaned blob ${contentHash.slice(0, 16)}... (no receipt on-chain after ${Math.round(age / 3600_000)}h)`);
      await writeFile(join(receiptsPath, contentHash, ".deleting"), "");
      await deleteReceipt(join(receiptsPath, contentHash), contentHash, indexPath);
      orphansDeleted++;
    } else if (status === "certified") {
      // Certified on-chain but we missed the PATCH — update local meta
      await updateReceiptMeta(contentHash, {
        certifiedAt: new Date().toISOString(),
        receiptOnChain: true,
        lastReceiptCheck: new Date().toISOString(),
      });
    } else {
      // "pending" — receipt exists but not certified yet
      await updateReceiptMeta(contentHash, {
        receiptOnChain: true,
        lastReceiptCheck: new Date().toISOString(),
      });
    }
  }

  if (checked > 0) {
    console.log(`[cleanup] Receipt-exists check: ${checked} checked, ${orphansDeleted} orphans deleted`);
  }
}

async function deleteReceipt(receiptDir: string, contentHash: string, indexPath: string): Promise<number> {
  let bytes = 0;
  try {
    // Estimate bytes from chunks dir
    const chunksDir = join(receiptDir, "chunks");
    try {
      const chunks = await readdir(chunksDir);
      // Rough estimate — actual size would need stat() calls
      bytes = chunks.length * 256 * 1024; // assume average chunk size
    } catch {
      // no chunks dir
    }

    // Delete index entry
    try {
      // Read all index files to find the one pointing to this contentHash
      const indexEntries = await readdir(indexPath);
      for (const entry of indexEntries) {
        try {
          const target = await readFile(join(indexPath, entry), "utf-8");
          if (target.trim() === contentHash) {
            await rm(join(indexPath, entry));
            break;
          }
        } catch {
          // skip
        }
      }
    } catch {
      // index dir may not exist
    }

    // Delete entire receipt directory
    await rm(receiptDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`[blob-gateway] Failed to delete receipt ${contentHash}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return bytes;
}
