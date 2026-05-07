/**
 * Daemon-facing endpoints for the chain-submission half of TEE evidence
 * (task #143).
 *
 *   GET  /v2/attestation_evidence/pending?since=<rowid>&limit=<N>
 *   POST /v2/attestation_evidence/:row_id/mark_submitted
 *
 * Why this exists
 * ---------------
 * `POST /v2/attestation_evidence` (in `attestation_evidence.ts`) is the
 * INBOUND path used by attestors (Acurast phones, SEV-SNP boxes). It only
 * persists evidence to the gateway DB — it does NOT call the on-chain
 * `TeeAttestation.submit_evidence` extrinsic. Without that chain leg the
 * pallet's `CompositeTrustScores` storage stays at the default 0, the
 * `/billing/usage` route surfaces `composite_trust_score: 0` for every
 * record, and the Phase 2 Path C smoke harness's headline test 4 times out.
 *
 * The cert-daemon's `evidence_submitter` polls these two routes:
 *
 *   1. `GET …/pending` — returns rows the daemon hasn't yet submitted to
 *      chain. Pull-model with explicit cursor so the daemon recovers
 *      cleanly across restarts. Rows are stable-ordered by `id ASC`.
 *   2. `POST …/:row_id/mark_submitted` — daemon acks once the on-chain
 *      extrinsic has finalised, supplying the resulting extrinsic hash so
 *      forensic queries can later trace evidence-row → chain-tx without
 *      re-walking the chain history.
 *
 * Auth
 * ----
 * Both routes accept the same `SPONSORED_RECEIPT_SUBMITTER_TOKEN` Bearer
 * that's already shared with the receipt-submitter (and recognised by the
 * privileged GET `/blobs/:contentHash/manifest` path — see
 * `routes/blobs.ts` `isSponsoredReceiptSubmitterToken`). Rationale:
 *
 *   - The cert-daemon already holds that token (it's the same trust
 *     boundary as the receipt-submitter — same operator, same node).
 *   - Adding ANOTHER shared secret would just expand the leak surface.
 *   - Both endpoints are scoped to the chain-submission lifecycle ONLY:
 *     `pending` is read-only, `mark_submitted` mutates a single row's
 *     bookkeeping fields. Neither can be used to forge new evidence rows.
 *
 * If `config.sponsoredReceiptSubmitterToken` is empty the routes 503 to
 * mirror the existing admin-route safety net.
 *
 * HTTP status mapping
 * -------------------
 *   401 — auth missing/invalid
 *   400 — body shape (`row_id` not an integer, `chain_extrinsic_hash`
 *         not 32-byte hex)
 *   404 — `mark_submitted` against a row id that doesn't exist
 *   200 status:marked         — first-time ack
 *   200 status:already-marked — retry (idempotent)
 *
 * Tests in `__tests__/attestation_evidence_submission.test.ts`.
 */

import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "crypto";

import { config } from "../config.js";
import {
  listReceiptEvidencePendingChainSubmission,
  markReceiptEvidenceSubmittedToChain,
  type ReceiptEvidenceRow,
} from "../receipt_attestation_evidence.js";

export const attestationEvidenceSubmissionRouter = Router();

/**
 * Bearer-token guard sized for the cert-daemon's submitter role. Mirrors
 * `isSponsoredReceiptSubmitterToken` in `routes/blobs.ts` (same auth model,
 * same constant-time comparison). Defined locally rather than imported so
 * this file can move independently of the manifest GET path's evolution.
 */
function isAuthorizedSubmitter(req: Request): boolean {
  const expected = (config.sponsoredReceiptSubmitterToken ?? "").trim();
  if (expected.length === 0) return false;
  const header =
    (req.headers.authorization ||
      (req.headers as Record<string, unknown>)["Authorization"]) as
      | string
      | undefined;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = header.slice("Bearer ".length).trim();
  if (supplied.length === 0) return false;
  const expectedBuf = Buffer.from(expected, "utf8");
  const suppliedBuf = Buffer.from(supplied, "utf8");
  if (suppliedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(suppliedBuf, expectedBuf);
}

const HEX64_LOOSE = /^(0x)?[0-9a-fA-F]{64}$/;

/**
 * Marshal a row for the wire — payload_json is a TEXT column so the daemon
 * receives the original parsed payload (e.g. `{cert_chain_b64: [...]}`)
 * unchanged, exactly as the attestor POSTed it. We do NOT hand back the
 * signature_hex or attestor_pubkey_hex by mistake — those are only used by
 * the inbound POST verifier, the daemon doesn't need them, and surfacing
 * them on a GET would expand the secret-leak surface for a token that's
 * already shared.
 *
 * Wait, that's wrong: `attestor_pubkey_hex` IS useful for diagnostics +
 * possibly for forensic chain-side audit, AND it's not a secret (sr25519
 * pubkeys are public-by-construction). Surface them. Same goes for
 * signature_hex — the daemon stays out of the verify loop (the gateway
 * already verified on POST), but on-chain forensics may want to recover
 * the original signed bundle. Surface them too.
 */
function rowToPendingJson(row: ReceiptEvidenceRow): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = null;
  }
  return {
    id: row.id,
    receipt_id: row.receipt_id,
    evidence_type: row.evidence_type,
    nonce_hex: row.nonce_hex,
    payload,
    attestor_pubkey_hex: row.attestor_pubkey_hex,
    signature_hex: row.signature_hex,
    submitted_at_ms: row.submitted_at_ms,
  };
}

