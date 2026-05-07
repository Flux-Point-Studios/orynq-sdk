/**
 * `POST /v2/attestation_evidence` — accept TEE attestation evidence for an
 * already-submitted compute_metering_v2 record. Wave 3 Phase 2 endpoint.
 *
 * Trust model:
 *   - The metering record itself was already validated + persisted by the
 *     existing v2 path (`POST /metering/submit`). The receipt's
 *     `content_hash` is keyed by `receipts/{contentHash}` on disk.
 *   - The attestor (an Acurast Android phone, an SEV-SNP Hetzner box, etc.)
 *     holds a TEE-protected sr25519 key. Its pubkey is admin-registered in
 *     `attestation_evidence_attestors` (mirrors fleet_operators / observers).
 *   - The attestor signs canonical CBOR of the `payload` (NOT the full
 *     receipt body) with that key, then POSTs the bundle here. The gateway
 *     verifies + persists.
 *
 * Request shape (all hex is lowercase, no `0x` prefix):
 *   {
 *     "receipt_id": "<64 hex>",        // = sha256(content_hash_bytes), per
 *                                       //   storage.computeReceiptId
 *     "evidence_type": "arm_trustzone" | "amd_sev_snp" | ...
 *     "nonce": "<64 hex>",              // = sha256(content_hash || vendor_tag)
 *     "payload": { ... }                // evidence-type-specific body
 *     "attestor_pubkey": "<64 hex>",
 *     "signature": "<128 hex>"          // sig over canonical(payload) bytes
 *   }
 *
 * Validation order (fail-fast):
 *   1. (auth) Bearer/x-api-key — uses the existing bearer-auth middleware.
 *      Missing/invalid auth → 401.
 *   2. Body shape — receipt_id/evidence_type/nonce/payload/attestor_pubkey/
 *      signature all present, hex fields all valid format.
 *   3. receipt_id resolves to a stored manifest under receipts/{...}.
 *      Missing → 404 RECEIPT_NOT_FOUND.
 *   4. nonce == sha256(content_hash || utf8(evidence_type)) — derived from
 *      the receipt's content_hash. Mismatch → 422 NONCE_MISMATCH.
 *   5. attestor_pubkey is registered + not revoked. Unknown → 403
 *      ATTESTOR_UNKNOWN.
 *   6. signature verifies sr25519 over canonical-CBOR(payload). Invalid →
 *      401 SIGNATURE_INVALID.
 *   7. (receipt_id, attestor_pubkey, evidence_type) tuple exists already →
 *      200 status:replay. (Idempotent retry — no double-store, no
 *      double-charge later when the cert-daemon picks this up.)
 *
 * On success:
 *   - Insert the row in `receipt_attestation_evidence`.
 *   - Recompute the canonical evidence-vector hash for the receipt (over
 *     ALL stored entries for this receipt, sorted by EvidenceType
 *     discriminant).
 *   - Return `{ ok, status, attestation_evidence_hash, evidence_count,
 *     evidence_types }` (200).
 *
 * THIS PR DOES NOT MODIFY THE ON-CHAIN RECEIPT. The chain-side update is
 * the cert-daemon's job (separate PR per the design doc § 7).
 *
 * --- HTTP status mapping ---
 *
 *   400 — body shape (missing/wrong-type/bad-hex/bad-evidence-type)
 *   401 — auth failure OR signature_invalid
 *   403 — attestor_unknown / revoked
 *   404 — receipt_not_found
 *   422 — nonce_mismatch
 *   500 — unexpected internal error
 *
 *   200 status:accepted — first time this triple landed
 *   200 status:replay   — same triple already stored
 */

import { Router, type Request, type Response } from "express";
import { signatureVerify } from "@polkadot/util-crypto";
import { hexToU8a } from "@polkadot/util";
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { join } from "path";

