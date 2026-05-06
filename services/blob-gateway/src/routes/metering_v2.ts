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
 * 11 validation rules (enforced in this order, fail-fast on first):
 *
 *   (1) Schema validates structurally — delegate to validateComputeMeteringV2
 *   (2) period_end_ms - period_start_ms ≤ 86_400_000 (24 h)
 *   (3) period_end_ms ≤ now + 60_000 (clock-skew tolerance)
 *   (4) All metric values ≥ 0 (already enforced by structural validator —
 *       re-asserted here as belt-and-suspenders)
 *   (5) cpu_seconds ≤ cpu_cores × period_sec × 1.05
 *   (6) ram_gb_hours ≤ ram_gb × period_hr × 1.05
 *   (7) gpu_seconds = 0 if gpu_type=none OR gpu_count=0 (already enforced
 *       structurally; checked here to keep ALL bound logic in one place)
 *   (8) fleet_operator_pubkey exists in fleet_operators table AND not revoked
 *   (9) fleet_operator_signature valid sr25519 over its documented pre-image
 *  (10) worker_signature valid sr25519 over its documented pre-image
 *  (11) If observer present: observer_pubkey exists AND not revoked AND sig valid
 *
 * On accept:
 *   - persist receipt manifest under receipts/{contentHash}/manifest.json
 *   - update worker_state (last_period_start, last_content_hash)
 *   - append per-record billing snapshot to metering_submissions
 *   - fire-and-forget notify the sponsored-receipt-submitter with
 *     schema_hash = SCHEMA_HASH_HEX_V2 + source = "compute-metering-v2"
 *
 * HTTP status mapping (mirrors the v1 dispatcher's stable codes):
 *
 *   400 — schema malformed (rule 1) or period bounds violated (rules 2, 3)
 *   422 — metrics out of bounds (rules 4, 5, 6, 7)
 *   403 — fleet operator unknown or revoked (rule 8)
 *   401 — fleet operator sig invalid (9), worker sig invalid (10),
 *         observer sig invalid (11)
 *   409 — replay (same content_hash) OR monotonic regression on period_start_ms
 *   500 — unexpected internal error
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
  MAX_PERIOD_MS,
  FUTURE_SKEW_MS,
  JITTER_FACTOR,
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
import { workerPubkeyToSs58 } from "../schemas/compute_metering_v1.js";
import { notifySponsoredReceiptSubmitter } from "../sponsored-receipts.js";
import { saveManifest, updateReceiptMeta } from "../storage.js";

/** Source tag emitted to the sponsored-receipt-submitter for v2 records. */
export const METERING_V2_SOURCE = "compute-metering-v2" as const;

/**
 * Stable error codes for v2-specific failures (rules not covered by the
 * structural validator's own ValidateErrorCode union).
 */
export type V2RouteErrorCode =
  | ValidateErrorCode
  | "PERIOD_TOO_LONG"
  | "PERIOD_FUTURE_SKEW"
  | "CPU_OVER_HARDWARE"
  | "RAM_OVER_HARDWARE"
  | "FLEET_OPERATOR_UNKNOWN"
  | "FLEET_OPERATOR_REVOKED"
  | "FLEET_OPERATOR_SIG_INVALID"
  | "WORKER_SIG_INVALID"
  | "OBSERVER_UNKNOWN"
  | "OBSERVER_REVOKED"
  | "OBSERVER_SIG_INVALID"
  | "REPLAY_CONTENT_HASH"
  | "MONOTONIC_VIOLATION"
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
 * Note: the route layer's per-rule failures (PERIOD_TOO_LONG, etc.) are
 * handled inline in `handleV2Submit`; this mapping only covers the codes the
 * SCHEMA validator can emit.
 */
function statusForStructuralCode(code: ValidateErrorCode): number {
  switch (code) {
    case "INVALID_JSON":
    case "MISSING_FIELD":
    case "WRONG_TYPE":
    case "ID_FORMAT":
    case "PERIOD_INVALID":
    case "HEX_FORMAT":
    case "GPU_TYPE_INVALID":
      return 400;
    case "WRONG_SCHEMA_VERSION":
    case "NEGATIVE_VALUE":
    case "BOUND_EXCEEDED":
    case "INT_OVERFLOW":
    case "GPU_COUNT_MISMATCH":
      return 422;
    default:
      return 400;
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

  // Rule 1 — structural validation (also pulls workers / metrics / hardware
  // out of the raw input).
  const sv = validateComputeMeteringV2(raw);
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
  const { record, content_hash, schema_hash } = sv;

  // Rule 2 — period_end_ms - period_start_ms <= 86_400_000
  const periodMs = record.period_end_ms - record.period_start_ms;
  if (periodMs > MAX_PERIOD_MS) {
    reject(
      res,
      400,
      "PERIOD_TOO_LONG",
      `period (period_end_ms - period_start_ms) must be <= ${MAX_PERIOD_MS} ms (24 h), got ${periodMs}`,
      "period_end_ms",
    );
    return;
  }

  // Rule 3 — period_end_ms <= now + 60_000 (clock skew)
  if (record.period_end_ms > nowMs + FUTURE_SKEW_MS) {
    reject(
      res,
      400,
      "PERIOD_FUTURE_SKEW",
      `period_end_ms ${record.period_end_ms} exceeds now+${FUTURE_SKEW_MS}ms`,
      "period_end_ms",
    );
    return;
  }

  // Rule 4 — non-negative metrics. The structural validator already enforces
  // this, so this is a sanity-check assertion here. We KEEP this to satisfy
  // the spec's "rule 4" line and to fail closed if the structural validator
  // ever loosens.
  for (const [key, val] of Object.entries(record.metrics) as Array<[string, number]>) {
    if (val < 0) {
      reject(res, 422, "NEGATIVE_VALUE", `metric ${key} must be >= 0, got ${val}`, key);
      return;
    }
  }

  // Rules 5 + 6 — hardware-bound CPU / RAM caps with 5% tolerance.
  const periodSec = periodMs / 1000;
  const periodHr = periodMs / 3_600_000;
  const cpuCap = record.hardware_spec.cpu_cores * periodSec * JITTER_FACTOR;
  if (record.metrics.cpu_seconds > cpuCap) {
    reject(
      res,
      422,
      "CPU_OVER_HARDWARE",
      `cpu_seconds ${record.metrics.cpu_seconds} exceeds hardware cap ${cpuCap.toFixed(3)} (cpu_cores=${record.hardware_spec.cpu_cores}, period_sec=${periodSec}, tolerance=${JITTER_FACTOR})`,
      "cpu_seconds",
    );
    return;
  }
  const ramCap = record.hardware_spec.ram_gb * periodHr * JITTER_FACTOR;
  if (record.metrics.ram_gb_hours > ramCap) {
    reject(
      res,
      422,
      "RAM_OVER_HARDWARE",
      `ram_gb_hours ${record.metrics.ram_gb_hours} exceeds hardware cap ${ramCap.toFixed(3)} (ram_gb=${record.hardware_spec.ram_gb}, period_hr=${periodHr.toFixed(3)}, tolerance=${JITTER_FACTOR})`,
      "ram_gb_hours",
    );
    return;
  }

  // Rule 7 — GPU consistency. Structural validator already checks this.
  // Re-enforced inline so an audit reading just this file sees the rule.
  if (
    (record.hardware_spec.gpu_type === "none" ||
      record.hardware_spec.gpu_count === 0) &&
    record.metrics.gpu_seconds !== 0
  ) {
    reject(
      res,
      422,
      "GPU_COUNT_MISMATCH",
      `gpu_seconds must be 0 when gpu_type="none" or gpu_count=0`,
      "gpu_seconds",
    );
    return;
  }

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

  // Rule 9 — fleet_operator_signature valid sr25519.
  const fleetOpPreimage = canonicalCborForFleetOpSig(record.worker_id, record.hardware_spec);
  if (
    !verifySr25519(
      fleetOpPreimage,
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
  // (including the fleet_operator_signature already verified above).
  const workerPreimage = canonicalCborForWorkerSig(record);
  if (
    !verifySr25519(
      workerPreimage,
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
  // worker signature.
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
        workerPreimage,
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
  // anti-replay). Note: this only catches an immediate retry of the SAME
  // content_hash. A different record with monotonic-violating period_start
  // is caught below.
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

  // Replay against a DIFFERENT historical record with the same content_hash
  // is a 409 — distinct from the same-record retry above. (We can detect this
  // because content_hash matches but worker_state.last_content_hash doesn't,
  // which happens when the replayed record predates the most recent one.)
  // NOTE: The chain is the canonical anti-replay; this is a friendly local
  // guard, not the only line of defence. We do NOT have a full historical
  // content_hash store at the gateway — that lives in the chain. So we treat
  // the replay shortcut above as the only deterministic local replay guard
  // and rely on the chain to enforce uniqueness of content_hash.

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
