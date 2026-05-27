/**
 * Canonical CBOR encoder for the ai_capability_observation_v1 schema.
 *
 * Mirrors the Python encoder in
 * `orynq-observe/src/orynq_observe/canonical.py` byte-for-byte. The pinned
 * rules:
 *
 *   - Definite-length, RFC 8949 §4.2.1 sorted map keys.
 *   - Shortest CBOR head for unsigned ints (major 0) and lengths.
 *   - float64 ALWAYS (8 bytes, never shortened) — Python's struct.pack(">d")
 *     does not shorten so we don't either.
 *   - byte-strings (major 2) for raw 32/64-byte fields.
 *   - bool is REJECTED (TS doesn't have the same coercion issue Python has,
 *     but for byte-equality with Python we forbid it too).
 *   - Map keys are sorted on encoded-key bytes (matches Python).
 */

import { createHash } from "node:crypto";

/** Schema literal — wire-pinned. */
export const SCHEMA_VERSION = "ai_capability_observation_v1" as const;

/** SHA-256 of the schema literal — what `submit_receipt_v2(schema_hash)` uses. */
export const SCHEMA_HASH_HEX = createHash("sha256")
  .update(SCHEMA_VERSION)
  .digest("hex");

/** Severity discriminant order — PINNED. New severities go at the tail. */
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** TEE attestation tier strings the runtime understands. */
export const KNOWN_TEE_TIERS = [
  "Acurast",
  "AMD_SEV_SNP",
  "Intel_TDX",
  "ARM_TrustZone",
  "ReproducibleBuild",
  "None",
] as const;

// --------------------------------------------------------------------------- //
// Tagged CBOR values
// --------------------------------------------------------------------------- //

interface CborInt {
  type: "int";
  value: number | bigint;
}
interface CborFloat {
  type: "float";
  value: number;
}
interface CborText {
  type: "text";
  value: string;
}
interface CborBytes {
  type: "bytes";
  value: Uint8Array;
}
interface CborArray {
  type: "array";
  value: CborValue[];
}
interface CborMap {
  type: "map";
  value: Array<[string, CborValue]>;
}
interface CborNull {
  type: "null";
}

type CborValue =
  | CborInt
  | CborFloat
  | CborText
  | CborBytes
  | CborArray
  | CborMap
  | CborNull;

function cborInt(v: number | bigint): CborValue {
  if (typeof v === "boolean") {
    throw new TypeError("cborInt: bool is not permitted");
  }
  if (typeof v !== "number" && typeof v !== "bigint") {
    throw new TypeError(`cborInt: not an int: ${typeof v}`);
  }
  if (typeof v === "number" && !Number.isInteger(v)) {
    throw new TypeError(`cborInt: not an integer: ${v}`);
  }
  return { type: "int", value: v };
}

function cborText(v: string): CborValue {
  if (typeof v !== "string") {
    throw new TypeError(`cborText: not a string: ${typeof v}`);
  }
  return { type: "text", value: v };
}

function cborBytes(v: Uint8Array): CborValue {
  if (!(v instanceof Uint8Array)) {
    throw new TypeError(`cborBytes: not Uint8Array`);
  }
  return { type: "bytes", value: v };
}

function cborArray(items: CborValue[]): CborValue {
  return { type: "array", value: items };
}

function cborMap(pairs: Array<[string, CborValue]>): CborValue {
  return { type: "map", value: pairs };
}

function cborNull(): CborValue {
  return { type: "null" };
}

// --------------------------------------------------------------------------- //
// Low-level encoder primitives
// --------------------------------------------------------------------------- //

function encodeUint(major: number, n: number | bigint): Uint8Array {
  const N = typeof n === "bigint" ? n : BigInt(n);
  if (N < 0n) throw new TypeError(`encodeUint: out of range: ${N}`);
  if (N <= 23n) return new Uint8Array([(major << 5) | Number(N)]);
  if (N <= 0xffn) return new Uint8Array([(major << 5) | 24, Number(N)]);
  if (N <= 0xffffn) {
    const buf = new Uint8Array(3);
    buf[0] = (major << 5) | 25;
    new DataView(buf.buffer).setUint16(1, Number(N), false);
    return buf;
  }
  if (N <= 0xffffffffn) {
    const buf = new Uint8Array(5);
    buf[0] = (major << 5) | 26;
    new DataView(buf.buffer).setUint32(1, Number(N), false);
    return buf;
  }
  if (N > 0xffffffffffffffffn) {
    throw new TypeError(`encodeUint: exceeds 64-bit unsigned: ${N}`);
  }
  const buf = new Uint8Array(9);
  buf[0] = (major << 5) | 27;
  new DataView(buf.buffer).setBigUint64(1, N, false);
  return buf;
}

