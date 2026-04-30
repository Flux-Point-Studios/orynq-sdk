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
  recordUsage,
} from "../quota.js";
import { resolveAuth } from "../auth.js";
import { notifySponsoredReceiptSubmitter, isSponsoredTier } from "../sponsored-receipts.js";
import {
  computeRootHashFromChunks,
  isValidRootHash,
  stripHexPrefix as stripHexPrefixUtil,
} from "../merkle.js";

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
      // Phase 1 billing: count one receipt per admitted manifest POST.
      // Bytes are attributed in the chunk leg. Not gated on saveManifest
      // success — startUpload() already recorded the intent in the inflight
      // table, and in practice saveManifest() failure is a disk error that
      // the error handler converts to 500; we accept minor drift in the
      // pathological crash-between-these-two-calls case.
      try {
        recordUsage(auth.keyInfo.keyHash, 0, 1);
      } catch (err) {
        console.warn(
          `[blob-gateway] recordUsage(manifest) failed for ${auth.keyInfo.name}:`,
          err,
        );
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
    const manifestBody = req.body as { chunks?: Array<{ size?: number; sha256?: string; index?: number }>; rootHash?: unknown };
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

    // Server-side rootHash compute (task #93, paired with task #60).
    //
    // The sponsored-receipt-submitter callback payload includes `rootHash`
    // from `manifest.rootHash`. If a thin SDK client (e.g. Penny's OpenHome
    // DevKit daemon) omits it, the receipt-submitter can no longer fall
    // back to GET-the-manifest because (a) we now serve such a route below,
    // and (b) we precompute here so the callback payload is always
    // populated when the manifest carries chunks.
    //
    // Compute is identical to the cert-daemon's `daemon/merkle.py` so the
    // on-chain `base_root_sha256` matches what cert-daemons compute on
    // verify. Mismatch = instant CertHashMismatch.
    //
    // Behaviour matrix:
    //   client supplied valid hex     → use it as-is
    //   client supplied invalid hex   → log warning + replace with computed
    //   client did not supply         → compute + log info-level
    //   client supplied valid hex but → log warning, but DO NOT overwrite
    //     it differs from computed       (existing on-chain receipts may
    //                                    have been signed against the
    //                                    client's value)
    if (manifestBody.chunks && manifestBody.chunks.length > 0) {
      const clientRoot = manifestBody.rootHash;
      let computed: string | undefined;
      try {
        computed = computeRootHashFromChunks(manifestBody.chunks);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[blob-gateway] rootHash compute skipped (manifest invalid): ${msg} ` +
            `contentHash=${contentHash}`,
        );
      }

      if (typeof clientRoot === "string" && isValidRootHash(clientRoot)) {
        const clientNorm = stripHexPrefixUtil(clientRoot).toLowerCase();
        if (computed && clientNorm !== computed) {
          console.warn(
            `[blob-gateway] rootHash drift: client=${clientNorm} ` +
              `computed=${computed} contentHash=${contentHash} ` +
              `(keeping client value to avoid breaking already-signed receipts)`,
          );
        }
        // Preserve client value verbatim — this honours the "compute is a
        // fallback, not a replacement" rule so existing flows never drift.
      } else if (computed) {
        if (typeof clientRoot === "string" && clientRoot.length > 0) {
          console.warn(
            `[blob-gateway] rootHash present but not valid 64-hex — ` +
              `replacing with server-side compute. raw=${JSON.stringify(clientRoot).slice(0, 80)} ` +
              `contentHash=${contentHash}`,
          );
        } else {
          console.log(
            `[blob-gateway] rootHash absent in manifest — computed server-side: ${computed} ` +
              `contentHash=${contentHash}`,
          );
        }
        (manifest as Record<string, unknown>).rootHash = computed;
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
 * GET /blobs/:contentHash/manifest
 * Returns the stored manifest JSON for a blob.
 *
 * Auth (unified via resolveAuth): mirrors POST /blobs/:contentHash/manifest
 * — Bearer → x-api-key (legacy incl. SS58-as-key) → sr25519 upload signature.
 * Sig-only requests are balance-gated inside resolveAuth().
 *
 * Returns:
 *   200 + JSON manifest body if found
 *   401 if auth missing/invalid
 *   403 if account is below minimum balance (sig tier)
 *   404 if no manifest is stored under this contentHash
 *
 * Why auth-gated and not public: the manifest enumerates chunk URLs and
 * sha256 digests, which are upload-attribution metadata; while the chunks
 * themselves are content-addressed and protected by SHA-256, exposing the
 * manifest list publicly would let unauthenticated callers enumerate which
 * blobs an operator has uploaded. Auth-gating matches the POST side and
 * keeps the surface symmetric.
 */
blobsRouter.get("/blobs/:contentHash/manifest", async (req: Request, res: Response) => {
  try {
    const { contentHash } = req.params;

    const auth = await resolveAuth(req, contentHash);
    if (!auth.authenticated) {
      if (auth.error && auth.error.toLowerCase().includes("below minimum balance")) {
        res.status(403).json({ error: "Account does not meet minimum MATRA balance" });
        return;
      }
      res.status(401).json({ error: auth.error ?? "authentication required" });
      return;
    }

    const manifest = await getManifest(contentHash);
    if (!manifest) {
      res.status(404).json({ error: "Manifest not found" });
      return;
    }
    res.status(200).json(manifest);
  } catch (error) {
    console.error("[blob-gateway] Error fetching manifest:", error);
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

    // Phase 1 billing: credit bytes to the Bearer/API-key holder. Skipped
    // for sig-only / registered-validator (no key-hash to attribute to —
    // those use account-based quotas and will get their own meter in
    // Phase 2 if/when we want to bill sig-only uploaders).
    if (useKeyedQuotas && auth && auth.keyInfo) {
      try {
        recordUsage(auth.keyInfo.keyHash, data.length, 0);
      } catch (err) {
        console.warn(
          `[blob-gateway] recordUsage(chunk) failed for ${auth.keyInfo.name}:`,
          err,
        );
      }
    }

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

      // Sponsored-receipt hand-off: if this upload was sponsored (Bearer
      // or api-key tier) and an external submitter is configured, fire
      // a notification so the submitter can build + sign + send the
      // on-chain receipt. Fire-and-forget — never blocks the 200 OK.
      if (
        config.sponsoredReceiptSubmitterUrl &&
        auth &&
        isSponsoredTier(auth.tier) &&
        auth.identity
      ) {
        const manifestJson = JSON.stringify(manifest);
        const manifestHash = createHash("sha256").update(manifestJson).digest("hex");
        const rawRoot = manifest["rootHash"];
        const rootHash = typeof rawRoot === "string"
          ? rawRoot.replace(/^0x/, "")
          : undefined;
        void notifySponsoredReceiptSubmitter({
          contentHash,
          operator: auth.identity,
          authTier: auth.tier,
          rootHash,
          manifestHash,
        });
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
