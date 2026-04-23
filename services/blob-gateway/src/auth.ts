/**
 * Unified auth helper for all write routes (Phase 4).
 *
 * Four tiers:
 * - bearer: `Authorization: Bearer matra_<token>` — opaque random token (preferred)
 * - api-key: Backwards-compatible API key auth (highest quotas)
 * - registered-validator: sr25519 sig from registered committee member (API-key-level quotas)
 * - sig-only: sr25519 sig from any funded account (default quotas)
 */

import type { Request } from "express";
import { resolveKey, lookupValidatorInfo, type KeyInfo } from "./quota.js";
import { verifyUploadSig } from "./upload-auth.js";
import { checkFunded } from "./rpc-client.js";
import {
  getApiTokensDb,
  verifyToken,
  TOKEN_PREFIX,
} from "./api-tokens.js";

export type AuthTier =
  | "bearer"
  | "sig-only"
  | "api-key"
  | "api-key-legacy-ss58"
  | "registered-validator";

export interface AuthResult {
  authenticated: boolean;
  tier?: AuthTier;
  identity?: string; // SS58 address or key name
  keyInfo?: KeyInfo;
  error?: string;
}

/** SS58 address shape check — mirrors the one in routes/operators.ts. */
const SS58_SHAPE = /^[15][a-zA-Z0-9]{45,47}$/;

/**
 * Resolve auth for any request.
 * @param contentHash — required for upload sig verification (manifest/chunk/batch routes)
 */
export async function resolveAuth(req: Request, contentHash?: string): Promise<AuthResult> {
  // Priority 0: Bearer token (preferred, opaque, revocable, hashed-at-rest)
  const authHeader = (req.headers.authorization || (req.headers as Record<string, unknown>)[
    "Authorization"
  ]) as string | undefined;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    if (token.startsWith(TOKEN_PREFIX)) {
      try {
        const verify = verifyToken(getApiTokensDb(), token);
        if (verify.valid) {
          return {
            authenticated: true,
            tier: "bearer",
            identity: verify.accountSs58,
          };
        }
        return {
          authenticated: false,
          error: `Invalid bearer token: ${verify.reason}`,
        };
      } catch (err) {
        // api-tokens DB not yet initialized — fall through to legacy paths
        // so we fail closed only when there's no other valid credential.
        console.error(
          `[blob-gateway] bearer-auth error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Priority 1: API key (highest trust, backwards compatible)
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (apiKey) {
    const keyInfo = resolveKey(apiKey);
    if (!keyInfo) return { authenticated: false, error: "Invalid or disabled API key" };

    // Emit a warn-log whenever the header is an SS58 address bound to the
    // same address (the deprecated "SS58-as-API-key" pattern). This lets
    // us grep `deprecated-ss58-auth` to track migration progress.
    if (SS58_SHAPE.test(apiKey) && keyInfo.validatorId === apiKey) {
      console.warn(
        `[blob-gateway] deprecated-ss58-auth account=${apiKey} route=${req.path} method=${req.method}`,
      );
      return {
        authenticated: true,
        tier: "api-key-legacy-ss58",
        identity: keyInfo.validatorId ?? keyInfo.name,
        keyInfo,
      };
    }

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
