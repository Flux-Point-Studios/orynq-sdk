/**
 * Blob upload and status routes.
 */

import { Router, type Request, type Response } from "express";
import { createHash } from "crypto";
import { saveManifest, getManifest, saveChunk, getChunk, getStatus, markCertified, updateReceiptMeta } from "../storage.js";
import { config } from "../config.js";
import {
  startUpload, recordChunkBytes, finalizeUpload,
  startAccountUpload, recordAccountChunkBytes, finalizeAccountUpload,
} from "../quota.js";
import { resolveAuth } from "../auth.js";

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
 *
 * Auth (unified via resolveAuth): Bearer → x-api-key (legacy incl. SS58-as-key)
 * → sr25519 upload signature. The Bearer and api-key tiers are pre-funded
 * (operators authorised by admin); sig-only tier is balance-gated inside
 * resolveAuth() via checkFunded().
 */
blobsRouter.post("/blobs/:contentHash/manifest", async (req: Request, res: Response) => {
  try {
    const { contentHash } = req.params;
    const manifest = req.body;

    if (!manifest || typeof manifest !== "object") {
      res.status(400).json({ error: "Invalid manifest: expected JSON object" });
      return;
    }

    const auth = await resolveAuth(req, contentHash);
    if (!auth.authenticated) {
      // Preserve existing 403 for the specific "below min balance" case so
      // Penny's client can keep distinguishing 401 (no/invalid creds) from
      // 403 (valid sig, underfunded account).
      if (auth.error && auth.error.toLowerCase().includes("below minimum balance")) {
        res.status(403).json({ error: "Account does not meet minimum MATRA balance" });
        return;
      }
      res.status(401).json({ error: auth.error ?? "authentication required" });
      return;
    }

    // Dispatch quota tracking by tier. Bearer/api-key tiers use per-operator
    // keyed quotas if the account is a registered operator; otherwise (bearer
    // tied to an unregistered account) we fall back to per-account quotas.
    // Sig-only + registered-validator always use per-account quotas.
    let uploaderAddress: string | undefined;
    const useKeyedQuotas =
      (auth.tier === "bearer" || auth.tier === "api-key" || auth.tier === "api-key-legacy-ss58") &&
      auth.keyInfo !== undefined;

    if (useKeyedQuotas && auth.keyInfo) {
      const quotaCheck = startUpload(auth.keyInfo, contentHash);
      if (!quotaCheck.allowed) {
        res.status(429).json({ error: quotaCheck.error, limit: quotaCheck.limit, current: quotaCheck.current });
        return;
      }
    } else {
      // Account-based quota — covers sig-only, registered-validator, and
      // Bearer tokens for operators not yet present in quota.db api_keys.
      const accountId = auth.identity;
      if (!accountId) {
        res.status(401).json({ error: "resolved auth has no identity" });
        return;
      }
      const quotaCheck = startAccountUpload(accountId, contentHash);
      if (!quotaCheck.allowed) {
        res.status(429).json({ error: quotaCheck.error, limit: quotaCheck.limit, current: quotaCheck.current });
        return;
      }
      // Record uploader address only for actual sig-based uploads, mirroring
      // previous behaviour (Bearer/api-key don't set uploaderAddress in meta).
      if (auth.tier === "sig-only" || auth.tier === "registered-validator") {
        uploaderAddress = accountId;
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

    // Record uploader address for sig-based uploads
    if (uploaderAddress) {
      await updateReceiptMeta(contentHash, { uploaderAddress });
    }

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
 *
 * Auth (unified via resolveAuth): Bearer → x-api-key (legacy incl. SS58) →
 * sr25519 upload signature. Same dispatch as POST manifest; no header is
 * strictly required on the chunk leg if the manifest was authed, but if any
 * auth is present we validate + record quotas.
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

    // Resolve auth once for quota routing.
    //
    // Historical behaviour: if no auth header was present the chunk leg
    // silently allowed the write (SHA-256 was the guard). We keep that
    // fallback so existing sig-without-sig-headers-on-chunk flows don't
    // regress, but when any auth is present we validate it and record
    // quotas. A Bearer token that *fails* verification, however, is rejected
    // outright — we never mask a revoked token as "unauthenticated".
    const hasAuthHeader =
      typeof req.headers.authorization === "string" ||
      typeof req.headers["x-api-key"] === "string" ||
      typeof req.headers["x-upload-sig"] === "string";
    const auth = hasAuthHeader ? await resolveAuth(req, contentHash) : null;

    if (auth && !auth.authenticated) {
      if (auth.error && auth.error.toLowerCase().includes("below minimum balance")) {
        res.status(403).json({ error: "Account does not meet minimum MATRA balance" });
        return;
      }
      res.status(401).json({ error: auth.error ?? "authentication required" });
      return;
    }

    const useKeyedQuotas =
      auth !== null &&
      (auth.tier === "bearer" || auth.tier === "api-key" || auth.tier === "api-key-legacy-ss58") &&
      auth.keyInfo !== undefined;

    if (useKeyedQuotas && auth && auth.keyInfo) {
      const quotaCheck = recordChunkBytes(auth.keyInfo, contentHash, data.length);
      if (!quotaCheck.allowed) {
        res.status(429).json({ error: quotaCheck.error, limit: quotaCheck.limit, current: quotaCheck.current });
        return;
      }
    } else if (auth && auth.identity) {
      const quotaCheck = recordAccountChunkBytes(auth.identity, contentHash, data.length);
      if (!quotaCheck.allowed) {
        res.status(429).json({ error: quotaCheck.error, limit: quotaCheck.limit, current: quotaCheck.current });
        return;
      }
    }
    // else: no auth header present → legacy fallthrough (SHA-256 is the guard)

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
    if (statusAfter.complete) {
      if (useKeyedQuotas && auth && auth.keyInfo) {
        const finalCheck = finalizeUpload(auth.keyInfo, contentHash);
        if (!finalCheck.allowed) {
          console.warn(`[blob-gateway] Receipt quota exceeded for key ${auth.keyInfo.name} but upload already complete`);
        }
      } else if (auth && auth.identity) {
        const finalCheck = finalizeAccountUpload(auth.identity, contentHash);
        if (!finalCheck.allowed) {
          console.warn(`[blob-gateway] Receipt quota exceeded for ${auth.identity} but upload already complete`);
        }
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
 * Requires auth: API key or sr25519 signature (Phase 4).
 */
blobsRouter.patch("/blobs/:contentHash/certified", async (req: Request, res: Response) => {
  try {
    const { contentHash } = req.params;

    const auth = await resolveAuth(req, contentHash);
    if (!auth.authenticated) {
      res.status(401).json({ error: auth.error });
      return;
    }

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
