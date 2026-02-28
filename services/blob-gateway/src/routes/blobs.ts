/**
 * Blob upload and status routes.
 */

import { Router, type Request, type Response } from "express";
import { createHash } from "crypto";
import { saveManifest, getManifest, saveChunk, getChunk, getStatus, markCertified } from "../storage.js";
import { config } from "../config.js";
import { resolveKey, startUpload, recordChunkBytes, finalizeUpload } from "../quota.js";

export const blobsRouter = Router();

interface ManifestChunk {
  index: number;
  sha256: string;
  size: number;
  url?: string;
  path?: string;
}

interface Manifest {
  chunks: ManifestChunk[];
  [key: string]: unknown;
}

/**
 * POST /blobs/:contentHash/manifest
 * Saves the manifest JSON for a blob.
 */
blobsRouter.post("/blobs/:contentHash/manifest", async (req: Request, res: Response) => {
  try {
    const { contentHash } = req.params;
    const manifest = req.body;

    if (!manifest || typeof manifest !== "object") {
      res.status(400).json({ error: "Invalid manifest: expected JSON object" });
      return;
    }

    // Quota: authenticate and check concurrent uploads
    const apiKey = req.headers["x-api-key"] as string | undefined;
    const keyInfo = apiKey ? resolveKey(apiKey) : null;
    if (keyInfo) {
      const quotaCheck = startUpload(keyInfo, contentHash);
      if (!quotaCheck.allowed) {
        res.status(429).json({ error: quotaCheck.error, limit: quotaCheck.limit, current: quotaCheck.current });
        return;
      }
    }

    // Content limits validation
    const manifestBody = req.body as { chunks?: Array<{ size?: number }> };
    if (manifestBody.chunks) {
      if (manifestBody.chunks.length > config.maxChunksPerManifest) {
        res.status(400).json({ error: `Too many chunks: ${manifestBody.chunks.length} > ${config.maxChunksPerManifest}` });
        return;
      }
      const totalBytes = manifestBody.chunks.reduce((sum, c) => sum + (c.size || 0), 0);
      if (totalBytes > config.maxBlobBytesPerManifest) {
        res.status(400).json({ error: `Total blob size ${totalBytes} exceeds limit ${config.maxBlobBytesPerManifest}` });
        return;
      }
      for (const chunk of manifestBody.chunks) {
        if (chunk.size && chunk.size > config.maxChunkBytes) {
          res.status(400).json({ error: `Chunk size ${chunk.size} exceeds limit ${config.maxChunkBytes}` });
          return;
        }
      }
    }

    await saveManifest(contentHash, manifest);
    res.status(201).json({ status: "ok", contentHash });
  } catch (error) {
    console.error("[blob-gateway] Error saving manifest:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

/**
 * PUT /blobs/:contentHash/chunks/:i
 * Uploads a chunk binary. Validates SHA-256 against manifest entry.
 * Returns 409 if chunk already exists (idempotent).
 * Returns 400 if manifest not found or chunk index out of range.
 */
blobsRouter.put("/blobs/:contentHash/chunks/:i", async (req: Request, res: Response) => {
  try {
    const { contentHash, i } = req.params;
    const chunkIndex = parseInt(i, 10);

    if (isNaN(chunkIndex) || chunkIndex < 0) {
      res.status(400).json({ error: "Invalid chunk index" });
      return;
    }

    const manifest = await getManifest(contentHash) as Manifest | null;
    if (!manifest) {
      res.status(400).json({ error: "Manifest not found. Upload manifest first." });
      return;
    }

    if (!manifest.chunks || chunkIndex >= manifest.chunks.length) {
      res.status(400).json({ error: `Chunk index ${chunkIndex} out of range (${manifest.chunks ? manifest.chunks.length : 0} chunks in manifest)` });
      return;
    }

    // Check if chunk already exists
    const existing = await getChunk(contentHash, chunkIndex);
    if (existing) {
      res.status(409).json({ status: "already_exists", chunkIndex });
      return;
    }

    const data = req.body as Buffer;
    if (!data || data.length === 0) {
      res.status(400).json({ error: "Empty chunk body" });
      return;
    }

    // Content-Length validation
    const contentLength = parseInt(req.headers["content-length"] || "0", 10);
    if (contentLength > config.maxChunkBytes) {
      res.status(400).json({ error: `Chunk too large: ${contentLength} > ${config.maxChunkBytes}` });
      return;
    }

    // Quota: record bytes
    const apiKey = req.headers["x-api-key"] as string | undefined;
    const keyInfo = apiKey ? resolveKey(apiKey) : null;
    if (keyInfo && data) {
      const quotaCheck = recordChunkBytes(keyInfo, contentHash, data.length);
      if (!quotaCheck.allowed) {
        res.status(429).json({ error: quotaCheck.error, limit: quotaCheck.limit, current: quotaCheck.current });
        return;
      }
    }

    // Validate SHA-256 against manifest entry
    const manifestChunk = manifest.chunks[chunkIndex];
    if (manifestChunk.sha256) {
      const computed = createHash("sha256").update(data).digest("hex");
      const expected = manifestChunk.sha256.startsWith("0x")
        ? manifestChunk.sha256.slice(2)
        : manifestChunk.sha256;
      if (computed !== expected) {
        res.status(400).json({
          error: "SHA-256 mismatch",
          expected,
          computed,
        });
        return;
      }
    }

    await saveChunk(contentHash, chunkIndex, data);

    // Check if upload is now complete and finalize quota
    const statusAfter = await getStatus(contentHash);
    if (statusAfter.complete && keyInfo) {
      const finalCheck = finalizeUpload(keyInfo, contentHash);
      if (!finalCheck.allowed) {
        // Upload is complete but over receipt quota — log warning but don't fail
        console.warn(`[blob-gateway] Receipt quota exceeded for key ${keyInfo.name} but upload already complete`);
      }
    }

    res.status(200).json({ status: "ok", chunkIndex });
  } catch (error) {
    console.error("[blob-gateway] Error saving chunk:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

/**
 * GET /blobs/:contentHash/status
 * Returns blob status. PUBLIC (no auth required).
 */
blobsRouter.get("/blobs/:contentHash/status", async (req: Request, res: Response) => {
  try {
    const { contentHash } = req.params;
    const status = await getStatus(contentHash);
    res.json(status);
  } catch (error) {
    console.error("[blob-gateway] Error getting status:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

/**
 * PATCH /blobs/:contentHash/certified
 * Marks a receipt as certified — sets certifiedAt in receipt.meta.json.
 */
blobsRouter.patch("/blobs/:contentHash/certified", async (req: Request, res: Response) => {
  try {
    const { contentHash } = req.params;
    const success = await markCertified(contentHash);
    if (success) {
      res.json({ status: "ok", contentHash, certifiedAt: new Date().toISOString() });
    } else {
      res.status(404).json({ error: "Receipt metadata not found" });
    }
  } catch (error) {
    console.error("[blob-gateway] Error marking certified:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});