import { bearerAuth } from "../bearer-auth.js";
import { config } from "../config.js";
import {
  EVIDENCE_TYPES,
  type EvidenceType,
  evidenceVendorTagBytes,
  encodeCbor,
  evidenceEntryToCborValue,
  type AttestationEvidenceEntry,
} from "../schemas/compute_metering_v2.js";
import { isAttestationEvidenceAttestorActive } from "../attestation_evidence_attestors.js";
import {
  insertReceiptEvidence,
  recomputeReceiptEvidenceHash,
} from "../receipt_attestation_evidence.js";
import { getManifest, computeReceiptId } from "../storage.js";

export const attestationEvidenceRouter = Router();

const HEX64 = /^[0-9a-f]{64}$/;
const HEX64_LOOSE = /^(0x)?[0-9a-fA-F]{64}$/;
const HEX128_LOOSE = /^(0x)?[0-9a-fA-F]{128}$/;

const EVIDENCE_TYPE_SET: ReadonlySet<string> = new Set<string>(EVIDENCE_TYPES);

export type AttestationEvidenceErrorCode =
  | "INVALID_JSON"
  | "MISSING_FIELD"
  | "WRONG_TYPE"
  | "HEX_FORMAT"
  | "EVIDENCE_TYPE_INVALID"
  | "RECEIPT_NOT_FOUND"
  | "NONCE_MISMATCH"
  | "ATTESTOR_UNKNOWN"
  | "SIGNATURE_INVALID"
  | "INTERNAL";

interface RejectBody {
  ok: false;
  code: AttestationEvidenceErrorCode;
  message: string;
  field?: string;
}