function encodeInt(n: number | bigint): Uint8Array {
  const N = typeof n === "bigint" ? n : BigInt(n);
  if (N >= 0n) return encodeUint(0, N);
  return encodeUint(1, -1n - N);
}

function encodeFloat64(n: number): Uint8Array {
  if (typeof n !== "number") throw new TypeError("encodeFloat64: not a number");
  if (Number.isNaN(n)) throw new TypeError("encodeFloat64: NaN not permitted");
  if (n === Infinity || n === -Infinity) {
    throw new TypeError("encodeFloat64: Infinity not permitted");
  }
  const buf = new Uint8Array(9);
  buf[0] = (7 << 5) | 27;
  new DataView(buf.buffer).setFloat64(1, n, false);
  return buf;
}

const _UTF8 = new TextEncoder();

function encodeText(s: string): Uint8Array {
  const utf8 = _UTF8.encode(s);
  const head = encodeUint(3, utf8.length);
  return concat(head, utf8);
}

function encodeBytes(b: Uint8Array): Uint8Array {
  const head = encodeUint(2, b.length);
  return concat(head, b);
}

function encodeNull(): Uint8Array {
  return new Uint8Array([0xf6]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function encodeCbor(val: CborValue): Uint8Array {
  switch (val.type) {
    case "int":
      return encodeInt(val.value);
    case "float":
      return encodeFloat64(val.value);
    case "text":
      return encodeText(val.value);
    case "bytes":
      return encodeBytes(val.value);
    case "null":
      return encodeNull();
    case "array": {
      const head = encodeUint(4, val.value.length);
      const items = val.value.map(encodeCbor);
      return concat(head, ...items);
    }
    case "map": {
      const encoded = val.value.map(([k, v]) => ({
        key: encodeText(k),
        value: encodeCbor(v),
      }));
      encoded.sort((a, b) => compareBytes(a.key, b.key));
      const head = encodeUint(5, encoded.length);
      return concat(head, ...encoded.flatMap((p) => [p.key, p.value]));
    }
  }
}

// --------------------------------------------------------------------------- //
// Helpers for the AI capability observation shape
// --------------------------------------------------------------------------- //

function hexToBytes(value: unknown, length: number, field: string): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length !== length) {
      throw new TypeError(
        `${field} must be ${length}-byte bytes, got ${value.length}`,
      );
    }
    return value;
  }
  if (typeof value === "string") {
    const s = value.startsWith("0x") ? value.slice(2) : value;
    if (s.length !== length * 2) {
      throw new TypeError(
        `${field} hex must be ${length * 2} chars, got ${s.length}`,
      );
    }
    if (!/^[0-9a-fA-F]+$/.test(s)) {
      throw new TypeError(`${field} hex contains non-hex characters`);
    }
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  throw new TypeError(`${field} must be bytes or hex string, got ${typeof value}`);
}

interface ModelInput {
  name: string;
  version: string;
  hash?: string | Uint8Array | null;
}

interface CapabilityInput {
  taxonomyId: string;
  severity: Severity;
}

interface ObservationInput {
  promptHash: string | Uint8Array;
  responseHash: string | Uint8Array;
  artifactRef?: string | null;
  occurredAt: number;
}

interface TeeAttestationInput {
  tier: string;
  evidence: string | Uint8Array;
}

interface ObserverInput {
  ss58: string;
  context: string;
  teeAttestation?: TeeAttestationInput | null;
}

/** Public record shape — same field names as the wire spec in the task description. */
export interface AiCapabilityObservationRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  model: ModelInput;
  capability: CapabilityInput;
  observation: ObservationInput;
  observer: ObserverInput;
}

function modelToCbor(model: ModelInput): CborValue {
  if (!model || typeof model !== "object") {
    throw new TypeError("model must be an object");
  }
  if (typeof model.name !== "string" || !model.name) {
    throw new TypeError("model.name must be a non-empty string");
  }
  if (typeof model.version !== "string" || !model.version) {
    throw new TypeError("model.version must be a non-empty string");
  }
  let hashVal: CborValue;
  if (model.hash === undefined || model.hash === null) {
    hashVal = cborNull();
  } else {
    hashVal = cborBytes(hexToBytes(model.hash, 32, "model.hash"));
  }
  return cborMap([
    ["hash", hashVal],
    ["name", cborText(model.name)],
    ["version", cborText(model.version)],
  ]);
}

function capabilityToCbor(capability: CapabilityInput): CborValue {
  if (!capability || typeof capability !== "object") {
    throw new TypeError("capability must be an object");
  }
  if (typeof capability.taxonomyId !== "string" || !capability.taxonomyId) {
    throw new TypeError("capability.taxonomyId must be a non-empty string");
  }
  if (!SEVERITIES.includes(capability.severity)) {
    throw new TypeError(
      `capability.severity must be one of ${SEVERITIES.join(",")}, got ${capability.severity}`,
    );
  }
  return cborMap([
    ["severity", cborText(capability.severity)],
    ["taxonomyId", cborText(capability.taxonomyId)],
  ]);
}

