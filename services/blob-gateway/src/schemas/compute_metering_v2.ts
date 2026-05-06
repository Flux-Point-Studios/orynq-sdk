/**
 * `compute_metering_v2` — Wave 1+2 hardware-bounded + observer-co-signed schema.
 *
 * v1 (still supported in parallel) is worker-signed-only with a flat body. v2
 * adds two trust layers on top:
 *
 *   - `hardware_spec` — the worker's claimed CPU cores / RAM / GPU type, signed
 *     OFFLINE by the FPS-registered fleet operator. Lets the gateway reject
 *     "100 CPU-hours/hour from a 4-core node" claims at the validator.
 *   - `observer` (optional, Wave 2) — independent co-signature over the EXACT
 *     SAME bytes as the worker signature, to prove a second party witnessed
 *     this record.
 *
 * Trust framing: M-of-N committee attested, same standard Cardano itself uses.
 * Wave 1+2 is the BASELINE trust layer, not a stopgap. (TEE attestation lands
 * in Wave 3 as defense-in-depth.) See `project_compute_portal_trust_roadmap.md`.
 *
 * --- Why CBOR (and a hand-rolled encoder) ---
 *
 * The signature MUST be verifiable byte-for-byte across worker SDKs in TS,
 * Python, and (eventually) Rust. JSON is non-canonical (spacing, key order,
 * number formatting all vary). RFC 8949 §4.2.1 canonical CBOR pins one
 * deterministic byte string per logical record.
 *
 * We hand-roll the encoder rather than pull in `cbor`, `cbor-x`, or Python's
 * `cbor2(canonical=True)` — because those libraries silently SHORTEN floats
 * (1.5 becomes a 3-byte float16, not a 9-byte float64). A cross-language
 * verifier that uses two libraries with different shortening rules will
 * disagree on bytes for half the field values. v2's encoder always emits
 * 8-byte float64 (major type 7, additional info 27), with no shortening,
 * matching v1's pattern.
 *
 * --- Wire format vs canonical pre-image ---
 *
 * The HTTP wire format is JSON: pubkeys/signatures are 64/128-char lowercase
 * hex strings, byte fields are ints, etc. The CANONICAL CBOR pre-image used
 * for signing/verifying uses RAW BYTES (CBOR major type 2) for pubkeys and
 * signatures — that's what `sr25519::verify` actually consumes, and using
 * bytes (not 64-char hex) keeps the pre-image short and unambiguous.
 *
 * --- Canonical CBOR rules (RFC 8949 §4.2.1, distilled to what we use) ---
 *
 *   - Definite-length encoding only (no indefinite-length items).
 *   - Shortest possible integer head per RFC 8949 §3.1.
 *   - Floats: ALWAYS IEEE-754 binary64 (major 7, additional 27, 8-byte BE).
 *     Never shortened to f32/f16. NaN/Infinity rejected at validation time.
 *   - Map keys sorted by encoded-byte lexicographic order. Our keys are all
 *     short ASCII so this reduces to a string lex sort.
 *   - Strings: UTF-8 bytes, major type 3.
 *   - Byte strings: major type 2 (used for pubkeys/signatures in pre-images).
 *   - Arrays: major type 4 (used for the fixed-position pre-image tuples).
 *   - Maps: major type 5.
 *
 * --- Signature pre-images (PINNED — coordinated with Python encoder) ---
 *
 * `fleet_operator_signature` signs canonical CBOR of the array:
 *   ["fleet_op_attestation_v1", worker_id, hardware_spec_no_sig, issued_ms]
 *   where `hardware_spec_no_sig` = hardware_spec map MINUS
 *   `fleet_operator_signature` (everything else stays, including pubkey).
 *
 * `worker_signature` signs canonical CBOR of the array:
 *   ["compute_metering_v2", worker_id, tenant_id,
 *    period_start_ms, period_end_ms, metrics_map, hardware_spec_full_map,
 *    worker_pubkey_bytes]
 *   `hardware_spec_full_map` INCLUDES `fleet_operator_signature` so any
 *   tampering with the operator-signed portion breaks the worker pre-image
 *   too.
 *
 * `observer_signature` (when present) signs the EXACT SAME BYTES as
 * `worker_signature`. Verifier reconstructs the worker pre-image once and
 * runs sr25519::verify against `observer_pubkey` separately.
 */

import { createHash } from "crypto";
import { signatureVerify, encodeAddress } from "@polkadot/util-crypto";
import { hexToU8a, u8aToHex } from "@polkadot/util";

/** Exact schema version string. Anything else = reject. */
export const SCHEMA_VERSION = "compute_metering_v2";

/** sha256 of the schema-version string — used as `schema_hash` upstream. */
export const SCHEMA_HASH_HEX = createHash("sha256")
  .update(SCHEMA_VERSION, "utf-8")
  .digest("hex");

/** Tag string used as the array head of the fleet-op attestation pre-image. */
export const FLEET_OP_TAG = "fleet_op_attestation_v1";

