/**
 * `POST /metering/submit` — accept and validate a `compute_metering_v1`
 * record from a compute worker.
 *
 * Pipeline:
 *   1. Parse JSON body; reject 400 on malformed input.
 *   2. Validate against the schema (shape, bounds, sig, time, monotonic).
 *   3. Persist receipt manifest at the canonical `receipts/{contentHash}` path
 *      so the existing cleanup/index machinery picks it up.
 *   4. Update worker_state (last_period_start, last_content_hash).
 *   5. Fire-and-forget `notifySponsoredReceiptSubmitter()` with
 *      `schemaHash = SCHEMA_HASH_HEX` and `source = "compute-metering-v1"`.
 *      The submitter is the only party with the operator signing keys; it
 *      produces the on-chain `submit_receipt_v2` extrinsic.
 *
 * Auth model:
 *   The `worker_signature` field IS the auth — sr25519 over the canonical
 *   body. We do NOT also require Bearer/x-api-key on the HTTP request because
 *   the workers run in customer environments without operator credentials.
 *   That's fine: a forged record cannot pass `signatureVerify()` against the
 *   declared `worker_pubkey`, and the SS58 we derive from the pubkey is what
 *   the upstream receipt is attributed to. Replay is bounded by:
 *     - monotonic `period_start` (per-worker_id, persisted in worker_state)
 *     - `content_hash` uniqueness on chain (chain-side anti-replay)
 *     - same-content shortcut at the gateway (`isReplayedContent()`)
 *
 * Idempotency:
 *   A retry of the EXACT same record (same canonical_body → same
 *   content_hash) returns 200 without re-firing the submitter. A retry with
 *   ANY differing field (e.g. cpu_seconds bumped) is a different record and
 *   passes through, but the monotonic check still allows it as long as
 *   period_start is non-decreasing.
 */

import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import {
  validateComputeMeteringV1,
  workerPubkeyToSs58,
  SCHEMA_VERSION,
} from "../schemas/compute_metering_v1.js";
import { SCHEMA_VERSION as SCHEMA_VERSION_V2 } from "../schemas/compute_metering_v2.js";
import {
  getWorkerBounds,
  getLastPeriodStart,
  recordWorkerSubmission,
  recordMeteringSubmission,
  isReplayedContent,
} from "../worker_bounds.js";
import { notifySponsoredReceiptSubmitter } from "../sponsored-receipts.js";
import { saveManifest, updateReceiptMeta } from "../storage.js";
import { handleV2Submit } from "./metering_v2.js";

export const meteringRouter = Router();

/**
 * Source tag used in the outbound sponsored-receipt-submitter payload.
 * Stable string — exposed here so the submitter side can pin a constant.
 */
export const METERING_SOURCE = "compute-metering-v1" as const;

/**
 * Map a validator error code to an HTTP status code.
 *
 *   400 — input is malformed in a way the worker should fix client-side.
 *   401 — signature didn't verify (the only "auth" failure on this route).
 *   409 — monotonic violation (period_start would rewind history).
 *   422 — input is well-formed JSON but violates a constraint
 *         (over-bound, schema-version mismatch).
 */
function statusForCode(code: string): number {
  switch (code) {
    case "INVALID_JSON":
    case "MISSING_FIELD":
    case "WRONG_TYPE":
    case "ID_FORMAT":
    case "PERIOD_INVALID":
    case "NEGATIVE_VALUE":
    case "INT_OVERFLOW":
    case "HEX_FORMAT":
      return 400;
    case "WRONG_SCHEMA_VERSION":
    case "BOUND_EXCEEDED":
      return 422;
    case "SIGNATURE_INVALID":
      return 401;
    case "MONOTONIC_VIOLATION":
      return 409;
    default:
      return 400;
  }
}

