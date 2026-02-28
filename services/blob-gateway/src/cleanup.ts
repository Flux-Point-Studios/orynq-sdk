/**
 * TTL-based blob cleanup using explicit metadata timestamps.
 *
 * Uses receipt.meta.json for createdAt/certifiedAt timestamps.
 * Two-phase deletion with .deleting sentinel for crash safety.
 */

import { readdir, readFile, writeFile, rm, access } from "fs/promises";
import { join } from "path";
import { config } from "./config.js";

interface ReceiptMeta {
  createdAt: string;
  certifiedAt: string | null;
  keyName: string;
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
  } catch (err) {
    console.error(`[blob-gateway] Cleanup error: ${err instanceof Error ? err.message : String(err)}`);
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
