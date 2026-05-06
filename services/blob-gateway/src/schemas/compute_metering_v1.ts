/**
 * `compute_metering_v1` — schema definition + gateway-side validator.
 *
 * Compute workers report resource usage (CPU/RAM/disk/net/GPU over a time
 * window) to the Materios blob gateway via a signed JSON record. The gateway
 * validates the record (shape, bounds, signature, time-skew), derives a
 * canonical content hash, and (on success) routes it through the existing
 * sponsored-receipt pipeline as if it were a regular receipt with
 * `schema_hash = sha256("compute_metering_v1")`.
 *
 * Why CBOR for the canonical body?
 *   The signature MUST be verifiable byte-for-byte across languages (worker
 *   SDKs in TS/Python/Rust). Plain JSON is non-canonical: spacing, key order,
 *   number formatting all vary. Canonical CBOR (RFC 8949 §4.2.1) gives one
 *   deterministic byte string for one logical record.
 *
 *   We implement a TINY canonical CBOR encoder inline rather than pulling in
 *   `cbor`, `cbor-x`, or similar — the input shape is closed, the encoding is
 *   exhaustively unit-tested, and a third-party canonical mode often differs
 *   in subtle ways (negative-zero floats, non-shortest ints, BigInt fallback).
 *   Keep it minimal and audited.
 *
 * Canonical encoding rules (RFC 8949 §4.2.1, distilled to what we need):
 *   - Definite-length encoding (no indefinite-length items).
 *   - Shortest possible integer form (uint major type 0/1).
 *   - Floats: IEEE-754 binary64 (major type 7, additional info 27, 8-byte BE).
 *     We do NOT shorten floats to f32/f16 — the cross-language verifier ports
 *     would need to match shortening exactly, which is a footgun. Always 8-byte.
 *   - Map keys sorted by encoded-byte lexicographic order (for our all-ASCII
 *     short keys this is identical to UTF-8 string lex order).
 *   - Strings: UTF-8 bytes, major type 3.
 *
 * The signature is sr25519 over the canonical CBOR of the body MINUS the
 * `worker_signature` field itself (canonical map of all other fields). The
 * `content_hash` returned by the validator is SHA-256 of that same canonical
 * CBOR — this lets the on-chain receipt's `content_hash` be reproduced by any
 * verifier independently of the gateway.
 */

import { createHash } from "crypto";
import { signatureVerify, encodeAddress } from "@polkadot/util-crypto";
import { hexToU8a, u8aToHex } from "@polkadot/util";

/** Exact schema version string. Anything else = reject. */
export const SCHEMA_VERSION = "compute_metering_v1";

/** sha256 of the schema-version string — used as `schema_hash` upstream. */
export const SCHEMA_HASH_HEX = createHash("sha256")
  .update(SCHEMA_VERSION, "utf-8")
  .digest("hex");

/** Field-name regex for `worker_id` and `tenant_id`. */
const ID_REGEX = /^[a-z0-9-]{4,64}$/;

/** Period upper bound: 24 h. */
export const MAX_PERIOD_MS = 86_400_000;

/** Future-dated `period_end` tolerance: 60 s of clock skew. */
export const FUTURE_SKEW_MS = 60_000;

/** JS-safe int max (`Number.MAX_SAFE_INTEGER` = 2^53 - 1). */
export const JS_SAFE_INT = Number.MAX_SAFE_INTEGER;

/** Default per-worker hardware bounds. Used when the registry has no row. */
export const DEFAULT_BOUNDS: WorkerBounds = Object.freeze({
  max_cpu_cores: 128,
  max_ram_gb: 2048,
  max_disk_gb: 16384,
  max_gpu_count: 8,
});

/** Hex regex for `worker_pubkey` (64 chars) and `worker_signature` (128 chars). */
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

/** Per-worker hardware bounds. */
export interface WorkerBounds {
  max_cpu_cores: number;
  max_ram_gb: number;
  max_disk_gb: number;
  max_gpu_count: number;
}

