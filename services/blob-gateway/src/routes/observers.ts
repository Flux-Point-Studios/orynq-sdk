/**
 * Admin routes for the OBSERVERS registry (compute_metering_v2 optional
 * co-signers).
 *
 *   POST   /admin/observers            -- register a new observer
 *   DELETE /admin/observers/:pubkey    -- mark an observer revoked
 *   GET    /admin/observers            -- list all (active + revoked)
 *
 * Same admin-token gating + 503-when-unconfigured pattern as
 * `routes/fleet_operators.ts` and `routes/tokens.ts`.
 */

import type { Express, Request, Response } from "express";
import { config } from "../config.js";
import { adminGuard } from "../bearer-auth.js";
import {
  registerObserver,
  revokeObserver,
  getObserver,
  listObservers,
  type ObserverRow,
} from "../observers.js";

const HEX64_LOOSE = /^(0x)?[0-9a-fA-F]{64}$/;

export interface RegisterObserverRoutesOpts {
  /** Admin shared secret (falls back to config.daemonNotifyToken if empty). */
  adminToken?: string;
}

function rowToJson(row: ObserverRow): Record<string, unknown> {
  return {
    id: row.id,
    pubkey_hex: row.pubkey_hex,
    label: row.label,
    registered_at: row.registered_at,
    revoked_at: row.revoked_at,
    notes: row.notes,
  };
}

export function registerObserverRoutes(
  app: Express,
  opts: RegisterObserverRoutesOpts = {},
): void {
  const adminToken = (opts.adminToken || config.daemonNotifyToken || "").trim();
  if (!adminToken) {
    app.post("/admin/observers", (_req, res) => {
      res.status(503).json({ error: "admin token not configured" });
    });
    app.delete("/admin/observers/:pubkey", (_req, res) => {
      res.status(503).json({ error: "admin token not configured" });
    });
    app.get("/admin/observers", (_req, res) => {
      res.status(503).json({ error: "admin token not configured" });
    });
    return;
  }
  const guard = adminGuard(adminToken);

  app.post("/admin/observers", guard, (req: Request, res: Response) => {
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

      const existing = getObserver(body.pubkey);
      if (existing) {
        res.status(409).json({
          error: "observer already registered",
          existing: rowToJson(existing),
        });
        return;
      }

      const row = registerObserver({
        pubkey: body.pubkey,
        label,
        notes,
      });

      console.log(
        `[blob-gateway] observer registered pubkey_prefix=${row.pubkey_hex.slice(0, 16)} label=${label ?? "-"}`,
      );

      res.status(200).json({
        status: "created",
        observer: rowToJson(row),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE/i.test(msg)) {
        res.status(409).json({ error: "observer already registered" });
        return;
      }
      res.status(500).json({ error: msg });
    }
  });

  app.delete(
    "/admin/observers/:pubkey",
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
        const row = getObserver(pubkey);
        if (!row) {
          res.status(404).json({ error: "observer not found" });
          return;
        }
        const ok = revokeObserver(pubkey);
        if (!ok) {
          res.status(200).json({
            status: "already-revoked",
            observer: rowToJson(getObserver(pubkey)!),
          });
          return;
        }
        console.log(
          `[blob-gateway] observer revoked pubkey_prefix=${row.pubkey_hex.slice(0, 16)}`,
        );
        res.status(200).json({
          status: "revoked",
          observer: rowToJson(getObserver(pubkey)!),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
    },
  );

  app.get("/admin/observers", guard, (req: Request, res: Response) => {
    try {
      const active = req.query.active === "1" || req.query.active === "true";
      const rows = listObservers(active ? { active: true } : {});
      res.status(200).json({ observers: rows.map(rowToJson) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });
}
