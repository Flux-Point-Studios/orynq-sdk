/**
 * `ai_capability_observation_v1` — cryptographically-verifiable schema for
 * attested AI model observations.
 *
 * An observation captures: which model, which observed capability, hashes of
 * the prompt + response that triggered the observation, who observed it, and
 * (optionally) a TEE attestation binding the observation to attested hardware.
 *
 * --- Wire format vs canonical pre-image ---
 *
 * The HTTP wire format is JSON with hex strings for hashes/evidence and base58
 * SS58 for observer identity. The CANONICAL CBOR pre-image used for signing /
 * anchoring uses RAW BYTES (CBOR major type 2) for hashes and TEE evidence,
 * UTF-8 text for IDs and SS58 strings, and CBOR null (`0xf6`) for nullable
 * fields explicitly set to null.
 *
 * --- Canonical CBOR rules (RFC 8949 §4.2.1, distilled to what we use) ---
 *
 *   - Definite-length encoding only.
 *   - Shortest possible integer head per RFC 8949 §3.1.
 *   - Map keys sorted by encoded-byte lexicographic order.
 *   - Strings: UTF-8, major type 3.
 *   - Byte strings: major type 2 (hashes, TEE evidence in pre-images).
 *   - Arrays: major type 4 (top-level positional pre-image tuple).
 *   - Maps: major type 5.
 *   - Null: major type 7, additional 22 (single byte `0xf6`). Encodes a
 *     nullable field set to `null`. Required for cross-language byte-equality
 *     when an optional sub-tree (model.hash, observation.artifactRef, or
 *     observer.teeAttestation) is absent.
 *
 * --- Pre-image (PINNED — coordinated with the Python encoder) ---
 *
 *   [ "ai_capability_observation_v1", model_map, capability_map,
 *     observation_map, observer_map ]
 *
 *   model_map         { hash: bytes32 | null, name: text, version: text }
 *   capability_map    { severity: text, taxonomyId: text }
 *   observation_map   { artifactRef: text | null, occurredAt: text,
 *                       promptHash: bytes32, responseHash: bytes32 }
 *   observer_map      { context: text, ss58: text,
 *                       teeAttestation: { evidence: bytes, tier: text } | null }
 *
 * Cross-language byte-equality with the Python encoder is enforced by
 * `python/tests/test_ai_capability_observation_v1_cross_lang.py`.
 */

import { createHash } from "node:crypto";
import { hexToU8a } from "@polkadot/util";

/** Exact schema-version literal. Anything else = reject. */
export const SCHEMA_VERSION = "ai_capability_observation_v1";

/** sha256 of the schema-version string — used as `schema_hash` upstream. */
export const SCHEMA_HASH_HEX = createHash("sha256")
  .update(SCHEMA_VERSION, "utf-8")
  .digest("hex");

/** Permitted TEE tiers. Order is informational; comparison is by membership. */
export const TEE_TIERS = ["ARM-TZ", "Acurast", "SEV-SNP", "build"] as const;
export type TeeTier = (typeof TEE_TIERS)[number];
const TEE_TIER_SET: ReadonlySet<string> = new Set<string>(TEE_TIERS);

/** Permitted severity levels (ascending). */
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
const SEVERITY_SET: ReadonlySet<string> = new Set<string>(SEVERITIES);

/** observer.context length ceiling (chars, not bytes — matches the spec). */
export const MAX_CONTEXT_LEN = 280;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX_EVIDENCE = /^[0-9a-f]+$/;
/**
 * RFC 3339 / ISO 8601 with a `Z` UTC suffix. Optional fractional seconds.
 * Examples: `2026-01-15T12:34:56Z`, `2026-01-15T12:34:56.789Z`.
 * Local-time offsets are intentionally NOT accepted — observations are
 * recorded in UTC end-to-end so anchored timestamps don't depend on the
 * observer's local clock format.
 */
const OCCURRED_AT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
/**
 * SS58 addresses are base58 over a {prefix-byte || 32-byte pubkey || 2-byte
 * checksum} payload. Length depends on prefix size; for the network prefixes
 * we use (1 byte) the encoded length is 47-48 chars. This regex is a loose
 * sanity check on the alphabet + length; cryptographic verification is the
 * cert-daemon's job.
 */
