/**
 * Admin routes for the ATTESTATION-EVIDENCE ATTESTORS registry (Wave 3
 * Phase 2).
 *
 *   POST   /admin/attestation-evidence-attestors            -- register attestor
 *   DELETE /admin/attestation-evidence-attestors/:pubkey    -- revoke attestor
 *   GET    /admin/attestation-evidence-attestors            -- list (active+revoked)
 *
 * Same admin-token gating + 503-when-unconfigured pattern as
 * `routes/fleet_operators.ts` and `routes/observers.ts`. Functions
 * intentionally identical in shape so ops tooling can treat all three
 * registries uniformly.
 */

import type { Express, Request, Response } from "express";
import { config } from "../config.js";
import { adminGuard } from "../bearer-auth.js";
import {
  registerAttestationEvidenceAttestor,
  revokeAttestationEvidenceAttestor,
  getAttestationEvidenceAttestor,
  listAttestationEvidenceAttestors,
  type AttestationEvidenceAttestorRow,
} from "../attestation_evidence_attestors.js";

const HEX64_LOOSE = /^(0x)?[0-9a-fA-F]{64}$/;

export interface RegisterAttestationEvidenceAttestorRoutesOpts {
  /** Admin shared secret (falls back to config.daemonNotifyToken if empty). */
  adminToken?: string;
}

function rowToJson(row: AttestationEvidenceAttestorRow): Record<string, unknown> {
  return {
    id: row.id,
    pubkey_hex: row.pubkey_hex,
    label: row.label,
    registered_at: row.registered_at,
    revoked_at: row.revoked_at,
    notes: row.notes,
  };
}

export function registerAttestationEvidenceAttestorRoutes(
  app: Express,
  opts: RegisterAttestationEvidenceAttestorRoutesOpts = {},
): void {
  const adminToken = (opts.adminToken || config.daemonNotifyToken || "").trim();
  if (!adminToken) {
    app.post("/admin/attestation-evidence-attestors", (_req, res) => {
      res.status(503).json({ error: "admin token not configured" });
    });
    app.delete("/admin/attestation-evidence-attestors/:pubkey", (_req, res) => {
      res.status(503).json({ error: "admin token not configured" });
    });
    app.get("/admin/attestation-evidence-attestors", (_req, res) => {
      res.status(503).json({ error: "admin token not configured" });
    });
    return;
  }
  const guard = adminGuard(adminToken);

  app.post(
    "/admin/attestation-evidence-attestors",
    guard,
    (req: Request, res: Response) => {
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

        const existing = getAttestationEvidenceAttestor(body.pubkey);
        if (existing) {
          res.status(409).json({
            error: "attestor already registered",
            existing: rowToJson(existing),
          });
          return;
        }

        const row = registerAttestationEvidenceAttestor({
          pubkey: body.pubkey,
          label,
          notes,
        });

        console.log(
          `[blob-gateway] attestation-evidence-attestor registered pubkey_prefix=${row.pubkey_hex.slice(0, 16)} label=${label ?? "-"}`,
        );

        res.status(200).json({
          status: "created",
          attestor: rowToJson(row),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/UNIQUE/i.test(msg)) {
          res.status(409).json({ error: "attestor already registered" });
          return;
        }
        res.status(500).json({ error: msg });
      }
    },
  );

  app.delete(
    "/admin/attestation-evidence-attestors/:pubkey",
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
        const row = getAttestationEvidenceAttestor(pubkey);
        if (!row) {
          res.status(404).json({ error: "attestor not found" });
          return;
        }
        const ok = revokeAttestationEvidenceAttestor(pubkey);
        if (!ok) {
          res.status(200).json({
            status: "already-revoked",
            attestor: rowToJson(getAttestationEvidenceAttestor(pubkey)!),
          });
          return;
        }
        console.log(
          `[blob-gateway] attestation-evidence-attestor revoked pubkey_prefix=${row.pubkey_hex.slice(0, 16)}`,
        );
        res.status(200).json({
          status: "revoked",
          attestor: rowToJson(getAttestationEvidenceAttestor(pubkey)!),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
    },
  );

  app.get(
    "/admin/attestation-evidence-attestors",
    guard,
    (req: Request, res: Response) => {
      try {
        const active = req.query.active === "1" || req.query.active === "true";
        const rows = listAttestationEvidenceAttestors(
          active ? { active: true } : {},
        );
        res.status(200).json({ attestors: rows.map(rowToJson) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
    },
  );
}
