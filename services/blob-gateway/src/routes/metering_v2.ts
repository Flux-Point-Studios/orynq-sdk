/**
 * Validator + dispatcher for `compute_metering_v2` records inbound at
 * `POST /metering/submit`.
 *
 * Trust model recap:
 *   - Worker proves it ran the work by signing the canonical pre-image with
 *     `worker_pubkey`.
 *   - Fleet operator (a registered third party) attests to the worker's
 *     hardware capacity by signing the hardware_spec sub-object with
 *     `fleet_operator_pubkey`. This prevents a malicious worker from
 *     unilaterally inflating its capacity to over-bill.
 *   - Observer (optional, registered third party) co-signs the same pre-image
 *     as the worker. Adds an independent witness for high-trust workloads.
 *
 * 11 validation rules — fail-fast in this order:
 *
 *   (1) Schema shape + IDs + period + bound checks → delegated to
 *       `validateComputeMeteringV2(raw, { verify_signatures: false })`.
 *       Team 1's canonical validator emits structural codes:
 *         INVALID_JSON, MISSING_FIELD, WRONG_TYPE, WRONG_SCHEMA_VERSION,
 *         ID_FORMAT, PERIOD_INVALID, NEGATIVE_VALUE, BOUND_EXCEEDED,
 *         INT_OVERFLOW, HEX_FORMAT, GPU_TYPE_INVALID, GPU_COUNT_MISMATCH,
 *         HARDWARE_BOUND.
 *       `statusForStructuralCode` maps shape errors to 400 and bound
 *       violations (rules 4-7) to 422.
 *
 *   (8) `fleet_operator_pubkey` exists in `fleet_operators` table AND is not
 *       revoked. Status 403, code FLEET_OPERATOR_UNKNOWN.
 *
 *   (9) `fleet_operator_signature` is a valid sr25519 over the documented
 *       fleet-op pre-image. Status 401, code FLEET_OPERATOR_SIG_INVALID.
 *
 *  (10) `worker_signature` is a valid sr25519 over the documented worker
 *       pre-image (which itself includes the fleet-op signature, so worker
 *       attests to having seen the same hardware claim). Status 401, code
 *       WORKER_SIG_INVALID.
 *
 *  (11) When `observer` is present:
 *         (a) `observer_pubkey` exists AND is not revoked. Status 403, code
 *             OBSERVER_UNKNOWN.
 *         (b) `observer_signature` verifies against the SAME bytes as the
 *             worker pre-image. Status 401, code OBSERVER_SIG_INVALID.
 *
 *   Replay shortcut: same `worker_id` + `content_hash` resubmitted →
 *   200 status:replay. No double-notify of the sponsored-receipt-submitter.
 *
 *   Monotonic guard: incoming `period_start_ms` < last observed for this
 *   worker → 409 MONOTONIC_VIOLATION.
 *
 * --- Why we run the structural validator with verify_signatures:false ---
 *
 * Team 1's `validateComputeMeteringV2` will, by default, also verify all
 * sr25519 signatures and emit `FLEET_OP_SIGNATURE_INVALID` /
 * `WORKER_SIGNATURE_INVALID` / `OBSERVER_SIGNATURE_INVALID`. Those codes are
 * conceptually correct but they map awkwardly onto the route's HTTP-status
 * + audit-log contract (we want 401 for sig fails, with route-stable codes
 * `FLEET_OPERATOR_SIG_INVALID` / `WORKER_SIG_INVALID` / `OBSERVER_SIG_INVALID`,
 * AND we want to log a `metering_v2_auth_fail` line first).
 *
 * Asking the validator for structure-only output (verify_signatures:false)
 * lets the route own all auth concerns (registry membership + sig verify +
 * audit log) in one place, with one error contract, while still leaning on
 * Team 1's encoder + structural rules so the schema is byte-for-byte the
 * canonical implementation.
 *
 * --- HTTP status mapping ---
 *
 *   400 — schema shape / period / hex / gpu type / id format
 *   422 — bound violations (cpu/ram/gpu)
 *   403 — fleet operator or observer unknown / revoked (rules 8, 11.a)
 *   401 — fleet operator sig invalid (9), worker sig invalid (10),
 *         observer sig invalid (11.b)
 *   409 — monotonic regression on period_start_ms
 *   500 — unexpected internal error
 *
 *  Replay (already-seen content_hash) returns 200 status:replay, NOT 409 —
 *  retries by the worker SDK after a network blip should be idempotent.
 */

