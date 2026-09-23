/**
 * HTTP surface of the anchor worker.
 *
 * Location: services/anchor-worker/src/app.ts
 */

import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  isValidHashFormat,
  POI_METADATA_LABEL,
  SubmitQueueFullError,
  type CardanoNetwork,
} from "@fluxpointstudios/orynq-sdk-anchors-cardano";
import type { AnchorProcessTrace, ManifestData } from "./anchor.js";
import { anchorErrorBody } from "./error-response.js";

/** A full queue drains at roughly one chain per block, about 20s on preprod. */
export const RETRY_AFTER_SECONDS = 60;

export function createApp({
  token,
  network,
  anchor,
}: {
  token: string;
  network: CardanoNetwork;
  anchor: AnchorProcessTrace;
}): Express {
  const app = express();

  // Request size limit 1MB
  app.use(express.json({ limit: "1mb" }));

  /**
   * Authentication middleware for internal service calls.
   * Rejects requests without valid X-Internal-Token header.
   */
  function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    const provided = req.headers["x-internal-token"];

    if (!provided || provided !== token) {
      res.status(403).json({ error: "Forbidden: Invalid or missing token" });
      return;
    }

    next();
  }

  /**
   * Health check endpoint.
   * Does not require authentication.
   */
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "anchor-worker" });
  });

  /**
   * Process trace anchor endpoint.
   * Requires X-Internal-Token authentication.
   *
   * POST /anchor/process-trace
   * Body: {
   *   requestId: string,
   *   manifest: ManifestData,
   *   storageUri?: string
   * }
   *
   * 503 with Retry-After when the submit queue is full.
   */
  app.post("/anchor/process-trace", authMiddleware, async (req: Request, res: Response) => {
    try {
      const { requestId, manifest, storageUri } = req.body as {
        requestId?: string;
        manifest?: ManifestData;
        storageUri?: string;
      };

      if (!requestId) {
        res.status(400).json({ error: "Missing required field: requestId" });
        return;
      }

      if (!manifest) {
        res.status(400).json({ error: "Missing required field: manifest" });
        return;
      }

      if (!manifest.rootHash) {
        res.status(400).json({ error: "Missing required field: manifest.rootHash" });
        return;
      }

      if (!manifest.manifestHash) {
        res.status(400).json({ error: "Missing required field: manifest.manifestHash" });
        return;
      }

      const hashes: Array<[string, unknown]> = [
        ["rootHash", manifest.rootHash],
        ["manifestHash", manifest.manifestHash],
      ];
      if (manifest.merkleRoot) hashes.push(["merkleRoot", manifest.merkleRoot]);
      const malformed = hashes.find(
        ([, value]) => typeof value !== "string" || !isValidHashFormat(value)
      );
      if (malformed) {
        res.status(400).json({
          error: `Invalid manifest.${malformed[0]}: expected 64 lowercase hex characters, optionally prefixed with sha256:`,
        });
        return;
      }

      console.log(`[anchor] Processing request: ${requestId}`);

      const result = await anchor(requestId, manifest, storageUri);

      console.log(`[anchor] Request ${requestId} completed: txHash=${result.txHash}`);

      res.json({
        success: true,
        ...result,
      });
    } catch (error) {
      if (error instanceof SubmitQueueFullError) {
        console.warn(`[anchor] Shedding request: ${error.message}`);
        res
          .status(503)
          .set("Retry-After", String(RETRY_AFTER_SECONDS))
          .json(anchorErrorBody(error, network, POI_METADATA_LABEL));
        return;
      }

      console.error("[anchor] Error processing request:", error);

      res.status(500).json(anchorErrorBody(error, network, POI_METADATA_LABEL));
    }
  });

  return app;
}
