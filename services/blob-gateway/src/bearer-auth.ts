/**
 * Bearer auth middleware — preferred entry point for authenticated write
 * routes. Accepts, in priority order:
 *
 *   1. Authorization: Bearer matra_<token>     (new, preferred)
 *   2. x-api-key: <random-hex>                 (legacy per-operator key
 *                                              minted at registration time)
 *   3. x-api-key: <ss58-address>               (legacy "SS58-as-API-key"
 *                                              — deprecated, warn-logged,
 *                                              will be removed once all
 *                                              clients migrate)
 *
 * On success, sets the following request properties for downstream handlers:
 *   - req.account  — SS58 address (whichever auth path resolved)
 *   - req.authTier — "bearer" | "api-key" | "api-key-legacy-ss58"
 *   - req.keyInfo  — KeyInfo from quota.ts if path 2/3
 */

import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { verifyToken, getApiTokensDb, TOKEN_PREFIX } from "./api-tokens.js";
import { resolveKey, type KeyInfo } from "./quota.js";

export type AuthTier = "bearer" | "api-key" | "api-key-legacy-ss58";

export interface AuthedRequest extends Request {
  account?: string;
  authTier?: AuthTier;
  keyInfo?: KeyInfo;
}

export interface BearerAuthOptions {
  /** If false, middleware passes through even when no auth is found. Default true. */
  required?: boolean;
}

/** Quick-and-dirty SS58 shape check — matches the one in routes/operators.ts */
const SS58_SHAPE = /^[15][a-zA-Z0-9]{45,47}$/;

export function bearerAuth(opts: BearerAuthOptions = {}): RequestHandler {
  const required = opts.required !== false;
  return function (req: Request, res: Response, next: NextFunction): void {
    const r = req as AuthedRequest;

    // Path 1: Authorization: Bearer matra_<token>
    const authHeader = (req.headers.authorization || req.headers.Authorization) as
      | string
      | undefined;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice("Bearer ".length).trim();
      if (token.startsWith(TOKEN_PREFIX)) {
        const verify = verifyToken(getApiTokensDb(), token);
        if (verify.valid) {
          r.account = verify.accountSs58;
          r.authTier = "bearer";
          next();
          return;
        }
        // Explicit Bearer header that failed verification: deny, don't fall
        // back. Falling back would mask revoked tokens.
        res.status(401).json({ error: `invalid bearer token: ${verify.reason}` });
        return;
      }
      // Bearer header with wrong prefix: still invalid.
      res.status(401).json({ error: "invalid bearer token: malformed" });
      return;
    }

    // Path 2 & 3: x-api-key
    const apiKey = req.headers["x-api-key"] as string | undefined;
    if (typeof apiKey === "string" && apiKey.length > 0) {
      const keyInfo = resolveKey(apiKey);
      if (keyInfo) {
        // Determine if this was the legacy "SS58-as-API-key" path: the header
        // value itself is an SS58 address AND the key row is bound to that
        // same address via validator_id. That's the pattern we want to track
        // so we know when all clients have moved off.
        const isLegacySs58 = SS58_SHAPE.test(apiKey) && keyInfo.validatorId === apiKey;
        if (isLegacySs58) {
          // Structured warn-log for easy grep / log-scan:
          //   deprecated-ss58-auth account=<ss58> route=<path>
          // Fields are space-separated so `| grep deprecated-ss58-auth` gives
          // a clean migration tracker.
          console.warn(
            `[blob-gateway] deprecated-ss58-auth account=${apiKey} route=${req.path} method=${req.method}`,
          );
          r.account = keyInfo.validatorId ?? apiKey;
          r.authTier = "api-key-legacy-ss58";
          r.keyInfo = keyInfo;
          next();
          return;
        }
        // Regular API key path (random hex, bound to operator SS58 via validator_id)
        r.account = keyInfo.validatorId ?? keyInfo.name;
        r.authTier = "api-key";
        r.keyInfo = keyInfo;
        next();
        return;
      }
      // Explicit api-key header that failed lookup
      res.status(401).json({ error: "invalid or disabled api key" });
      return;
    }

    if (required) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    next();
  };
}

/**
 * Lightweight admin-only guard — used to protect token-mint / token-revoke
 * endpoints. Compares a constant-time-ish string against the configured
 * admin token (same env var as the rest of our admin endpoints).
 */
export function adminGuard(expectedAdminToken: string): RequestHandler {
  const expectedBuf = Buffer.from(expectedAdminToken, "utf8");
  return function (req: Request, res: Response, next: NextFunction): void {
    const provided = req.headers["x-admin-token"];
    if (typeof provided !== "string" || provided.length === 0) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    // Timing-safe compare: reject short-circuit on mismatched length by
    // first hardening the candidate to the expected length, then using
    // constant-time equality. Length mismatch always takes the same path
    // as a content mismatch.
    const providedBuf = Buffer.from(provided, "utf8");
    const sameLen = providedBuf.length === expectedBuf.length;
    const candidate = sameLen
      ? providedBuf
      : Buffer.alloc(expectedBuf.length); // zero-filled; never matches
    const equal = timingSafeEqual(candidate, expectedBuf);
    if (!sameLen || !equal) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}
