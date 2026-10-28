import { compareBytes } from "./bytes.js";
import { MandateError } from "./errors.js";

export type CborMap = Map<CborValue, CborValue>;
export type CborValue =
  | bigint
  | boolean
  | string
  | Uint8Array
  | CborValue[]
  | CborMap;

const U64_MAX = (1n << 64n) - 1n;
const MAX_DEPTH = 32;

const MAJOR_UINT = 0;
const MAJOR_NEGATIVE = 1;
const MAJOR_BYTES = 2;
const MAJOR_TEXT = 3;
const MAJOR_ARRAY = 4;
const MAJOR_MAP = 5;
const MAJOR_TAG = 6;
const MAJOR_SIMPLE = 7;

const SIMPLE_FALSE = 20;
const SIMPLE_TRUE = 21;

function pushHeader(out: number[], major: number, argument: bigint): void {
  const m = major << 5;
  if (argument < 24n) {
    out.push(m | Number(argument));
  } else if (argument <= 0xffn) {
    out.push(m | 24, Number(argument));
  } else if (argument <= 0xffffn) {
    out.push(m | 25, Number(argument >> 8n), Number(argument & 0xffn));
  } else if (argument <= 0xffffffffn) {
    out.push(m | 26);
    for (let shift = 24n; shift >= 0n; shift -= 8n) {
      out.push(Number((argument >> shift) & 0xffn));
    }
  } else {
    out.push(m | 27);
    for (let shift = 56n; shift >= 0n; shift -= 8n) {
      out.push(Number((argument >> shift) & 0xffn));
    }
  }
}

function encodeInto(value: CborValue, out: number[], depth: number): void {
  if (depth > MAX_DEPTH) {
    throw new MandateError("CBOR_DEPTH", `nesting exceeds ${MAX_DEPTH}`);
  }
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new MandateError("CBOR_RANGE", "negative integers are forbidden");
    }
    if (value > U64_MAX) {
      throw new MandateError("CBOR_RANGE", "integer exceeds 2^64-1");
    }
    pushHeader(out, MAJOR_UINT, value);
    return;
  }
  if (typeof value === "boolean") {
    out.push((MAJOR_SIMPLE << 5) | (value ? SIMPLE_TRUE : SIMPLE_FALSE));
    return;
  }
  if (typeof value === "string") {
    if (!value.isWellFormed()) {
      throw new MandateError("CBOR_UTF8", "text contains lone surrogates");
    }
    const bytes = new TextEncoder().encode(value);
    pushHeader(out, MAJOR_TEXT, BigInt(bytes.length));
    for (const b of bytes) out.push(b);
    return;
  }
  if (value instanceof Uint8Array) {
    pushHeader(out, MAJOR_BYTES, BigInt(value.length));
    for (const b of value) out.push(b);
    return;
  }
  if (Array.isArray(value)) {
    pushHeader(out, MAJOR_ARRAY, BigInt(value.length));
    for (const item of value) encodeInto(item, out, depth + 1);
    return;
  }
  if (value instanceof Map) {
    const entries: { key: Uint8Array; value: Uint8Array }[] = [];
    for (const [k, v] of value) {
      entries.push({
        key: encodeAtDepth(k, depth + 1),
        value: encodeAtDepth(v, depth + 1),
      });
    }
    entries.sort((a, b) => compareBytes(a.key, b.key));
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1] as { key: Uint8Array };
      const curr = entries[i] as { key: Uint8Array };
      if (compareBytes(prev.key, curr.key) === 0) {
        throw new MandateError("CBOR_DUPLICATE_KEY", "duplicate map key");
      }
    }
    pushHeader(out, MAJOR_MAP, BigInt(entries.length));
    for (const e of entries) {
      for (const b of e.key) out.push(b);
      for (const b of e.value) out.push(b);
    }
    return;
  }
  throw new MandateError(
    "CBOR_TYPE",
    `unsupported value of type ${typeof value}`,
  );
}

function encodeAtDepth(value: CborValue, depth: number): Uint8Array {
  const out: number[] = [];
  encodeInto(value, out, depth);
  return Uint8Array.from(out);
}

export function cborEncode(value: CborValue): Uint8Array {
  return encodeAtDepth(value, 0);
}