/** ID-format regex shared by `worker_id` and `tenant_id`. */
const ID_REGEX = /^[a-z0-9-]{4,64}$/;

/**
 * `worker_id` accepts anything UTF-8 in [1..128] without spaces or commas.
 * (Spec is intentionally looser than `tenant_id` — workers identify themselves
 * with hostnames / pod-names which can include underscores, dots, etc.)
 */
const WORKER_ID_REGEX = /^[^\s,]{1,128}$/;

/** Period upper bound: 24 h. */
export const MAX_PERIOD_MS = 86_400_000;

/** Future-dated `period_end_ms` tolerance: 60 s of clock skew. */
export const FUTURE_SKEW_MS = 60_000;

/**
 * Hardware-jitter factor. CPU/RAM bounds allow up to 5% over the strict
 * `cores × seconds` limit to absorb measurement jitter (tickless kernels,
 * cgroup accounting overshoots, etc.). PINNED — do not change without
 * coordinating Wave 1+2 teams 1/2/3 simultaneously.
 */
export const JITTER_FACTOR = 1.05;

/** JS-safe int max (`Number.MAX_SAFE_INTEGER` = 2^53 - 1). */
export const JS_SAFE_INT = Number.MAX_SAFE_INTEGER;

/** Hex regex for 32-byte pubkey (64 chars) and 64-byte signature (128 chars). */
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

/**
 * Permitted `gpu_type` values. Closed set so future workers can't claim
 * imaginary silicon. `"none"` (no GPU) and `"custom"` (escape hatch for
 * audited custom hardware) are the bookends.
 */
export const GPU_TYPES = [
  "none",
  "nvidia-h100",
  "nvidia-h200",
  "nvidia-b100",
  "nvidia-a100",
  "amd-mi300",
  "custom",
] as const;
export type GpuType = (typeof GPU_TYPES)[number];

const GPU_TYPE_SET: ReadonlySet<string> = new Set<string>(GPU_TYPES);

/** Hardware-spec bounds. */
export const MIN_CPU_CORES = 1;
export const MAX_CPU_CORES = 1024;
export const MIN_RAM_GB = 1;
export const MAX_RAM_GB = 16384;
export const MIN_GPU_COUNT = 0;
export const MAX_GPU_COUNT = 16;

// ---------------------------------------------------------------------------
// Type definitions for the wire format (JSON over HTTP).
// ---------------------------------------------------------------------------

/** Per-record resource metrics. All values >= 0. */
export interface MetricsV2 {
  cpu_seconds: number;
  ram_gb_hours: number;
  disk_gb_hours: number;
  net_bytes_in: number;
  net_bytes_out: number;
  gpu_seconds: number;
}

/** Hardware spec, signed offline by the fleet operator. */
export interface HardwareSpecV2 {
  cpu_cores: number;
  ram_gb: number;
  gpu_type: GpuType;
  gpu_count: number;
  /** 64-char lowercase hex (no `0x` prefix). */
  fleet_operator_pubkey: string;
  /** 128-char lowercase hex (no `0x` prefix). */
  fleet_operator_signature: string;
  /** UNIX millis when the fleet operator signed this spec. */
  issued_ms: number;
}

/** Optional independent observer co-signature over the worker pre-image. */
export interface ObserverV2 {
  /** 64-char lowercase hex. */
  observer_pubkey: string;
  /** 128-char lowercase hex. */
  observer_signature: string;
}

/** Decoded v2 record (post-validation). */
export interface ComputeMeteringV2 {
  schema_version: typeof SCHEMA_VERSION;
  worker_id: string;
  tenant_id: string;
  period_start_ms: number;
  period_end_ms: number;
  metrics: MetricsV2;
  hardware_spec: HardwareSpecV2;
  /** 64-char lowercase hex. */
  worker_pubkey: string;
  /** 128-char lowercase hex. */
  worker_signature: string;
  /** Optional Wave 2 co-signature. Absent => key not in record. */
  observer?: ObserverV2;
}

// ---------------------------------------------------------------------------
// Validation result types.
// ---------------------------------------------------------------------------

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
  | "GPU_TYPE_INVALID"
  | "GPU_COUNT_MISMATCH"
  | "HARDWARE_BOUND"
  | "FLEET_OP_SIGNATURE_INVALID"
  | "WORKER_SIGNATURE_INVALID"
  | "OBSERVER_SIGNATURE_INVALID"
  | "MONOTONIC_VIOLATION";

export interface ValidateOk {
  ok: true;
  record: ComputeMeteringV2;
  /** SHA-256 hex of the worker-signature pre-image. */
  content_hash: string;
  /** SHA-256 hex of the schema-version string. */
  schema_hash: string;
  /** The worker-signature pre-image bytes (canonical CBOR). */
  worker_pre_image: Uint8Array;
  /** The fleet-op-signature pre-image bytes (canonical CBOR). */
  fleet_op_pre_image: Uint8Array;
}

export interface ValidateErr {
  ok: false;
  code: ValidateErrorCode;
  message: string;
  field?: string;
}