const SS58_RE = /^[1-9A-HJ-NP-Za-km-z]{46,50}$/;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface ModelV1 {
  name: string;
  version: string;
  /** sha256 hex of the model-weights hash; null if unknown. */
  hash: string | null;
}

export interface CapabilityV1 {
  taxonomyId: string;
  severity: Severity;
}

export interface ObservationV1 {
  /** sha256 hex of the prompt. */
  promptHash: string;
  /** sha256 hex of the model response. */
  responseHash: string;
  /** URL / IPFS CID / blob hash referencing the full transcript; null if absent. */
  artifactRef: string | null;
  /** ISO 8601 UTC timestamp (e.g. "2026-01-15T12:34:56Z"). */
  occurredAt: string;
}

export interface TeeAttestationV1 {
  tier: TeeTier;
  /** Hex-encoded TEE evidence blob (variable length). */
  evidence: string;
}

export interface ObserverV1 {
  /** Materios SS58 address. */
  ss58: string;
  /** Brief human-readable context (≤ 280 chars). */
  context: string;
  teeAttestation: TeeAttestationV1 | null;
}

export interface AiCapabilityObservationV1 {
  schemaVersion: typeof SCHEMA_VERSION;
  model: ModelV1;
  capability: CapabilityV1;
  observation: ObservationV1;
  observer: ObserverV1;
}

// ---------------------------------------------------------------------------
// Validation result types
// ---------------------------------------------------------------------------

export type ValidateErrorCode =
  | "WRONG_TYPE"
  | "MISSING_FIELD"
  | "WRONG_SCHEMA_VERSION"
  | "HEX_FORMAT"
  | "TEE_TIER_INVALID"
  | "SEVERITY_INVALID"
  | "CONTEXT_TOO_LONG"
  | "OCCURRED_AT_INVALID"
  | "SS58_FORMAT"
  | "TAXONOMY_ID_FORMAT"
  | "MODEL_NAME_FORMAT";

export interface ValidateOk {
  ok: true;
  record: AiCapabilityObservationV1;
  /** SHA-256 hex of the canonical CBOR pre-image. */
  contentHash: string;
  /** SHA-256 hex of the schema-version literal. */
  schemaHash: string;
  /** Canonical CBOR bytes the cert-daemon committee signs. */
  preImage: Uint8Array;
}

export interface ValidateErr {
  ok: false;
  code: ValidateErrorCode;
  message: string;
  field?: string;
}

export type ValidateResult = ValidateOk | ValidateErr;