class Reader {
  readonly buf: Uint8Array;
  pos = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  byte(): number {
    if (this.pos >= this.buf.length) {
      throw new MandateError("CBOR_TRUNCATED", "unexpected end of input");
    }
    return this.buf[this.pos++] as number;
  }

  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) {
      throw new MandateError("CBOR_TRUNCATED", "unexpected end of input");
    }
    const slice = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  remaining(): number {
    return this.buf.length - this.pos;
  }
}

function readArgument(r: Reader, additional: number): bigint {
  if (additional < 24) return BigInt(additional);
  if (additional === 31) {
    throw new MandateError("CBOR_INDEFINITE", "indefinite lengths forbidden");
  }
  if (additional > 27) {
    throw new MandateError("CBOR_MALFORMED", `reserved additional info ${additional}`);
  }
  const widths: Record<number, number> = { 24: 1, 25: 2, 26: 4, 27: 8 };
  const width = widths[additional] as number;
  let value = 0n;
  for (let i = 0; i < width; i++) value = (value << 8n) | BigInt(r.byte());
  const minimums: Record<number, bigint> = {
    24: 24n,
    25: 0x100n,
    26: 0x10000n,
    27: 0x100000000n,
  };
  if (value < (minimums[additional] as bigint)) {
    throw new MandateError(
      "CBOR_NONMINIMAL",
      `argument ${value} not minimally encoded`,
    );
  }
  return value;
}

function toLength(r: Reader, argument: bigint): number {
  if (argument > BigInt(r.remaining())) {
    throw new MandateError("CBOR_TRUNCATED", "declared length exceeds input");
  }
  return Number(argument);
}

function decodeItem(r: Reader, depth: number): CborValue {
  if (depth > MAX_DEPTH) {
    throw new MandateError("CBOR_DEPTH", `nesting exceeds ${MAX_DEPTH}`);
  }
  const head = r.byte();
  const major = head >> 5;
  const additional = head & 0x1f;

  switch (major) {
    case MAJOR_UINT:
      return readArgument(r, additional);
    case MAJOR_NEGATIVE:
      throw new MandateError("CBOR_FORBIDDEN", "negative integers forbidden");
    case MAJOR_BYTES: {
      const n = toLength(r, readArgument(r, additional));
      return r.bytes(n);
    }
    case MAJOR_TEXT: {
      const n = toLength(r, readArgument(r, additional));
      const raw = r.bytes(n);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
      } catch {
        throw new MandateError("CBOR_UTF8", "invalid UTF-8 in text string");
      }
      return text;
    }
    case MAJOR_ARRAY: {
      const n = toLength(r, readArgument(r, additional));
      const items: CborValue[] = [];
      for (let i = 0; i < n; i++) items.push(decodeItem(r, depth + 1));
      return items;
    }
    case MAJOR_MAP: {
      const n = toLength(r, readArgument(r, additional));
      const map: CborMap = new Map();
      let prevKeyRaw: Uint8Array | undefined;
      for (let i = 0; i < n; i++) {
        const keyStart = r.pos;
        const key = decodeItem(r, depth + 1);
        const keyRaw = r.buf.slice(keyStart, r.pos);
        if (prevKeyRaw !== undefined && compareBytes(prevKeyRaw, keyRaw) >= 0) {
          throw new MandateError(
            "CBOR_KEY_ORDER",
            "map keys not in strictly ascending bytewise order",
          );
        }
        prevKeyRaw = keyRaw;
        map.set(key, decodeItem(r, depth + 1));
      }
      return map;
    }
    case MAJOR_TAG:
      throw new MandateError("CBOR_FORBIDDEN", "tags forbidden");
    default: {
      if (additional === SIMPLE_FALSE) return false;
      if (additional === SIMPLE_TRUE) return true;
      throw new MandateError(
        "CBOR_FORBIDDEN",
        `simple/float value ${additional} forbidden`,
      );
    }
  }
}

export function cborDecode(buf: Uint8Array): CborValue {
  const r = new Reader(buf);
  const value = decodeItem(r, 0);
  if (r.pos !== buf.length) {
    throw new MandateError("CBOR_TRAILING", "trailing bytes after top-level item");
  }
  return value;
}
