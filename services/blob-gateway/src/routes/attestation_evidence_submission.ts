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
 * Both routes consult `config.evidenceSubmitterToken`, which is read from
 * the `EVIDENCE_SUBMITTER_TOKEN` env var. If that env var is unset, the
 * config falls back to `SPONSORED_RECEIPT_SUBMITTER_TOKEN` so day-one
 * operators don't need to mint a second secret — the cert-daemon's
 * existing submitter Bearer keeps working. Operators who want to split
 * the privileged paths just set `EVIDENCE_SUBMITTER_TOKEN` to an
 * independent value. Rationale:
 *
 *   - The cert-daemon's evidence_submitter and receipt-submitter share a
 *     trust boundary today (same operator, same node), so a shared default
 *     is operationally simpler.
 *   - Splitting the secret is forward-compatible: the routes here only
 *     read `evidenceSubmitterToken`, so flipping the env var is a one-line
 *     change with no code redeploy.
 *   - Both endpoints are scoped to the chain-submission lifecycle ONLY:
 *     `pending` is read-only, `mark_submitted` mutates a single row's
 *     bookkeeping fields. Neither can be used to forge new evidence rows.
 *
 * If `config.evidenceSubmitterToken` is empty (i.e. NEITHER env var is
 * set) the routes return 401 for every request — the safe default when no
 * privileged token has been wired up. This is NOT a 503: the service is
 * up, the request is just not authorised.
 *
 * HTTP status mapping
 * -------------------
 *   401 — auth missing/invalid (or no token configured at all)
 *   400 — body shape (`row_id` not an integer, `chain_extrinsic_hash`
 *         not 32-byte hex), or `since` overflowing safe integer, or
 *         `limit` exceeding the page-size cap
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
 * Bearer-token guard sized for the cert-daemon's evidence_submitter role.
 * Mirrors `isSponsoredReceiptSubmitterToken` in `routes/blobs.ts` (same
 * auth model, same constant-time comparison). Defined locally rather than
 * imported so this file can move independently of the manifest GET path's
 * evolution.
 *
 * Reads `config.evidenceSubmitterToken` at request time — the config layer
 * handles the EVIDENCE_SUBMITTER_TOKEN → SPONSORED_RECEIPT_SUBMITTER_TOKEN
 * fallback. Empty token rejects every request (401).
 */
function isAuthorizedSubmitter(req: Request): boolean {
  const expected = (config.evidenceSubmitterToken ?? "").trim();
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
 * Maximum rows the daemon may request per /pending call. Matches the
 * billing route's page-size cap so operators don't have to learn a second
 * limit. Requests over this cap are REJECTED (400), NOT silently clamped
 * — silent clamping hides daemon bugs (e.g. a misconfigured cursor that
 * tries to drain the entire backlog in one call instead of paging).
 */
const MAX_PAGE_SIZE = 500;

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
 *   since=<rowid>  (default 0)   — return rows with id > since. Must fit
 *                                  in a JS safe integer (< 2^53).
 *   limit=<N>      (default 100, max MAX_PAGE_SIZE = 500)
 *                                  Over the cap returns 400 instead of
 *                                  silently clamping — see MAX_PAGE_SIZE.
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
      // Reject NaN, negatives, AND values that overflow the JS safe-int
      // range. `parseInt('999999999999999999999')` returns 1e21, which
      // passes `Number.isFinite` but not `Number.isSafeInteger` — so an
      // attacker (or a misencoded daemon) can't slip a giant cursor past
      // this guard and force the SQLite layer to truncate silently.
      if (
        !Number.isFinite(n) ||
        n < 0 ||
        n > Number.MAX_SAFE_INTEGER ||
        !Number.isSafeInteger(n)
      ) {
        res.status(400).json({
          ok: false,
          error: "since must be a non-negative safe integer",
        });
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
      // Loud rejection over the cap — silent clamping hides daemon bugs.
      if (n > MAX_PAGE_SIZE) {
        res.status(400).json({
          ok: false,
          error: `limit must not exceed ${MAX_PAGE_SIZE}`,
        });
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