/** Decoded compute_metering_v1 record (post-validation). */
export interface ComputeMeteringV1 {
  schema_version: typeof SCHEMA_VERSION;
  worker_id: string;
  tenant_id: string;
  period_start: number;
  period_end: number;
  cpu_seconds: number;
  ram_gb_hours: number;
  disk_gb_hours: number;
  net_bytes_in: number;
  net_bytes_out: number;
  gpu_seconds: number;
  worker_pubkey: string;
  worker_signature: string;
}

/** Successful validation result. */
export interface ValidateOk {
  ok: true;
  /** The fully-typed, normalised record. */
  record: ComputeMeteringV1;
  /**
   * SHA-256 of the canonical CBOR (everything except `worker_signature`).
   * Hex-encoded, no `0x` prefix. This is what the upstream sponsored-receipt
   * pipeline uses as `content_hash`.
   */
  content_hash: string;
  /**
   * SHA-256 of the schema-version string. Hex, no prefix. Stable across
   * records — provided here for convenience so callers don't have to import
   * `SCHEMA_HASH_HEX` separately.
   */
  schema_hash: string;
  /** Canonical body bytes (CBOR-encoded, signature field stripped). */
  canonical_body: Uint8Array;
}

/** Failed validation result. `field` names the offending key when applicable. */
export interface ValidateErr {
  ok: false;
  /** Stable error code suitable for client-side handling. */
  code: ValidateErrorCode;
  /** Human-readable message including the offending field name. */
  message: string;
  /** Optional field name (snake_case) of the failing constraint. */
  field?: string;
}

export type ValidateErrorCode =
  | "INVALID_JSON"
  | "MISSING_FIELD"
  | "WRONG_TYPE"
  | "WRONG_SCHEMA_VERSION"
  | "ID_FORMAT"
  | "PERIOD_INVALID"
  | "NEGATIVE_VALUE"
  | "BOUND_EXCEEDED"
  | "INT_OVERFLOW"
  | "HEX_FORMAT"
  | "SIGNATURE_INVALID"
  | "MONOTONIC_VIOLATION";

export type ValidateResult = ValidateOk | ValidateErr;

/** Optional per-worker context passed into the validator. */
export interface ValidateOptions {
  /**
   * Hardware bounds for this `worker_id`. Pass the result of
   * `getWorkerBounds(worker_id)` from `worker_bounds.ts`. When omitted,
   * `DEFAULT_BOUNDS` are used — useful for unit tests and the first time a
   * worker is seen.
   */
  bounds?: WorkerBounds;
  /**
   * Greatest `period_start` previously observed for this `worker_id`. The
   * incoming record's `period_start` MUST be `>=` this value (monotonic
   * non-decreasing). Pass `0` (or omit) for first-ever record.
   */
  last_period_start?: number;
  /**
   * Override `Date.now()` in tests. Production callers omit this.
   */
  now_ms?: number;
}

// ---------------------------------------------------------------------------
// Canonical CBOR encoder — RFC 8949 §4.2.1, restricted to the types we use:
//   - Unsigned ints (major type 0)
//   - Signed ints (major type 1)
//   - Byte strings (major type 2) — currently unused in this schema
//   - Text strings (major type 3)
//   - Arrays (major type 4) — unused in this schema
//   - Maps (major type 5)
//   - Floats (major type 7, additional 27 → IEEE-754 binary64, 8 bytes BE)
// All other CBOR features (tags, bignums, simple values beyond float64) are
// intentionally NOT supported — pass an unsupported value and you get a
// `TypeError`, by design. Keeps the cross-language verifier surface tiny.
// ---------------------------------------------------------------------------

