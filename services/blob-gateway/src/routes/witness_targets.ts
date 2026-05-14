/**
 * HTTP surface for the Materios Witness Network probe-target registry.
 *
 *   GET    /witness/targets                  -- PUBLIC; APKs poll on each tick
 *   POST   /admin/witness/targets            -- admin-token; register a URL
 *   DELETE /admin/witness/targets/:idOrUrl   -- admin-token; revoke a URL
 *   GET    /admin/witness/targets            -- admin-token; list (incl. revoked)
 *
 * The public GET is the part that makes this product work — site owners
 * never touch the APK directly; they add their URL via the admin path
 * (or via a future dashboard form proxied through us), and all phones in
 * the fleet pick up the new target on their next 15-minute tick.
 */

import type { Express, Request, Response } from "express";
import { config } from "../config.js";
import { adminGuard } from "../bearer-auth.js";
import {
  registerWitnessTarget,
  revokeWitnessTarget,
  getWitnessTarget,
  listWitnessTargets,
  validateProbeUrl,
  type WitnessTargetRow,
} from "../witness_targets.js";

export interface RegisterWitnessTargetRoutesOpts {
  /** Admin shared secret (falls back to config.daemonNotifyToken if empty). */
  adminToken?: string;
}

function rowToJson(row: WitnessTargetRow): Record<string, unknown> {
  return {
    id: row.id,
    url: row.url,
    label: row.label,
    owner_token_id: row.owner_token_id,
    registered_at: row.registered_at,
    revoked_at: row.revoked_at,
    notes: row.notes,
  };
}

/**
 * Public-shape projection for the APK. Trim to just the fields phones
 * need to execute a probe — no internal IDs, no registration timestamps,
 * no owner info. Keeping this minimal future-proofs against accidentally
 * leaking owner→target mappings.
 */
function rowToPublic(row: WitnessTargetRow): Record<string, unknown> {
  return {
    url: row.url,
    label: row.label,
  };
}

export function registerWitnessTargetRoutes(
  app: Express,
  opts: RegisterWitnessTargetRoutesOpts = {},
): void {
  // PUBLIC route — always mounted, even when admin token is missing. The
  // APK fleet depends on this being reachable; gating it on admin-token
  // configuration would brick the whole network in misconfigured deploys.
  app.get("/witness/targets", (_req: Request, res: Response) => {
    try {
      const rows = listWitnessTargets({ active: true });
      res.status(200).json({
        targets: rows.map(rowToPublic),
        fetched_at: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  const adminToken = (opts.adminToken || config.daemonNotifyToken || "").trim();
  if (!adminToken) {
    app.post("/admin/witness/targets", (_req, res) => {
      res.status(503).json({ error: "admin token not configured" });
    });
    app.delete("/admin/witness/targets/:id", (_req, res) => {
      res.status(503).json({ error: "admin token not configured" });
    });
    app.get("/admin/witness/targets", (_req, res) => {
      res.status(503).json({ error: "admin token not configured" });
    });
    return;
  }
  const guard = adminGuard(adminToken);

  app.post(
    "/admin/witness/targets",
    guard,
    (req: Request, res: Response) => {
      try {
        const body = (req.body ?? {}) as {
          url?: unknown;
          label?: unknown;
          notes?: unknown;
        };
        if (typeof body.url !== "string") {
          res.status(400).json({
            error: "url is required (string http:// or https://)",
          });
          return;
        }
        let normalised: string;
        try {
          normalised = validateProbeUrl(body.url);
        } catch (err) {
          res.status(400).json({
            error: err instanceof Error ? err.message : String(err),
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

        const existing = getWitnessTarget(normalised);
        if (existing) {
          // Idempotent rerun for the same URL: return 409 with the
          // existing row so dashboard "Add" doesn't hard-error on a
          // duplicate retry.
          res.status(409).json({
            error: "target already registered",
            existing: rowToJson(existing),
          });
          return;
        }

        const row = registerWitnessTarget({
          url: normalised,
          label,
          notes,
        });

        console.log(
          `[blob-gateway] witness-target registered url=${row.url} label=${label ?? "-"}`,
        );

        res.status(200).json({
          status: "created",
          target: rowToJson(row),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/UNIQUE/i.test(msg)) {
          res.status(409).json({ error: "target already registered" });
          return;
        }
        res.status(500).json({ error: msg });
      }
    },
  );

  // DELETE by integer id only. URLs contain slashes, so they're awkward
  // as path params; the dashboard already has the id from the list view,
  // and tools like curl can fetch the id first. If a URL-keyed DELETE is
  // ever needed for ergonomic CLI use, add it as `?url=...` later.
  app.delete(
    "/admin/witness/targets/:id",
    guard,
    (req: Request, res: Response) => {
      try {
        const raw = String(req.params.id || "");
        const asInt = Number.parseInt(raw, 10);
        if (!Number.isFinite(asInt) || String(asInt) !== raw) {
          res.status(400).json({
            error: "id must be a positive integer",
          });
          return;
        }
        const all = listWitnessTargets({});
        const row = all.find((r) => r.id === asInt) ?? null;
        if (!row) {
          res.status(404).json({ error: "target not found" });
          return;
        }
        const ok = revokeWitnessTarget(row.url);
        if (!ok) {
          res.status(200).json({
            status: "already-revoked",
            target: rowToJson(getWitnessTarget(row.url)!),
          });
          return;
        }
        console.log(`[blob-gateway] witness-target revoked id=${row.id} url=${row.url}`);
        res.status(200).json({
          status: "revoked",
          target: rowToJson(getWitnessTarget(row.url)!),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
    },
  );

  app.get(
    "/admin/witness/targets",
    guard,
    (req: Request, res: Response) => {
      try {
        const active = req.query.active === "1" || req.query.active === "true";
        const rows = listWitnessTargets(active ? { active: true } : {});
        res.status(200).json({ targets: rows.map(rowToJson) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
    },
  );
}