function observationToCbor(observation: ObservationInput): CborValue {
  if (!observation || typeof observation !== "object") {
    throw new TypeError("observation must be an object");
  }
  const promptHash = hexToBytes(
    observation.promptHash,
    32,
    "observation.promptHash",
  );
  const responseHash = hexToBytes(
    observation.responseHash,
    32,
    "observation.responseHash",
  );
  const occurredAt = observation.occurredAt;
  if (typeof occurredAt !== "number" || !Number.isInteger(occurredAt)) {
    throw new TypeError("observation.occurredAt must be an integer (unix ms)");
  }
  if (occurredAt < 0) {
    throw new TypeError("observation.occurredAt must be >= 0");
  }
  let artifactVal: CborValue;
  const ar = observation.artifactRef;
  if (ar === undefined || ar === null) {
    artifactVal = cborNull();
  } else if (typeof ar === "string") {
    if (ar.length === 0) {
      throw new TypeError(
        "observation.artifactRef must be a non-empty string when set",
      );
    }
    artifactVal = cborText(ar);
  } else {
    throw new TypeError(
      `observation.artifactRef must be string or null, got ${typeof ar}`,
    );
  }
  return cborMap([
    ["artifactRef", artifactVal],
    ["occurredAt", cborInt(occurredAt)],
    ["promptHash", cborBytes(promptHash)],
    ["responseHash", cborBytes(responseHash)],
  ]);
}

function teeAttestationToCbor(
  tee: TeeAttestationInput | null | undefined,
): CborValue {
  if (tee === null || tee === undefined) return cborNull();
  if (typeof tee !== "object") {
    throw new TypeError("observer.teeAttestation must be object or null");
  }
  if (typeof tee.tier !== "string" || !tee.tier) {
    throw new TypeError("observer.teeAttestation.tier must be a non-empty string");
  }
  let evBytes: Uint8Array;
  if (tee.evidence instanceof Uint8Array) {
    evBytes = tee.evidence;
  } else if (typeof tee.evidence === "string") {
    const s = tee.evidence.startsWith("0x")
      ? tee.evidence.slice(2)
      : tee.evidence;
    if (!/^[0-9a-fA-F]*$/.test(s)) {
      throw new TypeError("observer.teeAttestation.evidence hex is invalid");
    }
    evBytes = new Uint8Array(s.length / 2);
    for (let i = 0; i < evBytes.length; i++) {
      evBytes[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    }
  } else {
    throw new TypeError(
      "observer.teeAttestation.evidence must be bytes or hex string",
    );
  }
  return cborMap([
    ["evidence", cborBytes(evBytes)],
    ["tier", cborText(tee.tier)],
  ]);
}

function observerToCbor(observer: ObserverInput): CborValue {
  if (!observer || typeof observer !== "object") {
    throw new TypeError("observer must be an object");
  }
  if (typeof observer.ss58 !== "string" || !observer.ss58) {
    throw new TypeError("observer.ss58 must be a non-empty string");
  }
  if (typeof observer.context !== "string") {
    throw new TypeError("observer.context must be a string");
  }
  return cborMap([
    ["context", cborText(observer.context)],
    ["ss58", cborText(observer.ss58)],
    ["teeAttestation", teeAttestationToCbor(observer.teeAttestation)],
  ]);
}

/**
 * Encode an ai_capability_observation_v1 record to canonical CBOR bytes.
 *
 * The wire shape (matches Python encoder byte-for-byte):
 *
 *     [ "ai_capability_observation_v1",
 *       model       (map),
 *       capability  (map),
 *       observation (map),
 *       observer    (map),
 *     ]
 */
export function canonicalCbor(
  record: AiCapabilityObservationRecord,
): Uint8Array {
  if (!record || typeof record !== "object") {
    throw new TypeError("record must be an object");
  }
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new TypeError(
      `schemaVersion must be ${SCHEMA_VERSION}, got ${record.schemaVersion}`,
    );
  }
  for (const k of ["model", "capability", "observation", "observer"] as const) {
    if (!(k in record)) {
      throw new TypeError(`record.${k} is required`);
    }
  }
  const elements: CborValue[] = [
    cborText(SCHEMA_VERSION),
    modelToCbor(record.model),
    capabilityToCbor(record.capability),
    observationToCbor(record.observation),
    observerToCbor(record.observer),
  ];
  return encodeCbor(cborArray(elements));
}

/** SHA-256 hex of canonical_cbor(record). */
export function canonicalContentHash(
  record: AiCapabilityObservationRecord,
): string {
  return createHash("sha256").update(canonicalCbor(record)).digest("hex");
}