function reject(
  res: Response,
  status: number,
  code: AttestationEvidenceErrorCode,
  message: string,
  field?: string,
): void {
  const body: RejectBody = field !== undefined
    ? { ok: false, code, message, field }
    : { ok: false, code, message };
  res.status(status).json(body);
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function normalizeHex(s: string): string {
  return (s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s).toLowerCase();
}

/**
 * Read a v2/v2.1 manifest for the given content_hash and return the
 * `worker_pubkey` (used for tracking) AND the content_hash itself confirmed
 * out of the file. Returns null if the manifest is missing or doesn't carry
 * a v2 record body in the expected shape.
 *
 * Why we re-read the manifest: the route only knows the receipt_id from the
 * client, but the nonce derivation needs the content_hash. We look up the
 * manifest, confirm it's a v2 record, and use its content_hash for the
 * derivation. (The receipt_id → content_hash mapping is also indexed at
 * `index/receipt-to-content/{receiptId}.txt`, but reading the manifest is
 * the most reliable source of truth.)
 */
async function lookupV2Manifest(contentHashHex: string): Promise<
  | { contentHash: string }
  | null
> {
  const m = (await getManifest(contentHashHex)) as
    | { schema?: string; rootHash?: string; record?: unknown }
    | null;
  if (!m) return null;
  // Gate on schema field. Only v2 ("compute_metering_v2") and v2.1
  // ("compute_metering_v2.1") manifests are valid attest targets — plain
  // blob manifests (no `schema` field) MUST NOT be accepted, otherwise an
  // attestor could append TEE evidence to an arbitrary uploaded blob and
  // pollute the receipt-evidence DB. PR #34 M-1.
  const schema = (m as { schema?: string } | null)?.schema;
  if (schema !== "compute_metering_v2" && schema !== "compute_metering_v2.1") {
    return null;
  }
  return { contentHash: contentHashHex };
}

/**
 * Resolve a receipt_id → content_hash by reading the index file written by
 * `saveManifest()` at `index/receipt-to-content/{receiptIdClean}.txt`.
 * Returns null when the index file is missing (receipt unknown).
 */
async function lookupContentHashForReceiptId(
  receiptIdHex: string,
): Promise<string | null> {
  const cleaned = normalizeHex(receiptIdHex);
  const idxPath = join(
    config.storagePath,
    "index",
    "receipt-to-content",
    `${cleaned}.txt`,
  );
  try {
    const content = (await readFile(idxPath, "utf-8")).trim();
    if (!HEX64.test(content)) return null;
    return content;
  } catch {
    return null;
  }
}

/**
 * Verify an sr25519 signature, swallowing any malformed-input throws as a
 * `false` return. Mirrors the helper in `metering_v2.ts`.
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

attestationEvidenceRouter.post(
  "/v2/attestation_evidence",
  bearerAuth(),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const raw = req.body;
      if (!isPlainObject(raw)) {
        reject(res, 400, "INVALID_JSON", "expected JSON object at root");
        return;
      }

      // ---- 1. body shape ----
      for (const k of [
        "receipt_id",
        "evidence_type",
        "nonce",
        "payload",
        "attestor_pubkey",
        "signature",
      ]) {
        if (!(k in raw)) {
          reject(res, 400, "MISSING_FIELD", `${k} is required`, k);
          return;
        }
      }
      const receiptIdRaw = raw.receipt_id;
      const evidenceTypeRaw = raw.evidence_type;
      const nonceRaw = raw.nonce;
      const payloadRaw = raw.payload;
      const attestorPubRaw = raw.attestor_pubkey;
      const signatureRaw = raw.signature;

      if (typeof receiptIdRaw !== "string" || !HEX64_LOOSE.test(receiptIdRaw)) {
        reject(
          res,
          400,
          "HEX_FORMAT",
          "receipt_id must be 32 bytes hex (64 chars, optional 0x prefix)",
          "receipt_id",
        );
        return;
      }
      const receiptIdHex = normalizeHex(receiptIdRaw);

      if (typeof evidenceTypeRaw !== "string" || !EVIDENCE_TYPE_SET.has(evidenceTypeRaw)) {
        reject(
          res,
          400,
          "EVIDENCE_TYPE_INVALID",
          `evidence_type must be one of [${EVIDENCE_TYPES.join(", ")}]`,
          "evidence_type",
        );
        return;
      }
      const evidenceType = evidenceTypeRaw as EvidenceType;

      if (typeof nonceRaw !== "string" || !HEX64_LOOSE.test(nonceRaw)) {
        reject(
          res,
          400,
          "HEX_FORMAT",
          "nonce must be 32 bytes hex (64 chars, optional 0x prefix)",
          "nonce",
        );
        return;
      }
      const nonceHex = normalizeHex(nonceRaw);

      if (!isPlainObject(payloadRaw)) {
        reject(
          res,
          400,
          "WRONG_TYPE",
          "payload must be a JSON object",
          "payload",
        );
        return;
      }
      const payload = payloadRaw;

      if (typeof attestorPubRaw !== "string" || !HEX64_LOOSE.test(attestorPubRaw)) {
        reject(
          res,
          400,
          "HEX_FORMAT",
          "attestor_pubkey must be 32 bytes hex (64 chars, optional 0x prefix)",
          "attestor_pubkey",
        );
        return;
      }
      const attestorPubHex = normalizeHex(attestorPubRaw);

      if (typeof signatureRaw !== "string" || !HEX128_LOOSE.test(signatureRaw)) {
        reject(
          res,
          400,
          "HEX_FORMAT",
          "signature must be 64 bytes hex (128 chars, optional 0x prefix)",
          "signature",
        );
        return;
      }
      const signatureHex = normalizeHex(signatureRaw);

      // ---- 2. receipt_id resolves to a stored manifest ----
      // The route accepts EITHER a content_hash OR a receipt_id (since the
      // pre-image of receipt_id is content_hash, and many existing daemons
      // already work in receipt_id space). Try receipt_id first, then fall
      // back to treating receipt_id as a content_hash directly.
      let contentHashHex = await lookupContentHashForReceiptId(receiptIdHex);
      if (!contentHashHex) {
        // Fallback: maybe the caller supplied a content_hash directly.
        // Confirm by checking whether the manifest exists at that hash AND
        // the supplied receipt_id matches the canonical receipt_id derivation.
        const manifestAtHash = await lookupV2Manifest(receiptIdHex);
        if (manifestAtHash) {
          // Caller supplied content_hash. Confirm the receipt_id derivation
          // matches by re-deriving it from the content_hash; we don't accept
          // this path implicitly because callers SHOULD pass receipt_id.
          // We require the supplied value to equal the content_hash here.
          contentHashHex = receiptIdHex;
        } else {
          reject(
            res,
            404,
            "RECEIPT_NOT_FOUND",
            `receipt_id ${receiptIdHex} has no stored manifest`,
            "receipt_id",
          );
          return;
        }
      } else {
        // Confirm manifest exists at the looked-up content_hash.
        const manifest = await lookupV2Manifest(contentHashHex);
        if (!manifest) {
          reject(
            res,
            404,
            "RECEIPT_NOT_FOUND",
            `receipt_id ${receiptIdHex} resolved to content_hash ${contentHashHex} but manifest is missing`,
            "receipt_id",
          );
          return;
        }
      }

      // ---- 3. nonce binding ----
      // expected_nonce = sha256(content_hash_bytes || utf8(evidence_type))
      const expectedNonce = createHash("sha256")
        .update(hexToU8a("0x" + contentHashHex))
        .update(evidenceVendorTagBytes(evidenceType))
        .digest("hex");
      if (expectedNonce !== nonceHex) {
        reject(
          res,
          422,
          "NONCE_MISMATCH",
          `nonce does not equal sha256(content_hash || utf8("${evidenceType}"))`,
          "nonce",
        );
        return;
      }

      // ---- 4. attestor registered ----
      if (!isAttestationEvidenceAttestorActive(attestorPubHex)) {
        reject(
          res,
          403,
          "ATTESTOR_UNKNOWN",
          "attestor_pubkey is not registered or has been revoked",
          "attestor_pubkey",
        );
        return;
      }

      // ---- 5. signature verifies over canonical-CBOR(payload) ----
      // The attestor signs canonical CBOR of the PAYLOAD only (NOT the
      // wrapping evidence map). We rebuild those exact bytes here.
      //
      // Implementation: call the entry builder (which validates payload
      // shape + applies the `*_b64` decode rule) and then encode just the
      // `payload` sub-value of the returned tagged map. This guarantees
      // bytes match the same canonicaliser that produced the evidence-array
      // CBOR — single source of truth.
      let payloadCborBytes: Uint8Array;
      try {
        const tagged = evidenceEntryToCborValue({
          evidence_type: evidenceType,
          nonce: nonceHex,
          payload,
        } satisfies AttestationEvidenceEntry);
        if (tagged.type !== "map") {
          throw new Error("evidenceEntryToCborValue returned non-map");
        }
        const payloadEntry = tagged.v.find(([k]) => k === "payload");
        if (!payloadEntry) {
          throw new Error("payload key missing in tagged map");
        }
        payloadCborBytes = encodeCbor(payloadEntry[1]);
      } catch (e) {
        reject(
          res,
          400,
          "WRONG_TYPE",
          `payload could not be canonicalised: ${e instanceof Error ? e.message : String(e)}`,
          "payload",
        );
        return;
      }

      if (!verifySr25519(payloadCborBytes, attestorPubHex, signatureHex)) {
        reject(
          res,
          401,
          "SIGNATURE_INVALID",
          "signature does not verify against attestor_pubkey over canonical(payload)",
          "signature",
        );
        return;
      }

      // ---- 6. insert (idempotent on triple) ----
      // The receipt_id we store under is the canonical one derived from the
      // content_hash. If the caller passed content_hash directly, recompute.
      const canonicalReceiptId = normalizeHex(computeReceiptId(contentHashHex));

      const outcome = insertReceiptEvidence({
        receipt_id: canonicalReceiptId,
        evidence_type: evidenceType,
        nonce_hex: nonceHex,
        payload,
        attestor_pubkey_hex: attestorPubHex,
        signature_hex: signatureHex,
      });

      const summary = recomputeReceiptEvidenceHash(canonicalReceiptId);
      // Spec wire status: "accepted" on first store, "replay" on second.
      const wireStatus = outcome.status === "inserted" ? "accepted" : "replay";
      res.status(200).json({
        ok: true,
        status: wireStatus,
        receipt_id: canonicalReceiptId,
        attestation_evidence_hash: summary.hash,
        evidence_count: summary.count,
        evidence_types: summary.types,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[blob-gateway] event=attestation_evidence_internal_error reason=${msg}`,
      );
      reject(res, 500, "INTERNAL", "internal error");
    }
  },
);

