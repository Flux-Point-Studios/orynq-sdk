/**
 * Self-service attestor registration via Android Key Attestation cert chain.
 *
 * Existing flow (admin-only) — the Materios Witness Network APK on a
 * fresh phone generates a KeyMint-attested P-256 key inside TrustZone,
 * but the gateway's `/v2/attestation_evidence` endpoint rejects unknown
 * pubkeys with `ATTESTOR_UNKNOWN`. An admin had to manually `POST
 * /admin/attestation-evidence-attestors` for each new device — fine for
 * one phone, fatal for an open recruitment funnel.
 *
 * This module replaces the admin gate with a cryptographic gate. A
 * phone posts its full Google-issued cert chain plus the SPKI hash
 * (== `attest_key_hash`). We verify:
 *
 *   1. Internal chain integrity — each cert in the array is signed by
 *      the next (chain[i].verify(chain[i+1].publicKey)). This proves
 *      the leaf and its issuers all belong together; we don't yet
 *      check that chain[N] is Google's hardware-attestation root
 *      (TOFU for v1, root pinning queued for v2).
 *   2. The leaf SPKI bytes hash to the claimed `attest_key_hash_hex`.
 *      This ties the claimed identity to the actual cert we're
 *      validating — no swapping a Google-rooted cert in for some
 *      other key.
 *   3. The compressed P-256 point derived from the leaf SPKI equals
 *      the claimed `pubkey_hex`. The phone signs its probes with this
 *      same key.
 *   4. The leaf cert contains the Android Key Attestation extension
 *      OID 1.3.6.1.4.1.11129.2.1.17 (sentinel of an actual KeyMint
 *      attestation cert, not a random self-signed). Full ASN.1 decode
 *      of the KeyDescription — including securityLevel — is queued
 *      for v2; presence-only is good enough for TOFU.
 *
 * On success the attestor is registered as `sig_algo=secp256r1` via
 * the existing `registerAttestationEvidenceAttestor` (same store and
 * runtime semantics as an admin POST).
 *
 * Threat model for v1
 * -------------------
 * - Spoofed (non-TEE) cert chain: still allowed today. The on-chain
 *   receipt commits to `attest_key_hash`, so a forensic audit later
 *   can re-validate root-of-trust. We accept this tradeoff because
 *   the witness's job is to produce signed observations — the worst
 *   a spoofer can do is degrade the quality of the dataset.
 * - DoS via spam registration: gateway-level rate limiting is the
 *   right place to handle this. Not implemented in this module.
 * - Re-registration: a pubkey that's already registered returns 409
 *   with the existing row. Idempotent.
 */

import { X509Certificate, createHash, createPublicKey } from "node:crypto";
import {
  registerAttestationEvidenceAttestor,
  getAttestationEvidenceAttestor,
  type AttestationEvidenceAttestorRow,
} from "./attestation_evidence_attestors.js";

/**
 * Android Key Attestation extension OID = 1.3.6.1.4.1.11129.2.1.17.
 * In DER an OID is `06 LL <bytes>`; the encoded body for this OID is
 * the byte sequence below. We scan for the full `06 0A …` tag-length-
 * value form so we don't false-positive on substrings.
 */
const ANDROID_KEY_ATTESTATION_OID_DER = Buffer.from([
  0x06, 0x0a, 0x2b, 0x06, 0x01, 0x04, 0x01, 0xd6, 0x79, 0x02, 0x01, 0x11,
]);

/**
 * The compressed P-256 SEC1 encoding is 33 bytes: a 1-byte prefix
 * (0x02 if Y is even, 0x03 if Y is odd) followed by the 32-byte
 * big-endian X coordinate. We parse the leaf's SPKI to recover (X, Y)
 * and emit this compressed form, then compare against the claimed
 * pubkey_hex.
 */