import type { Request, Response } from "express";
import { signatureVerify } from "@polkadot/util-crypto";
import { hexToU8a } from "@polkadot/util";
import { config } from "../config.js";
import {
  validateComputeMeteringV2,
  canonicalCborForFleetOpSig,
  canonicalCborForWorkerSig,
  SCHEMA_HASH_HEX,
  SCHEMA_VERSION,
  workerPubkeyToSs58,
  type ComputeMeteringV2,
  type ValidateErrorCode,
} from "../schemas/compute_metering_v2.js";
import { isFleetOperatorActive } from "../fleet_operators.js";
import { isObserverActive } from "../observers.js";
import {
  getLastPeriodStart,
  recordWorkerSubmission,
  recordMeteringSubmission,
  isReplayedContent,
} from "../worker_bounds.js";
import { notifySponsoredReceiptSubmitter } from "../sponsored-receipts.js";
import { saveManifest, updateReceiptMeta } from "../storage.js";

/** Source tag emitted to the sponsored-receipt-submitter for v2 records. */
export const METERING_V2_SOURCE = "compute-metering-v2" as const;

/**
 * Stable error codes the v2 route can emit. Includes the structural codes
 * passed through from Team 1's validator (when `verify_signatures:false`)
 * plus the route-owned auth/replay/monotonic codes.
 */
export type V2RouteErrorCode =
  | ValidateErrorCode
  | "FLEET_OPERATOR_UNKNOWN"
  | "FLEET_OPERATOR_SIG_INVALID"
  | "WORKER_SIG_INVALID"
  | "OBSERVER_UNKNOWN"
  | "OBSERVER_SIG_INVALID"
  | "INTERNAL";

interface V2RejectBody {
  ok: false;
  code: V2RouteErrorCode;
  message: string;
  field?: string;
}

function reject(
  res: Response,
  status: number,
  code: V2RouteErrorCode,
  message: string,
  field?: string,
): void {
  const body: V2RejectBody = field !== undefined
    ? { ok: false, code, message, field }
    : { ok: false, code, message };
  res.status(status).json(body);
}

/**
 * Audit-log a single auth-fail line. Format is space-separated key=value so
 * `| grep metering_v2_auth_fail` gives a clean stream.
 *
 * Per the task spec: never log full pubkeys, never log signatures.
 * The `pubkey_prefix` is the first 16 lowercase hex chars (8 bytes) — enough
 * for an operator to correlate against their roster, not enough to recover
 * the key.
 */
function logAuthFail(
  reason: string,
  pubkeyHexFull: string | undefined,
): void {
  const prefix = (pubkeyHexFull ?? "").slice(0, 16);
  console.warn(
    `[blob-gateway] event=metering_v2_auth_fail reason=${reason} pubkey_prefix=${prefix}`,
  );
}

/**
 * Verify a sr25519 signature with hex-encoded pubkey + signature against
 * pre-computed canonical bytes. Returns true on valid, false on any failure
 * (including malformed key/sig — caught here so the route never throws on a
 * tampered field).
 */
function verifySr25519(
  preimage: Uint8Array,
  pubkeyHex: string,
  sigHex: string,
): boolean {
  try {
    const pub = hexToU8a("0x" + pubkeyHex);
    const sig = hexToU8a("0x" + sigHex);
    const r = signatureVerify(preimage, sig, pub);
    return r.isValid;
  } catch {
    return false;
  }
}

/**
 * Map a structural-validator error code to its v2-route HTTP status.
 *
 * Shape / format / wrong-version errors → 400. Bound violations → 422.
 * Signature codes (`FLEET_OP_SIGNATURE_INVALID`, `WORKER_SIGNATURE_INVALID`,
 * `OBSERVER_SIGNATURE_INVALID`, `MONOTONIC_VIOLATION`) are NEVER emitted by
 * the validator on this route because we always pass `verify_signatures:
 * false`; they're enumerated here for completeness so the switch is total.
 */