function encodeUint(major: number, n: number): Uint8Array {
  // Shortest encoding per RFC 8949 §3.1.
  if (n < 0 || !Number.isFinite(n)) {
    throw new TypeError(`encodeUint: out of range: ${n}`);
  }
  if (n <= 23) {
    return Uint8Array.of((major << 5) | n);
  }
  if (n <= 0xff) {
    return Uint8Array.of((major << 5) | 24, n);
  }
  if (n <= 0xffff) {
    return Uint8Array.of((major << 5) | 25, (n >> 8) & 0xff, n & 0xff);
  }
  if (n <= 0xffffffff) {
    return Uint8Array.of(
      (major << 5) | 26,
      (n >>> 24) & 0xff,
      (n >>> 16) & 0xff,
      (n >>> 8) & 0xff,
      n & 0xff,
    );
  }
  // 64-bit unsigned. JS numbers are safe up to 2^53; we explicitly cap at
  // JS_SAFE_INT in the validator before encoding, so this branch is reachable
  // ONLY for values ≤ 2^53 - 1. Use BigInt to do the byte split safely.
  if (n > JS_SAFE_INT) {
    throw new TypeError(`encodeUint: exceeds JS-safe int: ${n}`);
  }
  const bn = BigInt(n);
  const out = new Uint8Array(9);
  out[0] = (major << 5) | 27;
  for (let i = 0; i < 8; i++) {
    out[8 - i] = Number((bn >> BigInt(i * 8)) & 0xffn);
  }
  return out;
}

function encodeInt(n: number): Uint8Array {
  if (!Number.isInteger(n)) {
    throw new TypeError(`encodeInt: not an integer: ${n}`);
  }
  if (n >= 0) return encodeUint(0, n);
  // Negative: major type 1, value -1 - n.
  return encodeUint(1, -1 - n);
}

function encodeFloat64(n: number): Uint8Array {
  // RFC 8949 §3.3: float64 is major type 7, additional info 27, 8-byte BE.
  // We always use float64; never shorten to f32/f16. NaN is canonicalised to
  // a single bit pattern (0x7ff8...) by Node's DataView — but we explicitly
  // refuse NaN/Infinity in the validator before reaching here, so this is
  // belt-and-suspenders.
  if (!Number.isFinite(n)) {
    throw new TypeError(`encodeFloat64: not finite: ${n}`);
  }
  const buf = new ArrayBuffer(9);
  const view = new DataView(buf);
  view.setUint8(0, (7 << 5) | 27);
  view.setFloat64(1, n, /* littleEndian = */ false);
  return new Uint8Array(buf);
}

