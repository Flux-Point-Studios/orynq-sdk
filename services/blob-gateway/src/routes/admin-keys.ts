/**
 * Admin routes for `api_keys` introspection + the Task #94
 * `bound_validator_aura` binding (off-chain cache version).
 *
 *   GET    /admin/api-keys/:keyHash             -- read the api_keys row
 *   POST   /admin/api-keys/:keyHash/binding     -- set bound_validator_aura
 *   DELETE /admin/api-keys/:keyHash/binding     -- clear bound_validator_aura
 *
 * All three endpoints require x-admin-token (same env var as the rest of
 * our admin endpoints — DAEMON_NOTIFY_TOKEN).
 *
 * Background: the explorer's Validators tab keys on aura SS58 and looks up
 * heartbeats by that exact address. Operators using SEPARATE keys (validator
 * aura ≠ cert-daemon signer — security best practice) show "No heartbeat"
 * forever even when their cert-daemon IS healthy. This binding lets the
 * explorer JOIN from a committee aura to the cert-daemon api_keys row, then
 * follow validator_id → heartbeat-store entry to render the right status.
 *
 * The on-chain authoritative version of this binding is a separate later
 * task; this off-chain cache lets us register the mapping without a
 * runtime upgrade.
 */

import type { Express, Request, Response } from "express";
import { checkAddress } from "@polkadot/util-crypto";
import { config } from "../config.js";
import {
  bindValidatorAura,
  clearValidatorAuraBinding,
  getApiKeyByHash,
} from "../quota.js";
import { adminGuard } from "../bearer-auth.js";

/**
 * Materios uses substrate prefix 42 (the generic substrate prefix), but
 * @polkadot/util-crypto's `checkAddress(addr, prefix)` rejects with
 * "Prefix mismatch" if you pass anything that doesn't equal `prefix`. The
 * explorer reverse-decodes by raw public key anyway, so we accept any
 * valid SS58 by trying a small allow-list of substrate prefixes. Adding
 * a new chain just means adding its prefix here.
 */
const ALLOWED_SS58_PREFIXES = [42, 0]; // 42 = generic substrate, 0 = Polkadot

const KEY_HASH_REGEX = /^[0-9a-f]{64}$/;

interface RegisterAdminKeysRoutesOpts {
  /** Admin shared secret (falls back to config.daemonNotifyToken if empty). */
  adminToken?: string;
}

function isValidSs58(addr: unknown): addr is string {
  if (typeof addr !== "string" || addr.length === 0) return false;
  for (const prefix of ALLOWED_SS58_PREFIXES) {
    try {
      const [ok] = checkAddress(addr, prefix);
      if (ok) return true;
    } catch {
      // try next prefix
    }
  }
  return false;
}

export function registerAdminKeysRoutes(
  app: Express,
  opts: RegisterAdminKeysRoutesOpts = {},
): void {
  const adminToken = (opts.adminToken || config.daemonNotifyToken || "").trim();

  if (!adminToken) {
    // Mount as 503 stubs so callers see "misconfigured" instead of 404 —
    // mirrors the same pattern used in routes/tokens.ts when the admin
    // token is missing. Surfaces config drift loudly.
    const stub = (_req: Request, res: Response) => {
      res.status(503).json({ error: "admin token not configured" });
    };
    app.get("/admin/api-keys/:keyHash", stub);
    app.post("/admin/api-keys/:keyHash/binding", stub);
    app.delete("/admin/api-keys/:keyHash/binding", stub);
    return;
  }

  const guard = adminGuard(adminToken);

  /* ------------------------------------------------------------------------
   * GET /admin/api-keys/:keyHash
   * Returns the row including bound_validator_aura. 404 if not found.
   * ---------------------------------------------------------------------- */
  app.get("/admin/api-keys/:keyHash", guard, (req: Request, res: Response) => {
    try {
      const keyHash = String(req.params.keyHash || "").toLowerCase();
      if (!KEY_HASH_REGEX.test(keyHash)) {
        res.status(400).json({ error: "invalid key hash (expected 64 hex chars)" });
        return;
      }
      const row = getApiKeyByHash(keyHash);
      if (!row) {
        res.status(404).json({ error: "api_keys row not found" });
        return;
      }
      // Mirror the on-disk shape but use camelCase + boolean for `enabled`
      // to match how KeyInfo is exposed elsewhere.
      res.status(200).json({
        keyHash: row.keyHash,
        name: row.name,
        enabled: row.enabled,
        maxReceiptsPerDay: row.maxReceiptsPerDay,
        maxBytesPerDay: row.maxBytesPerDay,
        maxConcurrentUploads: row.maxConcurrentUploads,
        validatorId: row.validatorId,
        boundValidatorAura: row.boundValidatorAura,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /* ------------------------------------------------------------------------
   * POST /admin/api-keys/:keyHash/binding   { validatorAura }
   * Sets bound_validator_aura. Validates SS58 shape via checkAddress(any).
   * Idempotent (re-setting the same value is a no-op for the explorer).
   * ---------------------------------------------------------------------- */
  app.post("/admin/api-keys/:keyHash/binding", guard, (req: Request, res: Response) => {
    try {
      const keyHash = String(req.params.keyHash || "").toLowerCase();
      if (!KEY_HASH_REGEX.test(keyHash)) {
        res.status(400).json({ error: "invalid key hash (expected 64 hex chars)" });
        return;
      }
      const body = (req.body ?? {}) as { validatorAura?: string };
      const validatorAura = body.validatorAura;
      if (!isValidSs58(validatorAura)) {
        res.status(400).json({ error: "missing or invalid validatorAura (expected SS58 address)" });
        return;
      }
      const updated = bindValidatorAura(keyHash, validatorAura);
      if (!updated) {
        res.status(404).json({ error: "api_keys row not found" });
        return;
      }
      // Audit log — never log secrets, but the binding itself is public info
      // (both SS58s are on-chain identities).
      console.log(
        `[blob-gateway] api-key binding set keyHash=${keyHash.slice(0, 16)}... aura=${validatorAura}`,
      );
      const row = getApiKeyByHash(keyHash);
      res.status(200).json({
        status: "bound",
        keyHash,
        boundValidatorAura: validatorAura,
        certDaemonSs58: row?.validatorId ?? null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /* ------------------------------------------------------------------------
   * DELETE /admin/api-keys/:keyHash/binding
   * Clears bound_validator_aura. Idempotent — succeeds on rows already NULL.
   * ---------------------------------------------------------------------- */
  app.delete("/admin/api-keys/:keyHash/binding", guard, (req: Request, res: Response) => {
    try {
      const keyHash = String(req.params.keyHash || "").toLowerCase();
      if (!KEY_HASH_REGEX.test(keyHash)) {
        res.status(400).json({ error: "invalid key hash (expected 64 hex chars)" });
        return;
      }
      const updated = clearValidatorAuraBinding(keyHash);
      if (!updated) {
        res.status(404).json({ error: "api_keys row not found" });
        return;
      }
      console.log(
        `[blob-gateway] api-key binding cleared keyHash=${keyHash.slice(0, 16)}...`,
      );
      res.status(200).json({ status: "cleared", keyHash });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });
}