/**
 * GET /v2/attestation_evidence/pending
 *
 * Query params:
 *   since=<rowid>  (default 0)   — return rows with id > since
 *   limit=<N>      (default 100, max 1000)
 *
 * Response:
 *   { ok: true, rows: [...], next_since: <max id in this batch | since> }
 *
 * `next_since` is what the daemon should use as `since` on its NEXT call.
 * When `rows` is empty `next_since == since`.
 */
attestationEvidenceSubmissionRouter.get(
  "/v2/attestation_evidence/pending",
  (req: Request, res: Response): void => {
    if (!isAuthorizedSubmitter(req)) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    let since = 0;
    if (typeof req.query.since === "string" && req.query.since !== "") {
      const n = Number.parseInt(req.query.since, 10);
      if (!Number.isFinite(n) || n < 0) {
        res
          .status(400)
          .json({ ok: false, error: "since must be a non-negative integer" });
        return;
      }
      since = n;
    }
    let limit = 100;
    if (typeof req.query.limit === "string" && req.query.limit !== "") {
      const n = Number.parseInt(req.query.limit, 10);
      if (!Number.isFinite(n) || n <= 0) {
        res
          .status(400)
          .json({ ok: false, error: "limit must be a positive integer" });
        return;
      }
      limit = n;
    }
    const rows = listReceiptEvidencePendingChainSubmission({ since, limit });
    const nextSince = rows.length === 0 ? since : Math.max(...rows.map((r) => r.id));
    res.status(200).json({
      ok: true,
      rows: rows.map(rowToPendingJson),
      next_since: nextSince,
    });
  },
);

/**
 * POST /v2/attestation_evidence/:row_id/mark_submitted
 *
 * Body:
 *   { chain_extrinsic_hash: "<64 hex>" }      // 0x-prefix optional
 *
 * Response:
 *   { ok: true, status: "marked"|"already-marked", row: {...} }
 *   (404 when row id unknown.)
 *
 * Idempotency: a retry on a row already marked returns
 * status:already-marked + the previous chain_extrinsic_hash. The daemon
 * MUST treat that as success — racing acks happen during restart catch-up.
 */
attestationEvidenceSubmissionRouter.post(
  "/v2/attestation_evidence/:row_id/mark_submitted",
  (req: Request, res: Response): void => {
    if (!isAuthorizedSubmitter(req)) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    const idRaw = req.params.row_id;
    const rowId = Number.parseInt(idRaw, 10);
    if (!Number.isFinite(rowId) || rowId <= 0 || String(rowId) !== idRaw) {
      res
        .status(400)
        .json({ ok: false, error: "row_id must be a positive integer" });
      return;
    }
    const body = (req.body ?? {}) as { chain_extrinsic_hash?: unknown };
    const txRaw = body.chain_extrinsic_hash;
    if (typeof txRaw !== "string" || !HEX64_LOOSE.test(txRaw)) {
      res.status(400).json({
        ok: false,
        error:
          "chain_extrinsic_hash is required and must be 32 bytes hex (64 chars, optional 0x prefix)",
      });
      return;
    }
    const outcome = markReceiptEvidenceSubmittedToChain({
      row_id: rowId,
      chain_extrinsic_hash: txRaw,
    });
    if (outcome === null) {
      res.status(404).json({ ok: false, error: "row not found" });
      return;
    }
    res.status(200).json({
      ok: true,
      status: outcome.status,
      row: {
        id: outcome.row.id,
        receipt_id: outcome.row.receipt_id,
        evidence_type: outcome.row.evidence_type,
        submitted_to_chain_at: outcome.row.submitted_to_chain_at ?? null,
        chain_extrinsic_hash: outcome.row.chain_extrinsic_hash ?? null,
      },
    });
  },
);
