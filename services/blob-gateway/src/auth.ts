/**
 * Unified auth helper for all write routes (Phase 4).
 *
 * Three tiers:
 * - api-key: Backwards-compatible API key auth (highest quotas)
 * - registered-validator: sr25519 sig from registered committee member (API-key-level quotas)
 * - sig-only: sr25519 sig from any funded account (default quotas)
 */

import type { Request } from "express";
import { resolveKey, lookupValidatorInfo, type KeyInfo } from "./quota.js";
import { verifyUploadSig } from "./upload-auth.js";
import { checkFunded } from "./rpc-client.js";

export type AuthTier = "sig-only" | "api-key" | "registered-validator";

export interface AuthResult {
  authenticated: boolean;
  tier?: AuthTier;
  identity?: string; // SS58 address or key name
  keyInfo?: KeyInfo;
  error?: string;
}

/**
 * Resolve auth for any request.
 * @param contentHash — required for upload sig verification (manifest/chunk/batch routes)
 */
export async function resolveAuth(req: Request, contentHash?: string): Promise<AuthResult> {
  // Priority 1: API key (highest trust, backwards compatible)
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (apiKey) {
    const keyInfo = resolveKey(apiKey);
    if (!keyInfo) return { authenticated: false, error: "Invalid or disabled API key" };
    return { authenticated: true, tier: "api-key", identity: keyInfo.name, keyInfo };
  }

  // Priority 2: Upload signature
  if (contentHash) {
    const sigResult = verifyUploadSig(req, contentHash);
    if (sigResult.valid && sigResult.address) {
      // Is this a registered validator? → highest quota tier
      const info = lookupValidatorInfo(sigResult.address);
      if (info) {
        return { authenticated: true, tier: "registered-validator", identity: sigResult.address };
      }
      // Is this a funded account? → sig-only tier
      const funded = await checkFunded(sigResult.address);
      if (funded) {
        return { authenticated: true, tier: "sig-only", identity: sigResult.address };
      }
      return { authenticated: false, error: "Account below minimum balance" };
    }
    if (sigResult.error) {
      return { authenticated: false, error: sigResult.error };
    }
  }

  return { authenticated: false, error: "No authentication provided" };
}
