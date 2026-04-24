/**
 * Admin routes for Bearer-token lifecycle:
 *
 *   POST   /auth/token            -- mint a new token for an SS58 (admin-only)
 *   DELETE /auth/token/:hash      -- revoke a token by hash (admin-only)
 *   GET    /auth/tokens           -- list tokens (hashes + metadata, admin-only)
 *
 * All three endpoints require x-admin-token (same env var used elsewhere —
 * DAEMON_NOTIFY_TOKEN — to avoid sprouting a new secret channel).
 *
 * NOTE: these endpoints NEVER reveal or accept raw tokens anywhere except
 * the single mint response. Never log, never store, never list the plaintext.
 */

import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";
import { randomBytes } from "crypto";
import { config } from "../config.js";
import {
  issueToken,
  revokeToken,
  listTokens,
  getApiTokensDb,
  TOKEN_PREFIX,
} from "../api-tokens.js";
import { adminGuard } from "../bearer-auth.js";
import { resolveKeyByAccount, getUsage, getDailyUsage } from "../quota.js";

const SS58_SHAPE = /^[15][a-zA-Z0-9]{45,47}$/;

/**
 * Test hook — kept for symmetry with other modules' test hooks. Tests that
 * already call setApiTokensDb() don't need this separately, but we expose
 * it so future tests can stub it without touching module internals.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function setOperatorsDbForTests(_db: Database.Database): void {
  // no-op: in production and in tests, api_tokens and the registrations
  // table share the same operators.db file, which is set up by the
  // api-tokens module via setApiTokensDb().
}


export interface RegisterTokenRoutesOpts {
  /** Admin shared secret (falls back to config.daemonNotifyToken if empty). */
  adminToken?: string;
}