export type ValidateResult = ValidateOk | ValidateErr;

export interface ValidateOptions {
  /**
   * Greatest `period_start_ms` previously observed for this `worker_id`. The
   * incoming record's `period_start_ms` MUST be `>=` this value. Pass `0`
   * (or omit) for the first-ever record from a worker.
   */
  last_period_start_ms?: number;
  /** Override `Date.now()` in tests. Production callers omit this. */
  now_ms?: number;
  /**
   * When true (default), verify all sr25519 signatures. The schemas-as-types
   * use case may pass `false` to use the validator as a pure shape checker,
   * but the gateway always sets this true.
   */
  verify_signatures?: boolean;
}

// ---------------------------------------------------------------------------
// Canonical CBOR encoder — RFC 8949 §4.2.1.
//
// Restricted to the types we use:
//   - Unsigned ints (major 0)
//   - Signed ints   (major 1)
//   - Byte strings  (major 2)  — pubkeys/signatures in pre-images
//   - Text strings  (major 3)
//   - Arrays        (major 4)  — pre-image tuples
//   - Maps          (major 5)
//   - Floats        (major 7, additional 27 = 8-byte float64 BE)
//
// All other CBOR features (tags, bignums, simple values) are intentionally
// NOT supported — pass an unsupported value and you get a TypeError, by
// design. Keeps the cross-language verifier surface tiny.
// ---------------------------------------------------------------------------

function encodeUint(major: number, n: number): Uint8Array {
  if (n < 0 || !Number.isFinite(n)) {
    throw new TypeError(`encodeUint: out of range: ${n}`);
  }
  if (n <= 23) return Uint8Array.of((major << 5) | n);
  if (n <= 0xff) return Uint8Array.of((major << 5) | 24, n);
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
  return encodeUint(1, -1 - n);
}

function encodeFloat64(n: number): Uint8Array {
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

function encodeBytes(b: Uint8Array): Uint8Array {
  const head = encodeUint(2, b.length);
  const out = new Uint8Array(head.length + b.length);
  out.set(head, 0);
  out.set(b, head.length);
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

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] as number;
    const bv = b[i] as number;
    if (av !== bv) return av - bv;
  }
  return a.length - b.length;
}

/**
 * Discriminator type for canonical-CBOR values. Closed dispatch — every value
 * placed into a map or array must be one of these wrapped variants. Wrapping
 * ints/floats explicitly avoids the JS quirk where `Number.isInteger(0.0)`
 * is `true`, which would silently route a float zero to the integer encoding
 * path and produce different bytes than the Python encoder.
 */
export type CborValue =
  | { type: "int"; v: number }
  | { type: "float"; v: number }
  | { type: "text"; v: string }
  | { type: "bytes"; v: Uint8Array }
  | { type: "array"; v: CborValue[] }
  | { type: "map"; v: Array<[string, CborValue]> };

/** Encode a tagged CBOR value into canonical bytes. */
export function encodeCbor(val: CborValue): Uint8Array {
  switch (val.type) {
    case "int":
      return encodeInt(val.v);
    case "float":
      return encodeFloat64(val.v);
    case "text":
      return encodeText(val.v);
    case "bytes":
      return encodeBytes(val.v);
    case "array": {
      const head = encodeUint(4, val.v.length);
      const parts: Uint8Array[] = [head];
      for (const item of val.v) parts.push(encodeCbor(item));
      return concat(parts);
    }
    case "map": {
      const encoded = val.v.map(([k, v]) => ({
        keyBytes: encodeText(k),
        valueBytes: encodeCbor(v),
      }));
      // RFC 8949 §4.2.1: sort by encoded-key bytes. All-ASCII keys reduce
      // this to a JS string lex sort, but we sort on the actual encoded
      // bytes for correctness.
      encoded.sort((a, b) => cmpBytes(a.keyBytes, b.keyBytes));
      const head = encodeUint(5, encoded.length);
      const parts: Uint8Array[] = [head];
      for (const { keyBytes, valueBytes } of encoded) {
        parts.push(keyBytes, valueBytes);
      }
      return concat(parts);
    }
  }
}

/** Convenience: build an int CBOR value. */
export const cborInt = (v: number): CborValue => ({ type: "int", v });
/** Convenience: build a float CBOR value (always 8-byte float64). */
export const cborFloat = (v: number): CborValue => ({ type: "float", v });
/** Convenience: build a text CBOR value. */
export const cborText = (v: string): CborValue => ({ type: "text", v });
/** Convenience: build a byte-string CBOR value. */
export const cborBytes = (v: Uint8Array): CborValue => ({ type: "bytes", v });
/** Convenience: build an array CBOR value. */
export const cborArray = (v: CborValue[]): CborValue => ({ type: "array", v });
/** Convenience: build a map CBOR value (key insertion order is irrelevant — sorted on encode). */
export const cborMap = (v: Array<[string, CborValue]>): CborValue => ({
  type: "map",
  v,
});

// ---------------------------------------------------------------------------
// Pre-image builders.
// ---------------------------------------------------------------------------