function encodeText(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const head = encodeUint(3, bytes.length);
  const out = new Uint8Array(head.length + bytes.length);
  out.set(head, 0);
  out.set(bytes, head.length);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Canonical CBOR map encoder. Keys are encoded first, then sorted by the
 * lexicographic order of their encoded bytes (RFC 8949 §4.2.1). Since our
 * keys are all short ASCII, this is identical to JS string-comparison sort.
 *
 * Value type dispatch is closed: int → encodeInt, finite float → encodeFloat64,
 * string → encodeText. Anything else throws — we never silently coerce.
 */
function encodeMap(
  entries: Array<[string, number | string]>,
): Uint8Array {
  const encoded = entries.map(([k, v]) => {
    const keyBytes = encodeText(k);
    let valueBytes: Uint8Array;
    if (typeof v === "string") {
      valueBytes = encodeText(v);
    } else if (Number.isInteger(v)) {
      valueBytes = encodeInt(v);
    } else if (typeof v === "number" && Number.isFinite(v)) {
      valueBytes = encodeFloat64(v);
    } else {
      throw new TypeError(
        `encodeMap: unsupported value for key '${k}': ${String(v)}`,
      );
    }
    return { keyBytes, valueBytes };
  });
  // Sort by encoded key bytes — lex over Uint8Array.
  encoded.sort((a, b) => cmpBytes(a.keyBytes, b.keyBytes));
  const head = encodeUint(5, encoded.length);
  const parts: Uint8Array[] = [head];
  for (const { keyBytes, valueBytes } of encoded) {
    parts.push(keyBytes, valueBytes);
  }
  return concat(parts);
}

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Build the canonical body bytes for a record. The `worker_signature` field
 * is excluded — that's the input to sr25519.verify, NOT a self-reference.
 *
 * Exported so worker SDKs (and the worker_signature pre-image side) can use
 * the SAME function. Reuse beats reimplementation across languages.
 */
export function canonicalBody(
  rec: Omit<ComputeMeteringV1, "worker_signature">,
): Uint8Array {
  const entries: Array<[string, number | string]> = [
    ["schema_version", rec.schema_version],
    ["worker_id", rec.worker_id],
    ["tenant_id", rec.tenant_id],
    ["period_start", rec.period_start],
    ["period_end", rec.period_end],
    ["cpu_seconds", rec.cpu_seconds],
    ["ram_gb_hours", rec.ram_gb_hours],
    ["disk_gb_hours", rec.disk_gb_hours],
    ["net_bytes_in", rec.net_bytes_in],
    ["net_bytes_out", rec.net_bytes_out],
    ["gpu_seconds", rec.gpu_seconds],
    ["worker_pubkey", rec.worker_pubkey],
  ];
  return encodeMap(entries);
}

/**
 * SHA-256 hex-digest of the canonical body (sans signature).
 * This is the upstream `content_hash` and the message that the sr25519
 * signature MUST be verified against.
 */
export function canonicalContentHash(
  rec: Omit<ComputeMeteringV1, "worker_signature">,
): string {
  return createHash("sha256").update(canonicalBody(rec)).digest("hex");
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

function err(
  code: ValidateErrorCode,
  message: string,
  field?: string,
): ValidateErr {
  return field !== undefined
    ? { ok: false, code, message, field }
    : { ok: false, code, message };
}

/**
 * Validate a parsed JSON object against the `compute_metering_v1` schema.
 *
 * Returns either `{ ok: true, record, content_hash, schema_hash, canonical_body }`
 * on success or `{ ok: false, code, message, field? }` on failure.
 *
 * The validator NEVER throws on input shape — every failure mode is captured
 * as a `ValidateErr`. (It WILL throw on a programming error like passing
 * `null` for `opts`, but that's a usage bug.)
 */
export function validateComputeMeteringV1(
  raw: unknown,
  opts: ValidateOptions = {},
): ValidateResult {
  const bounds = opts.bounds ?? DEFAULT_BOUNDS;
  const nowMs = opts.now_ms ?? Date.now();
  const lastPeriodStart = opts.last_period_start ?? 0;

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return err("WRONG_TYPE", "expected JSON object at root");
  }
  const r = raw as Record<string, unknown>;

  // --- schema_version ---
  if (!("schema_version" in r)) {
    return err("MISSING_FIELD", "schema_version is required", "schema_version");
  }
  if (typeof r.schema_version !== "string") {
    return err(
      "WRONG_TYPE",
      "schema_version must be a string",
      "schema_version",
    );
  }
  if (r.schema_version !== SCHEMA_VERSION) {
    return err(
      "WRONG_SCHEMA_VERSION",
      `schema_version must be exactly "${SCHEMA_VERSION}", got "${r.schema_version}"`,
      "schema_version",
    );
  }

  // --- worker_id / tenant_id ---
  for (const key of ["worker_id", "tenant_id"] as const) {
    if (!(key in r)) {
      return err("MISSING_FIELD", `${key} is required`, key);
    }
    const v = r[key];
    if (typeof v !== "string") {
      return err("WRONG_TYPE", `${key} must be a string`, key);
    }
    if (!ID_REGEX.test(v)) {
      return err(
        "ID_FORMAT",
        `${key} must match [a-z0-9-]{4,64}, got "${v}"`,
        key,
      );
    }
  }
  const workerId = r.worker_id as string;
  const tenantId = r.tenant_id as string;

  // --- period_start ---
  if (!("period_start" in r)) {
    return err("MISSING_FIELD", "period_start is required", "period_start");
  }
  if (typeof r.period_start !== "number" || !Number.isInteger(r.period_start)) {
    return err(
      "WRONG_TYPE",
      "period_start must be an integer (unix millis)",
      "period_start",
    );
  }
  if (r.period_start <= 0) {
    return err(
      "PERIOD_INVALID",
      "period_start must be > 0",
      "period_start",
    );
  }
  const periodStart = r.period_start;

  // --- period_end ---
  if (!("period_end" in r)) {
    return err("MISSING_FIELD", "period_end is required", "period_end");
  }
  if (typeof r.period_end !== "number" || !Number.isInteger(r.period_end)) {
    return err(
      "WRONG_TYPE",
      "period_end must be an integer (unix millis)",
      "period_end",
    );
  }
  const periodEnd = r.period_end;
  if (periodEnd <= periodStart) {
    return err(
      "PERIOD_INVALID",
      "period_end must be > period_start",
      "period_end",
    );
  }
  if (periodEnd - periodStart > MAX_PERIOD_MS) {
    return err(
      "PERIOD_INVALID",
      `period (period_end - period_start) must be <= ${MAX_PERIOD_MS} ms (24 h)`,
      "period_end",
    );
  }
  if (periodEnd > nowMs + FUTURE_SKEW_MS) {
    return err(
      "PERIOD_INVALID",
      `period_end is too far in the future (skew > ${FUTURE_SKEW_MS} ms)`,
      "period_end",
    );
  }

  // --- monotonic non-decreasing per worker_id ---
  if (periodStart < lastPeriodStart) {
    return err(
      "MONOTONIC_VIOLATION",
      `period_start ${periodStart} < last observed ${lastPeriodStart} for ${workerId}`,
      "period_start",
    );
  }

  // --- numeric fields with bounds ---
  // Pre-compute the period in seconds and hours so each bound check uses the
  // SAME arithmetic — no float drift between fields.
  const periodSec = (periodEnd - periodStart) / 1000;
  const periodHr = (periodEnd - periodStart) / 3_600_000;

  type Numeric = {
    key: keyof ComputeMeteringV1;
    kind: "float" | "int";
    cap: number;
  };

  const numericFields: Numeric[] = [
    { key: "cpu_seconds", kind: "float", cap: periodSec * bounds.max_cpu_cores },
    { key: "ram_gb_hours", kind: "float", cap: periodHr * bounds.max_ram_gb },
    { key: "disk_gb_hours", kind: "float", cap: periodHr * bounds.max_disk_gb },
    { key: "net_bytes_in", kind: "int", cap: JS_SAFE_INT },
    { key: "net_bytes_out", kind: "int", cap: JS_SAFE_INT },
    { key: "gpu_seconds", kind: "float", cap: periodSec * bounds.max_gpu_count },
  ];

  for (const f of numericFields) {
    const k = f.key;
    if (!(k in r)) {
      return err("MISSING_FIELD", `${k} is required`, k);
    }
    const v = r[k];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return err(
        "WRONG_TYPE",
        `${k} must be a finite number`,
        k,
      );
    }
    if (f.kind === "int" && !Number.isInteger(v)) {
      return err("WRONG_TYPE", `${k} must be an integer`, k);
    }
    if (v < 0) {
      return err("NEGATIVE_VALUE", `${k} must be >= 0, got ${v}`, k);
    }
    if (f.kind === "int" && v > JS_SAFE_INT) {
      return err(
        "INT_OVERFLOW",
        `${k} must be <= 2^53-1, got ${v}`,
        k,
      );
    }
    // Bound check for *_per_period derived caps (cpu/ram/disk/gpu).
    // For net_bytes_*, the cap IS JS_SAFE_INT (already enforced above).
    if (f.kind === "float" && v > f.cap) {
      return err(
        "BOUND_EXCEEDED",
        `${k} ${v} exceeds hardware-implausible cap ${f.cap}`,
        k,
      );
    }
  }

  // --- worker_pubkey / worker_signature (hex, fixed length) ---
  for (const [k, re, expected] of [
    ["worker_pubkey", HEX64, 64],
    ["worker_signature", HEX128, 128],
  ] as const) {
    if (!(k in r)) {
      return err("MISSING_FIELD", `${k} is required`, k);
    }
    const v = r[k];
    if (typeof v !== "string") {
      return err("WRONG_TYPE", `${k} must be a string`, k);
    }
    if (!re.test(v)) {
      return err(
        "HEX_FORMAT",
        `${k} must be exactly ${expected} lowercase hex chars, got length ${v.length}`,
        k,
      );
    }
  }
  const workerPubkey = r.worker_pubkey as string;
  const workerSignature = r.worker_signature as string;

  // --- assemble the typed record ---
  const record: ComputeMeteringV1 = {
    schema_version: SCHEMA_VERSION,
    worker_id: workerId,
    tenant_id: tenantId,
    period_start: periodStart,
    period_end: periodEnd,
    cpu_seconds: r.cpu_seconds as number,
    ram_gb_hours: r.ram_gb_hours as number,
    disk_gb_hours: r.disk_gb_hours as number,
    net_bytes_in: r.net_bytes_in as number,
    net_bytes_out: r.net_bytes_out as number,
    gpu_seconds: r.gpu_seconds as number,
    worker_pubkey: workerPubkey,
    worker_signature: workerSignature,
  };

  // --- canonical body + signature verify ---
  const body = canonicalBody({
    schema_version: record.schema_version,
    worker_id: record.worker_id,
    tenant_id: record.tenant_id,
    period_start: record.period_start,
    period_end: record.period_end,
    cpu_seconds: record.cpu_seconds,
    ram_gb_hours: record.ram_gb_hours,
    disk_gb_hours: record.disk_gb_hours,
    net_bytes_in: record.net_bytes_in,
    net_bytes_out: record.net_bytes_out,
    gpu_seconds: record.gpu_seconds,
    worker_pubkey: record.worker_pubkey,
  });

  // sr25519 verify. We pass the pubkey as a 0x-prefixed hex string — the
  // util-crypto helper accepts that as an "address-like" public key.
  const pubkeyU8 = hexToU8a("0x" + workerPubkey);
  const sigU8 = hexToU8a("0x" + workerSignature);
  let isValid = false;
  try {
    const result = signatureVerify(body, sigU8, u8aToHex(pubkeyU8));
    isValid = result.isValid;
  } catch (e) {
    // Malformed pubkey/sig caught here. Treat as signature-invalid; the hex
    // shape was already format-checked above so this is a deeper crypto fail.
    return err(
      "SIGNATURE_INVALID",
      `signature verify error: ${e instanceof Error ? e.message : String(e)}`,
      "worker_signature",
    );
  }
  if (!isValid) {
    return err(
      "SIGNATURE_INVALID",
      "sr25519 signature does not verify against worker_pubkey",
      "worker_signature",
    );
  }

  const contentHash = createHash("sha256").update(body).digest("hex");
  return {
    ok: true,
    record,
    content_hash: contentHash,
    schema_hash: SCHEMA_HASH_HEX,
    canonical_body: body,
  };
}

/**
 * Convenience: derive the SS58 address (Substrate generic, prefix 42) from a
 * 32-byte sr25519 hex pubkey. Used by the gateway route to attribute the
 * upstream sponsored-receipt to the worker's account.
 */
export function workerPubkeyToSs58(workerPubkey: string, prefix = 42): string {
  if (!HEX64.test(workerPubkey)) {
    throw new TypeError(
      `workerPubkeyToSs58: expected 64 lowercase hex, got "${workerPubkey}"`,
    );
  }
  return encodeAddress(hexToU8a("0x" + workerPubkey), prefix);
}