export function registerTokenRoutes(app: Express, opts: RegisterTokenRoutesOpts = {}): void {
  const adminToken = (opts.adminToken || config.daemonNotifyToken || "").trim();
  if (!adminToken) {
    // Still mount the routes so we return a clear 503 rather than a 404;
    // surfaces misconfiguration loudly instead of silently.
    app.post("/auth/token", (_req, res) => {
      res.status(503).json({ error: "admin token not configured" });
    });
    app.delete("/auth/token/:hash", (_req, res) => {
      res.status(503).json({ error: "admin token not configured" });
    });
    app.get("/auth/tokens", (_req, res) => {
      res.status(503).json({ error: "admin token not configured" });
    });
    app.get("/auth/token/:hash/usage", (_req, res) => {
      res.status(503).json({ error: "admin token not configured" });
    });
    return;
  }
  const guard = adminGuard(adminToken);

  app.post("/auth/token", guard, (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        account?: string;
        label?: string;
      };
      if (typeof body.account !== "string" || !SS58_SHAPE.test(body.account)) {
        res.status(400).json({ error: "missing or invalid account (expected SS58 address)" });
        return;
      }
      const label =
        typeof body.label === "string" && body.label.trim()
          ? body.label.trim().slice(0, 128)
          : null;

      const issued = issueToken(getApiTokensDb(), {
        accountSs58: body.account,
        label: label ?? undefined,
      });

      // Structured audit log — account + label, never the raw token.
      console.log(
        `[blob-gateway] api-token minted account=${issued.accountSs58} label=${label ?? "-"} hash=${issued.tokenHash.slice(0, 16)}...`,
      );

      res.status(200).json({
        status: "created",
        token: issued.token, // SHOWN ONCE
        tokenHash: issued.tokenHash,
        account: issued.accountSs58,
        label: issued.label,
        createdAt: issued.createdAt,
        message: "Store this token now. It will never be shown again.",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.delete("/auth/token/:hash", guard, (req: Request, res: Response) => {
    try {
      const hash = String(req.params.hash || "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        res.status(400).json({ error: "invalid token hash (expected 64 hex chars)" });
        return;
      }
      const reason =
        typeof req.body?.reason === "string" && req.body.reason.trim()
          ? String(req.body.reason).trim().slice(0, 256)
          : "admin-revoke";
      const result = revokeToken(getApiTokensDb(), { tokenHash: hash, reason });
      if (!result.revoked) {
        res.status(404).json({ error: "token not found or already revoked" });
        return;
      }
      console.log(
        `[blob-gateway] api-token revoked hash=${hash.slice(0, 16)}... reason="${reason}"`,
      );
      res.status(200).json({ status: "revoked", tokenHash: hash, reason });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.get("/auth/tokens", guard, (req: Request, res: Response) => {
    try {
      const account =
        typeof req.query.account === "string" && SS58_SHAPE.test(req.query.account)
          ? req.query.account
          : undefined;
      const includeRevoked = req.query.includeRevoked === "1";
      const tokens = listTokens(getApiTokensDb(), {
        ...(account ? { account } : {}),
        includeRevoked,
      });
      res.status(200).json({ tokens });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /auth/token/:hash/usage  (admin-only)
   *
   * Phase 1 billing introspection. Returns the lifetime + today's usage
   * for the api_keys row bound to this token's SS58. The join is:
   *
   *   :hash (tokenHash from api_tokens)
   *     → api_tokens.account_ss58
   *     → api_keys.validator_id
   *     → api_keys.key_hash
   *     → lifetime_receipts, lifetime_bytes, lifetime_matra_debited
   *
   * 404 if either the token hash is unknown or the operator has no
   * api_keys row yet (e.g. a Bearer was minted but the operator hasn't
   * been granted a keyed-quota entry — this currently falls back to
   * account-based quotas, which we'll surface in a future Phase 1.x).
   */
  app.get("/auth/token/:hash/usage", guard, (req: Request, res: Response) => {
    try {
      const hash = String(req.params.hash || "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        res.status(400).json({ error: "invalid token hash (expected 64 hex chars)" });
        return;
      }

      const tokensDb = getApiTokensDb();
      const tokenRow = tokensDb
        .prepare(
          `SELECT account_ss58, label FROM api_tokens WHERE token_hash = ?`,
        )
        .get(hash) as { account_ss58: string; label: string | null } | undefined;
      if (!tokenRow) {
        res.status(404).json({ error: "token not found" });
        return;
      }

      const keyInfo = resolveKeyByAccount(tokenRow.account_ss58);
      if (!keyInfo) {
        res.status(404).json({ error: "no api_keys row bound to this account" });
        return;
      }

      const usage = getUsage(keyInfo.keyHash);
      if (!usage) {
        // Defensive: resolveKeyByAccount() just handed us a keyHash so
        // getUsage() should never miss — but treat missing as 404 rather
        // than leaking an internal-consistency 500.
        res.status(404).json({ error: "usage row missing for key_hash" });
        return;
      }

      const daily = getDailyUsage(keyInfo.keyHash);

      res.status(200).json({
        tokenHash: hash,
        accountSs58: tokenRow.account_ss58,
        label: tokenRow.label,
        lifetime: {
          receipts: usage.lifetime_receipts,
          bytes: usage.lifetime_bytes,
          matra_debited: usage.lifetime_matra_debited,
        },
        today: {
          receipts: daily.receipts_today,
          bytes: daily.bytes_today,
        },
        caps: {
          max_receipts_per_day: usage.max_receipts_per_day,
          max_bytes_per_day: usage.max_bytes_per_day,
        },
        last_used_at: usage.last_used_at,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

}

/**
 * Test helper: mint a token directly against a provided DB handle.
 * Mirrors what the CLI does.
 */
export function mintAdminTokenForTests(
  db: Database.Database,
  input: { account: string; label?: string | undefined },
): { token: string; tokenHash: string } {
  if (!SS58_SHAPE.test(input.account)) {
    // Bypass SS58 shape in tests if they really want to — we accept any
    // non-empty string here because unit tests may use fake addresses.
    if (!input.account) throw new Error("account required");
  }
  const issued = issueToken(db, {
    accountSs58: input.account,
    label: input.label,
  });
  return { token: issued.token, tokenHash: issued.tokenHash };
}

/**
 * Generate a stable default admin token for first-boot bootstrap. Only used
 * by the CLI in unit tests — real deployments configure
 * DAEMON_NOTIFY_TOKEN via the K8s secret or docker env.
 */
export function newRandomAdminToken(): string {
  return `admin-${randomBytes(16).toString("hex")}`;
}

export { TOKEN_PREFIX };