// ---------------------------------------------------------------------------
// Canonical CBOR encoder.
//
// Same primitives as `services` schemas (RFC 8949 §4.2.1) with one extension:
// CBOR null (major 7 additional 22) for nullable sub-trees.
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
  if (n > Number.MAX_SAFE_INTEGER) {
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

/** CBOR null primitive (major 7, additional 22). */
const CBOR_NULL = Uint8Array.of(0xf6);

type CborValue =
  | { type: "text"; v: string }
  | { type: "bytes"; v: Uint8Array }
  | { type: "null" }
  | { type: "array"; v: CborValue[] }
  | { type: "map"; v: Array<[string, CborValue]> };

const cText = (v: string): CborValue => ({ type: "text", v });
const cBytes = (v: Uint8Array): CborValue => ({ type: "bytes", v });
const cNull = (): CborValue => ({ type: "null" });
const cArray = (v: CborValue[]): CborValue => ({ type: "array", v });
const cMap = (v: Array<[string, CborValue]>): CborValue => ({ type: "map", v });

function encodeCbor(val: CborValue): Uint8Array {
  switch (val.type) {
    case "text":
      return encodeText(val.v);
    case "bytes":
      return encodeBytes(val.v);
    case "null":
      return CBOR_NULL;
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

// ---------------------------------------------------------------------------
// Pre-image builders
// ---------------------------------------------------------------------------

function hexOrNullToCbor(hex: string | null): CborValue {
  return hex === null ? cNull() : cBytes(hexToU8a("0x" + hex));
}

function textOrNullToCbor(s: string | null): CborValue {
  return s === null ? cNull() : cText(s);
}

function modelToCbor(m: ModelV1): CborValue {
  return cMap([
    ["hash", hexOrNullToCbor(m.hash)],
    ["name", cText(m.name)],
    ["version", cText(m.version)],
  ]);
}

function capabilityToCbor(c: CapabilityV1): CborValue {
  return cMap([
    ["severity", cText(c.severity)],
    ["taxonomyId", cText(c.taxonomyId)],
  ]);
}

function observationToCbor(o: ObservationV1): CborValue {
  return cMap([
    ["artifactRef", textOrNullToCbor(o.artifactRef)],
    ["occurredAt", cText(o.occurredAt)],
    ["promptHash", cBytes(hexToU8a("0x" + o.promptHash))],
    ["responseHash", cBytes(hexToU8a("0x" + o.responseHash))],
  ]);
}

function teeToCbor(t: TeeAttestationV1 | null): CborValue {
  if (t === null) return cNull();
  return cMap([
    ["evidence", cBytes(hexToU8a("0x" + t.evidence))],
    ["tier", cText(t.tier)],
  ]);
}

function observerToCbor(o: ObserverV1): CborValue {
  return cMap([
    ["context", cText(o.context)],
    ["ss58", cText(o.ss58)],
    ["teeAttestation", teeToCbor(o.teeAttestation)],
  ]);
}

/**
 * Build the canonical CBOR bytes for an `ai_capability_observation_v1`
 * record. These bytes are what the cert-daemon committee signs and what
 * downstream verifiers reproduce locally to check signatures.
 */
export function canonicalCborPreImage(
  rec: AiCapabilityObservationV1,
): Uint8Array {
  return encodeCbor(
    cArray([
      cText(SCHEMA_VERSION),
      modelToCbor(rec.model),
      capabilityToCbor(rec.capability),
      observationToCbor(rec.observation),
      observerToCbor(rec.observer),
    ]),
  );
}

/** SHA-256 hex of the canonical CBOR pre-image. */
export function canonicalContentHash(rec: AiCapabilityObservationV1): string {
  return createHash("sha256").update(canonicalCborPreImage(rec)).digest("hex");
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

function validateString(
  raw: Record<string, unknown>,
  key: string,
  fieldPath: string,
): { ok: true; value: string } | ValidateErr {
  if (!(key in raw)) {
    return err("MISSING_FIELD", `${fieldPath} is required`, fieldPath);
  }
  const v = raw[key];
  if (typeof v !== "string") {
    return err("WRONG_TYPE", `${fieldPath} must be a string`, fieldPath);
  }
  return { ok: true, value: v };
}

function validateHex64(
  raw: Record<string, unknown>,
  key: string,
  fieldPath: string,
): { ok: true; value: string } | ValidateErr {
  const r = validateString(raw, key, fieldPath);
  if (!r.ok) return r;
  if (!HEX64.test(r.value)) {
    return err(
      "HEX_FORMAT",
      `${fieldPath} must be 64 lowercase hex chars, got length ${r.value.length}`,
      fieldPath,
    );
  }
  return r;
}

function validateModel(
  raw: unknown,
): { ok: true; value: ModelV1 } | ValidateErr {
  if (!isPlainObject(raw)) {
    return err("WRONG_TYPE", "model must be a JSON object", "model");
  }
  const nameRes = validateString(raw, "name", "model.name");
  if (!nameRes.ok) return nameRes;
  if (nameRes.value.length === 0 || nameRes.value.length > 128) {
    return err(
      "MODEL_NAME_FORMAT",
      "model.name must be 1-128 chars",
      "model.name",
    );
  }
  const versionRes = validateString(raw, "version", "model.version");
  if (!versionRes.ok) return versionRes;
  if (!("hash" in raw)) {
    return err("MISSING_FIELD", "model.hash is required", "model.hash");
  }
  const hashRaw = raw.hash;
  let hash: string | null;
  if (hashRaw === null) {
    hash = null;
  } else if (typeof hashRaw !== "string") {
    return err(
      "WRONG_TYPE",
      "model.hash must be a string or null",
      "model.hash",
    );
  } else if (!HEX64.test(hashRaw)) {
    return err(
      "HEX_FORMAT",
      `model.hash must be 64 lowercase hex chars, got length ${hashRaw.length}`,
      "model.hash",
    );
  } else {
    hash = hashRaw;
  }
  return {
    ok: true,
    value: { name: nameRes.value, version: versionRes.value, hash },
  };
}

const TAXONOMY_ID_RE = /^[A-Z0-9_-]{1,64}$/;

function validateCapability(
  raw: unknown,
): { ok: true; value: CapabilityV1 } | ValidateErr {
  if (!isPlainObject(raw)) {
    return err("WRONG_TYPE", "capability must be a JSON object", "capability");
  }
  const taxRes = validateString(raw, "taxonomyId", "capability.taxonomyId");
  if (!taxRes.ok) return taxRes;
  if (!TAXONOMY_ID_RE.test(taxRes.value)) {
    return err(
      "TAXONOMY_ID_FORMAT",
      "capability.taxonomyId must match [A-Z0-9_-]{1,64}",
      "capability.taxonomyId",
    );
  }
  const sevRes = validateString(raw, "severity", "capability.severity");
  if (!sevRes.ok) return sevRes;
  if (!SEVERITY_SET.has(sevRes.value)) {
    return err(
      "SEVERITY_INVALID",
      `capability.severity must be one of [${SEVERITIES.join(", ")}], got "${sevRes.value}"`,
      "capability.severity",
    );
  }
  return {
    ok: true,
    value: {
      taxonomyId: taxRes.value,
      severity: sevRes.value as Severity,
    },
  };
}

function validateObservation(
  raw: unknown,
): { ok: true; value: ObservationV1 } | ValidateErr {
  if (!isPlainObject(raw)) {
    return err(
      "WRONG_TYPE",
      "observation must be a JSON object",
      "observation",
    );
  }
  const promptRes = validateHex64(raw, "promptHash", "observation.promptHash");
  if (!promptRes.ok) return promptRes;
  const responseRes = validateHex64(
    raw,
    "responseHash",
    "observation.responseHash",
  );
  if (!responseRes.ok) return responseRes;
  if (!("artifactRef" in raw)) {
    return err(
      "MISSING_FIELD",
      "observation.artifactRef is required",
      "observation.artifactRef",
    );
  }
  const refRaw = raw.artifactRef;
  let artifactRef: string | null;
  if (refRaw === null) {
    artifactRef = null;
  } else if (typeof refRaw !== "string") {
    return err(
      "WRONG_TYPE",
      "observation.artifactRef must be a string or null",
      "observation.artifactRef",
    );
  } else if (refRaw.length === 0 || refRaw.length > 2048) {
    return err(
      "WRONG_TYPE",
      "observation.artifactRef must be 1-2048 chars when non-null",
      "observation.artifactRef",
    );
  } else {
    artifactRef = refRaw;
  }
  const occRes = validateString(raw, "occurredAt", "observation.occurredAt");
  if (!occRes.ok) return occRes;
  if (!OCCURRED_AT_RE.test(occRes.value)) {
    return err(
      "OCCURRED_AT_INVALID",
      "observation.occurredAt must be ISO 8601 UTC (suffix Z)",
      "observation.occurredAt",
    );
  }
  return {
    ok: true,
    value: {
      promptHash: promptRes.value,
      responseHash: responseRes.value,
      artifactRef,
      occurredAt: occRes.value,
    },
  };
}

function validateTee(
  raw: unknown,
): { ok: true; value: TeeAttestationV1 } | ValidateErr {
  if (!isPlainObject(raw)) {
    return err(
      "WRONG_TYPE",
      "observer.teeAttestation must be a JSON object or null",
      "observer.teeAttestation",
    );
  }
  const tierRes = validateString(raw, "tier", "observer.teeAttestation.tier");
  if (!tierRes.ok) return tierRes;
  if (!TEE_TIER_SET.has(tierRes.value)) {
    return err(
      "TEE_TIER_INVALID",
      `observer.teeAttestation.tier must be one of [${TEE_TIERS.join(", ")}], got "${tierRes.value}"`,
      "observer.teeAttestation.tier",
    );
  }
  const evRes = validateString(
    raw,
    "evidence",
    "observer.teeAttestation.evidence",
  );
  if (!evRes.ok) return evRes;
  if (
    evRes.value.length === 0 ||
    evRes.value.length % 2 !== 0 ||
    !HEX_EVIDENCE.test(evRes.value)
  ) {
    return err(
      "HEX_FORMAT",
      "observer.teeAttestation.evidence must be non-empty lowercase hex with even length",
      "observer.teeAttestation.evidence",
    );
  }
  return {
    ok: true,
    value: { tier: tierRes.value as TeeTier, evidence: evRes.value },
  };
}

function validateObserver(
  raw: unknown,
): { ok: true; value: ObserverV1 } | ValidateErr {
  if (!isPlainObject(raw)) {
    return err("WRONG_TYPE", "observer must be a JSON object", "observer");
  }
  const ss58Res = validateString(raw, "ss58", "observer.ss58");
  if (!ss58Res.ok) return ss58Res;
  if (!SS58_RE.test(ss58Res.value)) {
    return err(
      "SS58_FORMAT",
      "observer.ss58 must be a base58 SS58 address",
      "observer.ss58",
    );
  }
  const ctxRes = validateString(raw, "context", "observer.context");
  if (!ctxRes.ok) return ctxRes;
  if (ctxRes.value.length > MAX_CONTEXT_LEN) {
    return err(
      "CONTEXT_TOO_LONG",
      `observer.context must be <= ${MAX_CONTEXT_LEN} chars, got ${ctxRes.value.length}`,
      "observer.context",
    );
  }
  if (!("teeAttestation" in raw)) {
    return err(
      "MISSING_FIELD",
      "observer.teeAttestation is required (use null when absent)",
      "observer.teeAttestation",
    );
  }
  let teeAttestation: TeeAttestationV1 | null;
  if (raw.teeAttestation === null) {
    teeAttestation = null;
  } else {
    const teeRes = validateTee(raw.teeAttestation);
    if (!teeRes.ok) return teeRes;
    teeAttestation = teeRes.value;
  }
  return {
    ok: true,
    value: {
      ss58: ss58Res.value,
      context: ctxRes.value,
      teeAttestation,
    },
  };
}

/**
 * Validate a parsed JSON object against the `ai_capability_observation_v1`
 * schema. On success, returns the typed record, the canonical content hash,
 * the schema hash, and the canonical CBOR pre-image bytes (so callers can
 * sign / anchor without re-running the encoder).
 */
export function validateAiCapabilityObservationV1(
  raw: unknown,
): ValidateResult {
  if (!isPlainObject(raw)) {
    return err("WRONG_TYPE", "expected JSON object at root");
  }
  if (!("schemaVersion" in raw)) {
    return err("MISSING_FIELD", "schemaVersion is required", "schemaVersion");
  }
  if (typeof raw.schemaVersion !== "string") {
    return err(
      "WRONG_TYPE",
      "schemaVersion must be a string",
      "schemaVersion",
    );
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    return err(
      "WRONG_SCHEMA_VERSION",
      `schemaVersion must be "${SCHEMA_VERSION}", got "${raw.schemaVersion}"`,
      "schemaVersion",
    );
  }
  if (!("model" in raw)) {
    return err("MISSING_FIELD", "model is required", "model");
  }
  const modelRes = validateModel(raw.model);
  if (!modelRes.ok) return modelRes;
  if (!("capability" in raw)) {
    return err("MISSING_FIELD", "capability is required", "capability");
  }
  const capRes = validateCapability(raw.capability);
  if (!capRes.ok) return capRes;
  if (!("observation" in raw)) {
    return err("MISSING_FIELD", "observation is required", "observation");
  }
  const obsRes = validateObservation(raw.observation);
  if (!obsRes.ok) return obsRes;
  if (!("observer" in raw)) {
    return err("MISSING_FIELD", "observer is required", "observer");
  }
  const observerRes = validateObserver(raw.observer);
  if (!observerRes.ok) return observerRes;

  const record: AiCapabilityObservationV1 = {
    schemaVersion: SCHEMA_VERSION,
    model: modelRes.value,
    capability: capRes.value,
    observation: obsRes.value,
    observer: observerRes.value,
  };
  const preImage = canonicalCborPreImage(record);
  const contentHash = createHash("sha256").update(preImage).digest("hex");
  return {
    ok: true,
    record,
    contentHash,
    schemaHash: SCHEMA_HASH_HEX,
    preImage,
  };
}
