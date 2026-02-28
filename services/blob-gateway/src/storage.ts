/**
 * Filesystem storage layer for blob gateway.
 *
 * Directory layout under STORAGE_PATH:
 *   receipts/{contentHash}/
 *     manifest.json
 *     receipt.meta.json
 *     chunks/0.bin, 1.bin, ...
 *     .complete            # sentinel file when all chunks uploaded
 *   batches/{anchorId}.json
 *   index/
 *     receipt-to-content/{receiptId}.txt  -> contentHash (text file)
 */

import { mkdir, readFile, writeFile, access, readdir } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import { config } from "./config.js";
import { notifyDaemon } from "./notify.js";

/**
 * Strip "0x" prefix from a hex string if present.
 * Uses startsWith check (NEVER regex that could strip leading 0).
 */
function stripHexPrefix(hex: string): string {
  if (hex.startsWith("0x")) {
    return hex.slice(2);
  }
  return hex;
}

/**
 * Compute receiptId from contentHash: SHA256(Buffer.from(contentHash_hex)).
 * Returns hex string with "0x" prefix.
 */
export function computeReceiptId(contentHash: string): string {
  const raw = stripHexPrefix(contentHash);
  const hash = createHash("sha256").update(Buffer.from(raw, "hex")).digest("hex");
  return "0x" + hash;
}

/** mkdir -p helper */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

function receiptsDir(contentHash: string): string {
  return join(config.storagePath, "receipts", stripHexPrefix(contentHash));
}

function chunksDir(contentHash: string): string {
  return join(receiptsDir(contentHash), "chunks");
}

function indexDir(): string {
  return join(config.storagePath, "index", "receipt-to-content");
}

function batchesDir(): string {
  return join(config.storagePath, "batches");
}

/**
 * Save manifest.json for a content hash.
 * Also writes receipt-to-content index file and receipt.meta.json.
 */
export async function saveManifest(contentHash: string, manifest: object): Promise<void> {
  const dir = receiptsDir(contentHash);
  await ensureDir(dir);
  await ensureDir(chunksDir(contentHash));
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // Compute receiptId and write index
  const receiptId = computeReceiptId(contentHash);
  const idxDir = indexDir();
  await ensureDir(idxDir);
  const receiptIdClean = stripHexPrefix(receiptId);
  await writeFile(join(idxDir, `${receiptIdClean}.txt`), stripHexPrefix(contentHash));

  // Write metadata for TTL cleanup
  const metaPath = join(dir, "receipt.meta.json");
  const meta = {
    createdAt: new Date().toISOString(),
    certifiedAt: null,
    keyName: "",
  };
  await writeFile(metaPath, JSON.stringify(meta, null, 2));
}

/**
 * Read manifest.json for a content hash.
 */
export async function getManifest(contentHash: string): Promise<object | null> {
  const manifestPath = join(receiptsDir(contentHash), "manifest.json");
  try {
    const data = await readFile(manifestPath, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Save a chunk binary. After saving, checks completeness and writes .complete sentinel.
 * Notifies daemon when upload is complete.
 */
export async function saveChunk(contentHash: string, chunkIndex: number, data: Buffer): Promise<void> {
  const dir = chunksDir(contentHash);
  await ensureDir(dir);
  await writeFile(join(dir, `${chunkIndex}.bin`), data);

  // Check completeness
  const manifest = await getManifest(contentHash) as { chunks?: Array<unknown> } | null;
  if (manifest && manifest.chunks) {
    const expectedCount = manifest.chunks.length;
    const uploaded = await countUploadedChunks(contentHash);
    if (uploaded >= expectedCount) {
      await writeFile(join(receiptsDir(contentHash), ".complete"), "");
      // Notify daemon that blob is complete
      const receiptId = computeReceiptId(contentHash);
      notifyDaemon(contentHash, receiptId).catch(() => {});
    }
  }
}

/**
 * Read a chunk binary.
 */
export async function getChunk(contentHash: string, chunkIndex: number): Promise<Buffer | null> {
  const chunkPath = join(chunksDir(contentHash), `${chunkIndex}.bin`);
  try {
    return await readFile(chunkPath);
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function countUploadedChunks(contentHash: string): Promise<number> {
  const dir = chunksDir(contentHash);
  try {
    const files = await readdir(dir);
    return files.filter((f) => f.endsWith(".bin")).length;
  } catch {
    return 0;
  }
}

/**
 * Get status of a blob: exists, complete, chunk counts.
 */
export async function getStatus(contentHash: string): Promise<{
  exists: boolean;
  complete: boolean;
  chunkCount: number;
  chunksUploaded: number;
}> {
  const manifest = await getManifest(contentHash) as { chunks?: Array<unknown> } | null;
  if (!manifest) {
    return { exists: false, complete: false, chunkCount: 0, chunksUploaded: 0 };
  }

  const chunkCount = manifest.chunks ? manifest.chunks.length : 0;
  const chunksUploaded = await countUploadedChunks(contentHash);
  const complete = await fileExists(join(receiptsDir(contentHash), ".complete"));

  return { exists: true, complete, chunkCount, chunksUploaded };
}

/**
 * Resolve a receiptId to its contentHash via the index.
 */
export async function resolveReceiptId(receiptId: string): Promise<string | null> {
  const receiptIdClean = stripHexPrefix(receiptId);
  const indexPath = join(indexDir(), `${receiptIdClean}.txt`);
  try {
    const contentHash = await readFile(indexPath, "utf-8");
    return contentHash.trim();
  } catch {
    return null;
  }
}

/**
 * Save batch metadata JSON.
 */
export async function saveBatch(anchorId: string, metadata: object): Promise<void> {
  const dir = batchesDir();
  await ensureDir(dir);
  await writeFile(join(dir, `${stripHexPrefix(anchorId)}.json`), JSON.stringify(metadata, null, 2));
}

/**
 * Read batch metadata JSON.
 */
export async function getBatch(anchorId: string): Promise<object | null> {
  const batchPath = join(batchesDir(), `${stripHexPrefix(anchorId)}.json`);
  try {
    const data = await readFile(batchPath, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Mark a receipt as certified — sets certifiedAt in receipt.meta.json.
 */
export async function markCertified(contentHash: string): Promise<boolean> {
  const metaPath = join(receiptsDir(contentHash), "receipt.meta.json");
  try {
    const raw = await readFile(metaPath, "utf-8");
    const meta = JSON.parse(raw);
    meta.certifiedAt = new Date().toISOString();
    await writeFile(metaPath, JSON.stringify(meta, null, 2));
    return true;
  } catch {
    return false;
  }
}