function statusForStructuralCode(code: ValidateErrorCode): number {
  switch (code) {
    case "INVALID_JSON":
    case "MISSING_FIELD":
    case "WRONG_TYPE":
    case "WRONG_SCHEMA_VERSION":
    case "ID_FORMAT":
    case "PERIOD_INVALID":
    case "HEX_FORMAT":
    case "GPU_TYPE_INVALID":
      return 400;
    case "NEGATIVE_VALUE":
    case "BOUND_EXCEEDED":
    case "INT_OVERFLOW":
    case "GPU_COUNT_MISMATCH":
    case "HARDWARE_BOUND":
      return 422;
    case "FLEET_OP_SIGNATURE_INVALID":
    case "WORKER_SIGNATURE_INVALID":
    case "OBSERVER_SIGNATURE_INVALID":
      return 401;
    case "MONOTONIC_VIOLATION":
      return 409;
  }
}

/**
 * The v2 dispatcher. Called from `routes/metering.ts` when the inbound record
 * carries `schema_version: "compute_metering_v2"`. Splitting it into its own
 * module keeps the v1 path untouched.
 */
export async function handleV2Submit(
  _req: Request,
  res: Response,
  raw: unknown,
): Promise<void> {
  const nowMs = Date.now();

  // Rules 1-7 — structural validation (shape + period bounds + clock skew +
  // non-negativity + cpu/ram/gpu bound checks). We disable signature
  // verification here so the route can own auth-related error codes + audit
  // logging. Team 1's encoder is still called below for the canonical
  // pre-image bytes used in our sr25519 verifies.
  const sv = validateComputeMeteringV2(raw, { verify_signatures: false });
  if (!sv.ok) {
    reject(
      res,
      statusForStructuralCode(sv.code),
      sv.code,
      sv.message,
      sv.field,
    );
    return;
  }
  const { record, content_hash, schema_hash, worker_pre_image, fleet_op_pre_image } = sv;

  // Rule 8 — fleet operator must exist + not revoked.
  if (!isFleetOperatorActive(record.hardware_spec.fleet_operator_pubkey)) {
    logAuthFail("fleet_operator_unknown_or_revoked", record.hardware_spec.fleet_operator_pubkey);
    reject(
      res,
      403,
      "FLEET_OPERATOR_UNKNOWN",
      "fleet_operator_pubkey is not registered or has been revoked",
      "fleet_operator_pubkey",
    );
    return;
  }

  // Rule 9 — fleet_operator_signature valid sr25519. Pre-image bytes come
  // straight from Team 1's canonical encoder via the validator's return
  // value, so worker SDKs in any language can sign the same bytes.
  if (
    !verifySr25519(
      fleet_op_pre_image,
      record.hardware_spec.fleet_operator_pubkey,
      record.hardware_spec.fleet_operator_signature,
    )
  ) {
    logAuthFail("fleet_operator_sig_invalid", record.hardware_spec.fleet_operator_pubkey);
    reject(
      res,
      401,
      "FLEET_OPERATOR_SIG_INVALID",
      "fleet_operator_signature does not verify against fleet_operator_pubkey",
      "fleet_operator_signature",
    );
    return;
  }

  // Rule 10 — worker_signature valid sr25519 over the full pre-image
  // (including the fleet_operator_signature already verified above —
  // tampering with either fleet portion or worker portion breaks this).
  if (
    !verifySr25519(
      worker_pre_image,
      record.worker_pubkey,
      record.worker_signature,
    )
  ) {
    logAuthFail("worker_sig_invalid", record.worker_pubkey);
    reject(
      res,
      401,
      "WORKER_SIG_INVALID",
      "worker_signature does not verify against worker_pubkey",
      "worker_signature",
    );
    return;
  }

  // Rule 11 — observer (optional). When present, must be registered, not
  // revoked, and the signature must verify against the SAME pre-image as the
  // worker signature. Order matches rules 8/9 for consistency: registry
  // first, then sig.
  if (record.observer) {
    if (!isObserverActive(record.observer.observer_pubkey)) {
      logAuthFail("observer_unknown_or_revoked", record.observer.observer_pubkey);
      reject(
        res,
        403,
        "OBSERVER_UNKNOWN",
        "observer_pubkey is not registered or has been revoked",
        "observer_pubkey",
      );
      return;
    }
    if (
      !verifySr25519(
        worker_pre_image,
        record.observer.observer_pubkey,
        record.observer.observer_signature,
      )
    ) {
      logAuthFail("observer_sig_invalid", record.observer.observer_pubkey);
      reject(
        res,
        401,
        "OBSERVER_SIG_INVALID",
        "observer_signature does not verify against observer_pubkey",
        "observer_signature",
      );
      return;
    }
  }

  // Replay shortcut — same record submitted twice in a row → 200 status:replay.
  // We use the same per-worker single-slot dedup as v1 (cheap, off the chain
  // anti-replay). This catches an immediate retry of the SAME content_hash.
  // The chain is the canonical anti-replay; this is a friendly local guard.
  if (isReplayedContent(record.worker_id, content_hash)) {
    res.status(200).json({
      ok: true,
      status: "replay",
      content_hash,
      schema_hash,
      worker_id: record.worker_id,
    });
    return;
  }

  // Monotonic non-decreasing period_start_ms per worker_id (replay/rewind
  // guard). This is the same rule v1 enforces for `period_start`; we apply
  // it identically using the same backing store.
  const lastStart = getLastPeriodStart(record.worker_id);
  if (record.period_start_ms < lastStart) {
    reject(
      res,
      409,
      "MONOTONIC_VIOLATION",
      `period_start_ms ${record.period_start_ms} < last observed ${lastStart} for worker ${record.worker_id}`,
      "period_start_ms",
    );
    return;
  }

  // ---------- ACCEPTED — persist, update state, notify ----------

  const operatorSs58 = workerPubkeyToSs58(record.worker_pubkey);

  const manifest = {
    schema: SCHEMA_VERSION,
    record,
    chunks: [],
    rootHash: content_hash,
  };
  await saveManifest(content_hash, manifest);
  await updateReceiptMeta(content_hash, { uploaderAddress: operatorSs58 });

  recordWorkerSubmission(record.worker_id, record.period_start_ms, content_hash);

  recordMeteringSubmission({
    content_hash,
    tenant_id: record.tenant_id,
    worker_id: record.worker_id,
    period_start_ms: record.period_start_ms,
    period_end_ms: record.period_end_ms,
    cpu_seconds: record.metrics.cpu_seconds,
    ram_gb_hours: record.metrics.ram_gb_hours,
    disk_gb_hours: record.metrics.disk_gb_hours,
    net_bytes_in: record.metrics.net_bytes_in,
    net_bytes_out: record.metrics.net_bytes_out,
    gpu_seconds: record.metrics.gpu_seconds,
    submitted_at_ms: nowMs,
  });

  void notifySponsoredReceiptSubmitter({
    contentHash: content_hash,
    operator: operatorSs58,
    authTier: "bearer",
    schemaHash: schema_hash,
    source: METERING_V2_SOURCE,
  });

  res.status(200).json({
    ok: true,
    status: "accepted",
    content_hash,
    schema_hash,
    worker_id: record.worker_id,
    operator: operatorSs58,
    observer_present: Boolean(record.observer),
    sponsored_receipt_submitter_configured:
      Boolean(config.sponsoredReceiptSubmitterUrl),
  });
}

/**
 * Quick test export: shape of an accepted v2 response, useful for type-
 * narrowing in the TS test suite.
 */
export interface V2AcceptedBody {
  ok: true;
  status: "accepted" | "replay";
  content_hash: string;
  schema_hash: string;
  worker_id: string;
  operator?: string;
  observer_present?: boolean;
  sponsored_receipt_submitter_configured?: boolean;
}

/** Re-export of the v2 schema hash so route consumers don't need to import it themselves. */
export { SCHEMA_HASH_HEX as SCHEMA_HASH_HEX_V2 };

/** Re-export the V2 record type so test files can declare typed variables. */
export type { ComputeMeteringV2 };

// Expose the canonical encoders to test files that need to forge or
// re-derive pre-images for negative tests. Re-exporting from this module
// keeps the route as the single import surface for v2 callers.
export {
  canonicalCborForFleetOpSig,
  canonicalCborForWorkerSig,
};