/**
 * Canonical CBOR for the `metrics` sub-map. Field-by-field: ints stay ints,
 * floats stay floats. The JS quirk `Number.isInteger(0.0) === true` is dodged
 * because we tag each value's type explicitly here based on the schema.
 *
 * `cpu_seconds`, `ram_gb_hours`, `disk_gb_hours`, `gpu_seconds` are FLOATS in
 * the schema. `net_bytes_in` / `net_bytes_out` are INTS. We always emit the
 * declared CBOR type, regardless of the runtime value's JS type.
 */
function metricsToCbor(m: MetricsV2): CborValue {
  return cborMap([
    ["cpu_seconds", cborFloat(m.cpu_seconds)],
    ["disk_gb_hours", cborFloat(m.disk_gb_hours)],
    ["gpu_seconds", cborFloat(m.gpu_seconds)],
    ["net_bytes_in", cborInt(m.net_bytes_in)],
    ["net_bytes_out", cborInt(m.net_bytes_out)],
    ["ram_gb_hours", cborFloat(m.ram_gb_hours)],
  ]);
}

/**
 * `hardware_spec` minus the `fleet_operator_signature` field. Used as the
 * 3rd element of the fleet-op pre-image array. Pubkey is encoded as raw
 * bytes (32) in the CBOR pre-image — `cborHexBytes` strips the hex layer.
 */
function hardwareSpecNoSigToCbor(spec: HardwareSpecV2): CborValue {
  return cborMap([
    ["cpu_cores", cborInt(spec.cpu_cores)],
    ["fleet_operator_pubkey", cborBytes(hexToU8a("0x" + spec.fleet_operator_pubkey))],
    ["gpu_count", cborInt(spec.gpu_count)],
    ["gpu_type", cborText(spec.gpu_type)],
    ["issued_ms", cborInt(spec.issued_ms)],
    ["ram_gb", cborInt(spec.ram_gb)],
  ]);
}

/**
 * Full `hardware_spec` (including signature) for embedding in the worker
 * pre-image. The fleet-op signature itself is bytes (64). Including it
 * means tampering with the operator-signed portion breaks the worker
 * pre-image too — defence in depth.
 */
function hardwareSpecFullToCbor(spec: HardwareSpecV2): CborValue {
  return cborMap([
    ["cpu_cores", cborInt(spec.cpu_cores)],
    ["fleet_operator_pubkey", cborBytes(hexToU8a("0x" + spec.fleet_operator_pubkey))],
    ["fleet_operator_signature", cborBytes(hexToU8a("0x" + spec.fleet_operator_signature))],
    ["gpu_count", cborInt(spec.gpu_count)],
    ["gpu_type", cborText(spec.gpu_type)],
    ["issued_ms", cborInt(spec.issued_ms)],
    ["ram_gb", cborInt(spec.ram_gb)],
  ]);
}

/**
 * Build the canonical CBOR bytes for the fleet-op-attestation pre-image.
 *
 *   [ "fleet_op_attestation_v1", worker_id, hardware_spec_no_sig, issued_ms ]
 *
 * Exported so worker SDKs (TS-side) can construct the bytes the fleet
 * operator signs offline.
 */
export function canonicalCborForFleetOpSig(
  workerId: string,
  hardwareSpec: HardwareSpecV2,
): Uint8Array {
  return encodeCbor(
    cborArray([
      cborText(FLEET_OP_TAG),
      cborText(workerId),
      hardwareSpecNoSigToCbor(hardwareSpec),
      cborInt(hardwareSpec.issued_ms),
    ]),
  );
}

/**
 * Build the canonical CBOR bytes for the worker-signature pre-image.
 *
 *   [ "compute_metering_v2", worker_id, tenant_id, period_start_ms,
 *     period_end_ms, metrics, hardware_spec_full, worker_pubkey_bytes ]
 *
 * The observer signature (when present) signs THESE EXACT BYTES under the
 * observer pubkey.
 */
export function canonicalCborForWorkerSig(
  rec: Omit<ComputeMeteringV2, "worker_signature" | "observer">,
): Uint8Array {
  return encodeCbor(
    cborArray([
      cborText(SCHEMA_VERSION),
      cborText(rec.worker_id),
      cborText(rec.tenant_id),
      cborInt(rec.period_start_ms),
      cborInt(rec.period_end_ms),
      metricsToCbor(rec.metrics),
      hardwareSpecFullToCbor(rec.hardware_spec),
      cborBytes(hexToU8a("0x" + rec.worker_pubkey)),
    ]),
  );
}

/**
 * SHA-256 hex of the worker-signature pre-image. This is the upstream
 * `content_hash` that the sponsored-receipt pipeline anchors to Cardano.
 */