meteringRouter.post(
  "/metering/submit",
  async (req: Request, res: Response) => {
    try {
      const raw = req.body;
      if (raw === undefined || raw === null) {
        res.status(400).json({
          ok: false,
          code: "INVALID_JSON",
          message: "request body must be a JSON object",
        });
        return;
      }

      // Schema-version dispatch. We MUST keep the v1 path byte-for-byte
      // identical to its pre-v2 behaviour — the v1 worker SDK is in
      // production. Any record without a recognised schema_version flows
      // through the v1 validator which will then reject it with the same
      // WRONG_SCHEMA_VERSION code as before.
      const schemaVersion =
        typeof raw === "object" && raw !== null && "schema_version" in raw
          ? (raw as { schema_version: unknown }).schema_version
          : undefined;
      if (schemaVersion === SCHEMA_VERSION_V2) {
        await handleV2Submit(req, res, raw);
        return;
      }

      // Look up workerId BEFORE full validation so we can pin per-worker
      // bounds and last_period_start. We DEFENSIVELY guard against the case
      // where worker_id is itself malformed — fall back to the same defaults
      // as `getWorkerBounds()` (DEFAULT_BOUNDS) and let the validator emit
      // the proper ID_FORMAT error.
      const workerIdGuess =
        typeof raw === "object" && raw !== null && "worker_id" in raw
          ? (raw as { worker_id: unknown }).worker_id
          : undefined;
      const workerIdStr =
        typeof workerIdGuess === "string" ? workerIdGuess : "";

      const bounds = workerIdStr ? getWorkerBounds(workerIdStr) : undefined;
      const lastPeriodStart = workerIdStr
        ? getLastPeriodStart(workerIdStr)
        : 0;

      const result = validateComputeMeteringV1(raw, {
        bounds,
        last_period_start: lastPeriodStart,
        // Use real wall-clock time. Tests inject `now_ms` directly via the
        // pure validator unit tests; this route uses live time, so any record
        // with `period_end > now+60s` is rejected.
      });
      if (!result.ok) {
        res
          .status(statusForCode(result.code))
          .json({
            ok: false,
            code: result.code,
            message: result.message,
            ...(result.field ? { field: result.field } : {}),
          });
        return;
      }

      const { record, content_hash, schema_hash } = result;

      // Replay short-circuit: if this is the EXACT same content the worker
      // last submitted, return 200 without re-firing the submitter. This is
      // a friendly retry path — the canonical anti-replay is on-chain
      // (content_hash uniqueness in pallet-orinq-receipts).
      const replayed = isReplayedContent(record.worker_id, content_hash);
      if (replayed) {
        res.status(200).json({
          ok: true,
          status: "replay",
          content_hash,
          schema_hash,
          worker_id: record.worker_id,
        });
        return;
      }

      // Derive the operator SS58 from the worker pubkey. The upstream
      // sponsored-receipt-submitter uses this as the receipt's `operator`.
      const operatorSs58 = workerPubkeyToSs58(record.worker_pubkey);

      // Persist a "manifest" so the existing cleanup/TTL/index machinery
      // sees this receipt the same way it sees blob receipts. The manifest
      // body is the validated record + a synthetic `chunks: []` (no blob
      // data — the receipt itself IS the data here). We tag it with the
      // schema marker so a future operator inspecting receipts/{hash}/manifest.json
      // can tell at a glance what kind of payload it is.
      const manifest = {
        schema: SCHEMA_VERSION,
        record,
        chunks: [],
        rootHash: content_hash,
      };
      await saveManifest(content_hash, manifest);
      await updateReceiptMeta(content_hash, { uploaderAddress: operatorSs58 });

      // Mark this submission in worker_state. Order matters: do this BEFORE
      // firing notify so a same-second retry hits the replay shortcut.
      recordWorkerSubmission(record.worker_id, record.period_start, content_hash);

      // Append the per-record billing snapshot used by GET /billing/usage
      // (#112). INSERT OR IGNORE absorbs any duplicate content_hash race —
      // the replay shortcut above is the primary defense, this is a backstop.
      recordMeteringSubmission({
        content_hash,
        tenant_id: record.tenant_id,
        worker_id: record.worker_id,
        period_start_ms: record.period_start,
        period_end_ms: record.period_end,
        cpu_seconds: record.cpu_seconds,
        ram_gb_hours: record.ram_gb_hours,
        disk_gb_hours: record.disk_gb_hours,
        net_bytes_in: record.net_bytes_in,
        net_bytes_out: record.net_bytes_out,
        gpu_seconds: record.gpu_seconds,
        submitted_at_ms: Date.now(),
      });

      // Fire-and-forget upstream notification. Schema_hash is set so the
      // submitter can pass it through to `submit_receipt_v2(schema_hash=...)`.
      // `authTier: "bearer"` is a placeholder in the existing submitter
      // contract — the real attribution comes from `operator + schemaHash`.
      void notifySponsoredReceiptSubmitter({
        contentHash: content_hash,
        operator: operatorSs58,
        authTier: "bearer",
        schemaHash: schema_hash,
        source: METERING_SOURCE,
        // No rootHash/manifestHash — those are blob-flow concepts. Worker
        // SDK can compute the manifest hash itself if the submitter ever
        // needs it; for now we omit.
      });

      res.status(200).json({
        ok: true,
        status: "accepted",
        content_hash,
        schema_hash,
        worker_id: record.worker_id,
        operator: operatorSs58,
        sponsored_receipt_submitter_configured:
          Boolean(config.sponsoredReceiptSubmitterUrl),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[blob-gateway] /metering/submit unexpected error: ${msg}`);
      res.status(500).json({
        ok: false,
        code: "INTERNAL",
        message: "internal error",
      });
    }
  },
);
