/**
 * Admin routes for the FLEET OPERATORS registry (compute_metering_v2).
 *
 *   POST   /admin/fleet-operators            -- register a new fleet operator
 *   DELETE /admin/fleet-operators/:pubkey    -- mark a fleet operator revoked
 *   GET    /admin/fleet-operators            -- list all (active + revoked)
 *
 * All endpoints require x-admin-token (same `DAEMON_NOTIFY_TOKEN` env var
 * used by `routes/tokens.ts`). When the env var is unset the routes mount
 * but return 503 — surfaces misconfiguration loudly instead of as a 404.
 */

import type { Express, Request, Response } from "express";
import { config } from "../config.js";
import { adminGuard } from "../bearer-auth.js";
import {
  registerFleetOperator,
  revokeFleetOperator,
  getFleetOperator,
  listFleetOperators,
  type FleetOperatorRow,
} from "../fleet_operators.js";

const HEX64_LOOSE = /^(0x)?[0-9a-fA-F]{64}$/;

export interface RegisterFleetOperatorRoutesOpts {
  /** Admin shared secret (falls back to config.daemonNotifyToken if empty). */
  adminToken?: string;
}

/**
 * Map a registered row to the JSON shape we expose. Renaming nothing — the
 * column names are the API surface; if we ever need a wire vs. column rename,
 * do it in one place here.
 */
function rowToJson(row: FleetOperatorRow): Record<string, unknown> {
  return {
    id: row.id,
    pubkey_hex: row.pubkey_hex,
    label: row.label,
    registered_at: row.registered_at,
    revoked_at: row.revoked_at,
    notes: row.notes,
  };
}

export function registerFleetOperatorRoutes(
  app: Express,
  opts: RegisterFleetOperatorRoutesOpts = {},
): void {
  const adminToken = (opts.adminToken || config.daemonNotifyToken || "").trim();
  if (!adminToken) {
    app.post("/admin/fleet-operators", (_req, res) => {
      res.status(503).json({ error: "admin token not configured" });
    });
    app.delete("/admin/fleet-operators/:pubkey", (_req, res) => {
      res.status(503).json({ error: "admin token not configured" });
    });
    app.get("/admin/fleet-operators", (_req, res) => {
      res.status(503).json({ error: "admin token not configured" });
    });
    return;
  }
  const guard = adminGuard(adminToken);

  app.post("/admin/fleet-operators", guard, (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        pubkey?: unknown;
        label?: unknown;
        notes?: unknown;
      };
      if (typeof body.pubkey !== "string" || !HEX64_LOOSE.test(body.pubkey)) {
        res.status(400).json({
          error: "pubkey is required and must be 32 bytes hex (64 chars, optional 0x prefix)",
        });
        return;
      }
      const label =
        typeof body.label === "string" && body.label.trim()
          ? body.label.trim()
          : null;
      const notes =
        typeof body.notes === "string" && body.notes.trim()
          ? body.notes.trim()
          : null;

      // Pre-check duplicate so we can 409 cleanly instead of bubbling up the
      // raw SQLite UNIQUE-constraint error string.
      const existing = getFleetOperator(body.pubkey);
      if (existing) {
        res.status(409).json({
          error: "fleet operator already registered",
          existing: rowToJson(existing),
        });
        return;
      }

      const row = registerFleetOperator({
        pubkey: body.pubkey,
        label,
        notes,
      });

      console.log(
        `[blob-gateway] fleet-operator registered pubkey_prefix=${row.pubkey_hex.slice(0, 16)} label=${label ?? "-"}`,
      );

      res.status(200).json({
        status: "created",
        operator: rowToJson(row),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Defensive: if pre-check missed a race and the UNIQUE constraint
      // fires anyway, surface as 409 not 500.
      if (/UNIQUE/i.test(msg)) {
        res.status(409).json({ error: "fleet operator already registered" });
        return;
      }
      res.status(500).json({ error: msg });
    }
  });

  app.delete(
    "/admin/fleet-operators/:pubkey",
    guard,
    (req: Request, res: Response) => {
      try {
        const pubkey = String(req.params.pubkey || "");
        if (!HEX64_LOOSE.test(pubkey)) {
          res.status(400).json({
            error: "invalid pubkey (expected 64 hex chars, optional 0x prefix)",
          });
          return;
        }
        // Pre-check existence so we can return 404 vs. 200/idempotent.
        const row = getFleetOperator(pubkey);
        if (!row) {
          res.status(404).json({ error: "fleet operator not found" });
          return;
        }
        const ok = revokeFleetOperator(pubkey);
        if (!ok) {
          // Already revoked — idempotent path.
          res.status(200).json({
            status: "already-revoked",
            operator: rowToJson(getFleetOperator(pubkey)!),
          });
          return;
        }
        console.log(
          `[blob-gateway] fleet-operator revoked pubkey_prefix=${row.pubkey_hex.slice(0, 16)}`,
        );
        res.status(200).json({
          status: "revoked",
          operator: rowToJson(getFleetOperator(pubkey)!),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
    },
  );

  app.get("/admin/fleet-operators", guard, (req: Request, res: Response) => {
    try {
      const active = req.query.active === "1" || req.query.active === "true";
      const rows = listFleetOperators(active ? { active: true } : {});
      res.status(200).json({ operators: rows.map(rowToJson) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });
}