function compressP256FromSpki(spkiDer: Buffer): Buffer | null {
  // Standard P-256 SPKI is 91 bytes:
  //   30 59                                              ; SEQUENCE
  //     30 13                                            ; SEQUENCE (AlgorithmIdentifier)
  //       06 07 2A 86 48 CE 3D 02 01                     ; OID id-ecPublicKey
  //       06 08 2A 86 48 CE 3D 03 01 07                  ; OID secp256r1
  //     03 42                                            ; BIT STRING (len 66)
  //       00                                             ; unused-bits = 0
  //       04 <X(32)> <Y(32)>                             ; SEC1 uncompressed point
  // Zero-indexed: byte 25 = 0x00, byte 26 = 0x04, X at 27..58, Y at 59..90.
  if (spkiDer.length !== 91) return null;
  if (spkiDer[25] !== 0x00 || spkiDer[26] !== 0x04) return null;
  const x = spkiDer.subarray(27, 59);
  const y = spkiDer.subarray(59, 91);
  const yIsOdd = (y[31] & 1) === 1;
  const out = Buffer.alloc(33);
  out[0] = yIsOdd ? 0x03 : 0x02;
  x.copy(out, 1);
  return out;
}

function indexOfSubarray(haystack: Buffer, needle: Buffer): number {
  if (needle.length > haystack.length) return -1;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function normalizeHex(input: string): string {
  return (input.startsWith("0x") || input.startsWith("0X")
    ? input.slice(2)
    : input
  ).toLowerCase();
}

export interface VerifyInput {
  chain_b64: string[];
  pubkey_hex: string;
  attest_key_hash_hex: string;
}

export type VerifyError =
  | { ok: false; code: "CHAIN_EMPTY"; message: string }
  | { ok: false; code: "CHAIN_BAD_BASE64"; message: string; at?: number }
  | { ok: false; code: "CHAIN_BAD_DER"; message: string; at?: number }
  | { ok: false; code: "CHAIN_BAD_SIGNATURE"; message: string; at?: number }
  | { ok: false; code: "LEAF_NOT_P256"; message: string }
  | { ok: false; code: "ATTEST_KEY_HASH_MISMATCH"; message: string; expected: string; actual: string }
  | { ok: false; code: "PUBKEY_MISMATCH"; message: string; expected: string; actual: string }
  | { ok: false; code: "NOT_KEYMINT_CERT"; message: string };

export interface VerifySuccess {
  ok: true;
  /** Hex of the leaf SPKI sha256 — same value as the on-chain attest_key_hash. */
  attestKeyHashHex: string;
  /** 66-char compressed P-256 pubkey hex. */
  pubkeyHex: string;
  /** Chain depth (handy for debugging / logging). */
  chainLength: number;
}

export type VerifyResult = VerifySuccess | VerifyError;

/**
 * Pure-CPU verification — no DB access, no network calls. Caller is
 * responsible for the registration step on success.
 */
export function verifyAttestationChain(input: VerifyInput): VerifyResult {
  const claimedPubkey = normalizeHex(input.pubkey_hex);
  const claimedHash = normalizeHex(input.attest_key_hash_hex);

  if (!Array.isArray(input.chain_b64) || input.chain_b64.length === 0) {
    return { ok: false, code: "CHAIN_EMPTY", message: "chain_b64 must be a non-empty array" };
  }

  // 1. Parse all certs.
  const certs: X509Certificate[] = [];
  for (let i = 0; i < input.chain_b64.length; i++) {
    let der: Buffer;
    try {
      der = Buffer.from(input.chain_b64[i], "base64");
      if (der.length < 50) throw new Error("DER too short");
    } catch (err) {
      return {
        ok: false,
        code: "CHAIN_BAD_BASE64",
        message: `chain_b64[${i}] is not valid base64-DER: ${(err as Error).message}`,
        at: i,
      };
    }
    try {
      certs.push(new X509Certificate(der));
    } catch (err) {
      return {
        ok: false,
        code: "CHAIN_BAD_DER",
        message: `chain_b64[${i}] is not a valid X.509 certificate: ${(err as Error).message}`,
        at: i,
      };
    }
  }

  const leaf = certs[0];

  // 2. Leaf SPKI hash must equal claimed attest_key_hash.
  const leafSpki = leaf.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const actualHash = createHash("sha256").update(leafSpki).digest("hex");
  if (actualHash !== claimedHash) {
    return {
      ok: false,
      code: "ATTEST_KEY_HASH_MISMATCH",
      message: "sha256 of leaf SPKI does not match claimed attest_key_hash",
      expected: claimedHash,
      actual: actualHash,
    };
  }

  // 3. Leaf SPKI compressed P-256 must equal claimed pubkey.
  const compressed = compressP256FromSpki(leafSpki);
  if (compressed === null) {
    return {
      ok: false,
      code: "LEAF_NOT_P256",
      message: "leaf SPKI is not a 91-byte uncompressed P-256 key",
    };
  }
  const actualPubkey = compressed.toString("hex");
  if (actualPubkey !== claimedPubkey) {
    return {
      ok: false,
      code: "PUBKEY_MISMATCH",
      message: "compressed P-256 point from leaf SPKI does not match claimed pubkey_hex",
      expected: claimedPubkey,
      actual: actualPubkey,
    };
  }

  // 4. Leaf must carry the Android Key Attestation extension OID. We
  //    scan leaf.raw for the DER-encoded OID; presence-only check.
  if (indexOfSubarray(leaf.raw, ANDROID_KEY_ATTESTATION_OID_DER) < 0) {
    return {
      ok: false,
      code: "NOT_KEYMINT_CERT",
      message:
        "leaf cert does not carry the Android Key Attestation extension " +
        "(OID 1.3.6.1.4.1.11129.2.1.17) — refusing to register a non-TEE key",
    };
  }

  // 5. Chain integrity — each cert is signed by the next. The Node
  //    X509Certificate.verify(issuerPubKey) returns boolean.
  for (let i = 0; i < certs.length - 1; i++) {
    const child = certs[i];
    const parentPub = createPublicKey({
      key: certs[i + 1].publicKey.export({ type: "spki", format: "der" }),
      format: "der",
      type: "spki",
    });
    if (!child.verify(parentPub)) {
      return {
        ok: false,
        code: "CHAIN_BAD_SIGNATURE",
        message: `chain[${i}] signature does not verify against chain[${i + 1}].publicKey`,
        at: i,
      };
    }
  }

  return {
    ok: true,
    attestKeyHashHex: claimedHash,
    pubkeyHex: claimedPubkey,
    chainLength: certs.length,
  };
}

export interface SelfRegisterOutcome {
  status: "created" | "already-registered" | "verify-failed";
  result: VerifyResult;
  attestor?: AttestationEvidenceAttestorRow;
}

/**
 * Verify the chain and (on success) register the attestor.
 * Returns a structured outcome instead of throwing.
 */
export function selfRegisterAttestor(
  input: VerifyInput,
  opts: { label?: string | null; notes?: string | null } = {},
): SelfRegisterOutcome {
  const result = verifyAttestationChain(input);
  if (!result.ok) {
    return { status: "verify-failed", result };
  }

  const existing = getAttestationEvidenceAttestor(result.pubkeyHex);
  if (existing) {
    return { status: "already-registered", result, attestor: existing };
  }

  const label = opts.label ?? `self-registered-${result.attestKeyHashHex.slice(0, 12)}`;
  const notes =
    opts.notes ??
    `self-registered via cert chain (length=${result.chainLength}, ` +
      `attest_key_hash=${result.attestKeyHashHex})`;
  const attestor = registerAttestationEvidenceAttestor({
    pubkey: result.pubkeyHex,
    sig_algo: "secp256r1",
    label,
    notes,
  });
  return { status: "created", result, attestor };
}