export function canonicalContentHash(
  rec: Omit<ComputeMeteringV2, "worker_signature" | "observer">,
): string {
  return createHash("sha256")
    .update(canonicalCborForWorkerSig(rec))
    .digest("hex");
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

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

interface NumericFieldSpec {
  key: string;
  kind: "int" | "float";
}

const METRIC_FIELDS: readonly NumericFieldSpec[] = [
  { key: "cpu_seconds", kind: "float" },
  { key: "ram_gb_hours", kind: "float" },
  { key: "disk_gb_hours", kind: "float" },
  { key: "net_bytes_in", kind: "int" },
  { key: "net_bytes_out", kind: "int" },
  { key: "gpu_seconds", kind: "float" },
];

/** Validate the `metrics` sub-object, returning a typed copy or an err. */
function validateMetrics(
  raw: unknown,
): { ok: true; value: MetricsV2 } | ValidateErr {
  if (!isPlainObject(raw)) {
    return err("WRONG_TYPE", "metrics must be a JSON object", "metrics");
  }
  const out: Partial<MetricsV2> = {};
  for (const { key, kind } of METRIC_FIELDS) {
    if (!(key in raw)) {
      return err("MISSING_FIELD", `metrics.${key} is required`, `metrics.${key}`);
    }
    const v = raw[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return err("WRONG_TYPE", `metrics.${key} must be a finite number`, `metrics.${key}`);
    }
    if (kind === "int" && !Number.isInteger(v)) {
      return err("WRONG_TYPE", `metrics.${key} must be an integer`, `metrics.${key}`);
    }
    if (v < 0) {
      return err("NEGATIVE_VALUE", `metrics.${key} must be >= 0, got ${v}`, `metrics.${key}`);
    }
    if (kind === "int" && v > JS_SAFE_INT) {
      return err("INT_OVERFLOW", `metrics.${key} must be <= 2^53-1`, `metrics.${key}`);
    }
    (out as Record<string, number>)[key] = v;
  }
  return { ok: true, value: out as MetricsV2 };
}

/** Validate the `hardware_spec` sub-object. */
function validateHardwareSpec(
  raw: unknown,
): { ok: true; value: HardwareSpecV2 } | ValidateErr {
  if (!isPlainObject(raw)) {
    return err("WRONG_TYPE", "hardware_spec must be a JSON object", "hardware_spec");
  }

  // cpu_cores
  if (!("cpu_cores" in raw)) {
    return err("MISSING_FIELD", "hardware_spec.cpu_cores is required", "hardware_spec.cpu_cores");
  }
  const cpu_cores = raw.cpu_cores;
  if (typeof cpu_cores !== "number" || !Number.isInteger(cpu_cores)) {
    return err("WRONG_TYPE", "hardware_spec.cpu_cores must be an integer", "hardware_spec.cpu_cores");
  }
  if (cpu_cores < MIN_CPU_CORES || cpu_cores > MAX_CPU_CORES) {
    return err(
      "HARDWARE_BOUND",
      `hardware_spec.cpu_cores must be in [${MIN_CPU_CORES}, ${MAX_CPU_CORES}], got ${cpu_cores}`,
      "hardware_spec.cpu_cores",
    );
  }

  // ram_gb
  if (!("ram_gb" in raw)) {
    return err("MISSING_FIELD", "hardware_spec.ram_gb is required", "hardware_spec.ram_gb");
  }
  const ram_gb = raw.ram_gb;
  if (typeof ram_gb !== "number" || !Number.isInteger(ram_gb)) {
    return err("WRONG_TYPE", "hardware_spec.ram_gb must be an integer", "hardware_spec.ram_gb");
  }
  if (ram_gb < MIN_RAM_GB || ram_gb > MAX_RAM_GB) {
    return err(
      "HARDWARE_BOUND",
      `hardware_spec.ram_gb must be in [${MIN_RAM_GB}, ${MAX_RAM_GB}], got ${ram_gb}`,
      "hardware_spec.ram_gb",
    );
  }

  // gpu_type
  if (!("gpu_type" in raw)) {
    return err("MISSING_FIELD", "hardware_spec.gpu_type is required", "hardware_spec.gpu_type");
  }
  const gpu_type = raw.gpu_type;
  if (typeof gpu_type !== "string") {
    return err("WRONG_TYPE", "hardware_spec.gpu_type must be a string", "hardware_spec.gpu_type");
  }
  if (!GPU_TYPE_SET.has(gpu_type)) {
    return err(
      "GPU_TYPE_INVALID",
      `hardware_spec.gpu_type must be one of [${GPU_TYPES.join(", ")}], got "${gpu_type}"`,
      "hardware_spec.gpu_type",
    );
  }

  // gpu_count
  if (!("gpu_count" in raw)) {
    return err("MISSING_FIELD", "hardware_spec.gpu_count is required", "hardware_spec.gpu_count");
  }
  const gpu_count = raw.gpu_count;
  if (typeof gpu_count !== "number" || !Number.isInteger(gpu_count)) {
    return err("WRONG_TYPE", "hardware_spec.gpu_count must be an integer", "hardware_spec.gpu_count");
  }
  if (gpu_count < MIN_GPU_COUNT || gpu_count > MAX_GPU_COUNT) {
    return err(
      "HARDWARE_BOUND",
      `hardware_spec.gpu_count must be in [${MIN_GPU_COUNT}, ${MAX_GPU_COUNT}], got ${gpu_count}`,
      "hardware_spec.gpu_count",
    );
  }

  // fleet_operator_pubkey + fleet_operator_signature (hex check)
  for (const [k, re, len] of [
    ["fleet_operator_pubkey", HEX64, 64],
    ["fleet_operator_signature", HEX128, 128],
  ] as const) {
    const fk = `hardware_spec.${k}`;
    if (!(k in raw)) {
      return err("MISSING_FIELD", `${fk} is required`, fk);
    }
    const v = raw[k];
    if (typeof v !== "string") {
      return err("WRONG_TYPE", `${fk} must be a string`, fk);
    }
    if (!re.test(v)) {
      return err(
        "HEX_FORMAT",
        `${fk} must be exactly ${len} lowercase hex chars, got length ${v.length}`,
        fk,
      );
    }
  }

  // issued_ms
  if (!("issued_ms" in raw)) {
    return err("MISSING_FIELD", "hardware_spec.issued_ms is required", "hardware_spec.issued_ms");
  }
  const issued_ms = raw.issued_ms;
  if (typeof issued_ms !== "number" || !Number.isInteger(issued_ms)) {
    return err("WRONG_TYPE", "hardware_spec.issued_ms must be an integer", "hardware_spec.issued_ms");
  }
  if (issued_ms <= 0) {
    return err("PERIOD_INVALID", "hardware_spec.issued_ms must be > 0", "hardware_spec.issued_ms");
  }

  return {
    ok: true,
    value: {
      cpu_cores,
      ram_gb,
      gpu_type: gpu_type as GpuType,
      gpu_count,
      fleet_operator_pubkey: raw.fleet_operator_pubkey as string,
      fleet_operator_signature: raw.fleet_operator_signature as string,
      issued_ms,
    },
  };
}

/** Validate the optional `observer` sub-object. */
function validateObserver(
  raw: unknown,
): { ok: true; value: ObserverV2 } | ValidateErr {
  if (!isPlainObject(raw)) {
    return err("WRONG_TYPE", "observer must be a JSON object", "observer");
  }
  if (!("observer_pubkey" in raw)) {
    return err("MISSING_FIELD", "observer.observer_pubkey is required", "observer.observer_pubkey");
  }
  if (!("observer_signature" in raw)) {
    return err("MISSING_FIELD", "observer.observer_signature is required", "observer.observer_signature");
  }
  const pk = raw.observer_pubkey;
  const sg = raw.observer_signature;
  if (typeof pk !== "string") {
    return err("WRONG_TYPE", "observer.observer_pubkey must be a string", "observer.observer_pubkey");
  }
  if (typeof sg !== "string") {
    return err("WRONG_TYPE", "observer.observer_signature must be a string", "observer.observer_signature");
  }
  if (!HEX64.test(pk)) {
    return err(
      "HEX_FORMAT",
      `observer.observer_pubkey must be exactly 64 lowercase hex chars, got length ${pk.length}`,
      "observer.observer_pubkey",
    );
  }
  if (!HEX128.test(sg)) {
    return err(
      "HEX_FORMAT",
      `observer.observer_signature must be exactly 128 lowercase hex chars, got length ${sg.length}`,
      "observer.observer_signature",
    );
  }
  return { ok: true, value: { observer_pubkey: pk, observer_signature: sg } };
}

/**
 * Verify a single sr25519 signature. Returns true on valid; false on either
 * verify-failed or any thrown error from the underlying util-crypto helper
 * (malformed pubkey/sig is the most common throw).
 */
function verifySr25519(
  message: Uint8Array,
  signatureHex: string,
  pubkeyHex: string,
): boolean {
  try {
    const result = signatureVerify(
      message,
      hexToU8a("0x" + signatureHex),
      u8aToHex(hexToU8a("0x" + pubkeyHex)),
    );
    return result.isValid;
  } catch {
    return false;
  }
}

/**
 * Validate a parsed JSON object against the `compute_metering_v2` schema.
 *
 * Returns `{ ok: true, record, content_hash, schema_hash, worker_pre_image,
 * fleet_op_pre_image }` on success or `{ ok: false, code, message, field? }`
 * on failure. The validator never throws on input shape — every failure mode
 * is captured as a `ValidateErr`.
 */
export function validateComputeMeteringV2(
  raw: unknown,
  opts: ValidateOptions = {},
): ValidateResult {
  const nowMs = opts.now_ms ?? Date.now();
  const lastPeriodStartMs = opts.last_period_start_ms ?? 0;
  const verifySigs = opts.verify_signatures ?? true;

  if (!isPlainObject(raw)) {
    return err("WRONG_TYPE", "expected JSON object at root");
  }
  const r = raw;

  // --- schema_version ---
  if (!("schema_version" in r)) {
    return err("MISSING_FIELD", "schema_version is required", "schema_version");
  }
  if (typeof r.schema_version !== "string") {
    return err("WRONG_TYPE", "schema_version must be a string", "schema_version");
  }
  if (r.schema_version !== SCHEMA_VERSION) {
    return err(
      "WRONG_SCHEMA_VERSION",
      `schema_version must be exactly "${SCHEMA_VERSION}", got "${r.schema_version}"`,
      "schema_version",
    );
  }

  // --- worker_id (looser regex than tenant_id) ---
  if (!("worker_id" in r)) {
    return err("MISSING_FIELD", "worker_id is required", "worker_id");
  }
  if (typeof r.worker_id !== "string") {
    return err("WRONG_TYPE", "worker_id must be a string", "worker_id");
  }
  if (!WORKER_ID_REGEX.test(r.worker_id)) {
    return err(
      "ID_FORMAT",
      "worker_id must be 1-128 UTF-8 chars with no spaces or commas",
      "worker_id",
    );
  }
  const workerId = r.worker_id;

  // --- tenant_id (strict regex) ---
  if (!("tenant_id" in r)) {
    return err("MISSING_FIELD", "tenant_id is required", "tenant_id");
  }
  if (typeof r.tenant_id !== "string") {
    return err("WRONG_TYPE", "tenant_id must be a string", "tenant_id");
  }
  if (!ID_REGEX.test(r.tenant_id)) {
    return err(
      "ID_FORMAT",
      `tenant_id must match [a-z0-9-]{4,64}, got "${r.tenant_id}"`,
      "tenant_id",
    );
  }
  const tenantId = r.tenant_id;

  // --- period_start_ms ---
  if (!("period_start_ms" in r)) {
    return err("MISSING_FIELD", "period_start_ms is required", "period_start_ms");
  }
  if (typeof r.period_start_ms !== "number" || !Number.isInteger(r.period_start_ms)) {
    return err("WRONG_TYPE", "period_start_ms must be an integer", "period_start_ms");
  }
  if (r.period_start_ms <= 0) {
    return err("PERIOD_INVALID", "period_start_ms must be > 0", "period_start_ms");
  }
  const periodStartMs = r.period_start_ms;

  // --- period_end_ms ---
  if (!("period_end_ms" in r)) {
    return err("MISSING_FIELD", "period_end_ms is required", "period_end_ms");
  }
  if (typeof r.period_end_ms !== "number" || !Number.isInteger(r.period_end_ms)) {
    return err("WRONG_TYPE", "period_end_ms must be an integer", "period_end_ms");
  }
  const periodEndMs = r.period_end_ms;
  if (periodEndMs <= periodStartMs) {
    return err("PERIOD_INVALID", "period_end_ms must be > period_start_ms", "period_end_ms");
  }
  if (periodEndMs - periodStartMs > MAX_PERIOD_MS) {
    return err(
      "PERIOD_INVALID",
      `period (period_end_ms - period_start_ms) must be <= ${MAX_PERIOD_MS} ms (24 h)`,
      "period_end_ms",
    );
  }
  if (periodEndMs > nowMs + FUTURE_SKEW_MS) {
    return err(
      "PERIOD_INVALID",
      `period_end_ms is too far in the future (skew > ${FUTURE_SKEW_MS} ms)`,
      "period_end_ms",
    );
  }

  // --- monotonic per-worker ---
  if (periodStartMs < lastPeriodStartMs) {
    return err(
      "MONOTONIC_VIOLATION",
      `period_start_ms ${periodStartMs} < last observed ${lastPeriodStartMs} for ${workerId}`,
      "period_start_ms",
    );
  }

  // --- metrics ---
  if (!("metrics" in r)) {
    return err("MISSING_FIELD", "metrics is required", "metrics");
  }
  const mRes = validateMetrics(r.metrics);
  if (!mRes.ok) return mRes;
  const metrics = mRes.value;

  // --- hardware_spec ---
  if (!("hardware_spec" in r)) {
    return err("MISSING_FIELD", "hardware_spec is required", "hardware_spec");
  }
  const hsRes = validateHardwareSpec(r.hardware_spec);
  if (!hsRes.ok) return hsRes;
  const hardwareSpec = hsRes.value;

  // --- worker_pubkey / worker_signature (hex) ---
  for (const [k, re, len] of [
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
        `${k} must be exactly ${len} lowercase hex chars, got length ${v.length}`,
        k,
      );
    }
  }
  const workerPubkey = r.worker_pubkey as string;
  const workerSignature = r.worker_signature as string;

  // --- observer (optional) ---
  let observer: ObserverV2 | undefined;
  if ("observer" in r && r.observer !== undefined && r.observer !== null) {
    const obRes = validateObserver(r.observer);
    if (!obRes.ok) return obRes;
    observer = obRes.value;
  }

  // --- bound checks (rules 4, 5, 6) ---
  // Rule 4: cpu_seconds <= cpu_cores × period_seconds × JITTER
  // Rule 5: ram_gb_hours <= ram_gb × period_hours × JITTER
  // Rule 6: gpu_seconds = 0 if gpu_type == "none" OR gpu_count == 0
  // (Per-period jitter is computed in float64; the numeric stability of these
  // multiplications is fine for the realistic input range.)
  const periodSec = (periodEndMs - periodStartMs) / 1000;
  const periodHr = (periodEndMs - periodStartMs) / 3_600_000;
  const cpuCap = hardwareSpec.cpu_cores * periodSec * JITTER_FACTOR;
  const ramCap = hardwareSpec.ram_gb * periodHr * JITTER_FACTOR;
  if (metrics.cpu_seconds > cpuCap) {
    return err(
      "BOUND_EXCEEDED",
      `metrics.cpu_seconds ${metrics.cpu_seconds} exceeds hardware cap ${cpuCap} (${hardwareSpec.cpu_cores} cores × ${periodSec}s × ${JITTER_FACTOR})`,
      "metrics.cpu_seconds",
    );
  }
  if (metrics.ram_gb_hours > ramCap) {
    return err(
      "BOUND_EXCEEDED",
      `metrics.ram_gb_hours ${metrics.ram_gb_hours} exceeds hardware cap ${ramCap} (${hardwareSpec.ram_gb} GB × ${periodHr}h × ${JITTER_FACTOR})`,
      "metrics.ram_gb_hours",
    );
  }
  if (
    (hardwareSpec.gpu_type === "none" || hardwareSpec.gpu_count === 0) &&
    metrics.gpu_seconds !== 0
  ) {
    return err(
      "GPU_COUNT_MISMATCH",
      `metrics.gpu_seconds must be 0 when gpu_type="${hardwareSpec.gpu_type}" or gpu_count=${hardwareSpec.gpu_count}`,
      "metrics.gpu_seconds",
    );
  }

  // --- assemble typed record ---
  const record: ComputeMeteringV2 = observer
    ? {
        schema_version: SCHEMA_VERSION,
        worker_id: workerId,
        tenant_id: tenantId,
        period_start_ms: periodStartMs,
        period_end_ms: periodEndMs,
        metrics,
        hardware_spec: hardwareSpec,
        worker_pubkey: workerPubkey,
        worker_signature: workerSignature,
        observer,
      }
    : {
        schema_version: SCHEMA_VERSION,
        worker_id: workerId,
        tenant_id: tenantId,
        period_start_ms: periodStartMs,
        period_end_ms: periodEndMs,
        metrics,
        hardware_spec: hardwareSpec,
        worker_pubkey: workerPubkey,
        worker_signature: workerSignature,
      };

  // --- canonical pre-images ---
  const fleetOpPreImage = canonicalCborForFleetOpSig(workerId, hardwareSpec);
  const workerPreImage = canonicalCborForWorkerSig({
    schema_version: SCHEMA_VERSION,
    worker_id: workerId,
    tenant_id: tenantId,
    period_start_ms: periodStartMs,
    period_end_ms: periodEndMs,
    metrics,
    hardware_spec: hardwareSpec,
    worker_pubkey: workerPubkey,
  });

  // --- signature verifications (rules 7, 8, 9) ---
  if (verifySigs) {
    if (
      !verifySr25519(
        fleetOpPreImage,
        hardwareSpec.fleet_operator_signature,
        hardwareSpec.fleet_operator_pubkey,
      )
    ) {
      return err(
        "FLEET_OP_SIGNATURE_INVALID",
        "fleet_operator_signature does not verify against fleet_operator_pubkey",
        "hardware_spec.fleet_operator_signature",
      );
    }
    if (!verifySr25519(workerPreImage, workerSignature, workerPubkey)) {
      return err(
        "WORKER_SIGNATURE_INVALID",
        "worker_signature does not verify against worker_pubkey",
        "worker_signature",
      );
    }
    if (observer) {
      if (
        !verifySr25519(
          workerPreImage,
          observer.observer_signature,
          observer.observer_pubkey,
        )
      ) {
        return err(
          "OBSERVER_SIGNATURE_INVALID",
          "observer_signature does not verify against observer_pubkey over the worker pre-image",
          "observer.observer_signature",
        );
      }
    }
  }

  const contentHash = createHash("sha256").update(workerPreImage).digest("hex");
  return {
    ok: true,
    record,
    content_hash: contentHash,
    schema_hash: SCHEMA_HASH_HEX,
    worker_pre_image: workerPreImage,
    fleet_op_pre_image: fleetOpPreImage,
  };
}

/**
 * Convenience: derive an SS58 address (Substrate generic, prefix 42 by
 * default) from a 64-char lowercase hex sr25519 pubkey. Used by the gateway
 * route to attribute the upstream sponsored-receipt to the worker's account.
 */
export function workerPubkeyToSs58(workerPubkey: string, prefix = 42): string {
  if (!HEX64.test(workerPubkey)) {
    throw new TypeError(
      `workerPubkeyToSs58: expected 64 lowercase hex, got "${workerPubkey}"`,
    );
  }
  return encodeAddress(hexToU8a("0x" + workerPubkey), prefix);
}
