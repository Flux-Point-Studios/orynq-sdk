import { cborEncode, type CborMap, type CborValue } from "@fluxpointstudios/orynq-sdk-conduct";
import { RpcError } from "./errors.js";

// The JSON-to-dCBOR profile (credential-broker spec §6.3). Shapes mirror the CDDL in docs/:
// - a map is a plain JSON object with exactly the declared members; cborEncode orders its keys;
// - a uint whose upper bound fits 2^53 is a JSON integer, any other uint is a canonical decimal
//   string, so each value has one spelling;
// - text is a JSON string bounded in UTF-8 bytes; bytes are lowercase hex;
// - null, booleans, floats and negative numbers match no shape.
// Every refusal is -32602 with the schema path of the failing value.

export type Shape =
  | { readonly type: "uint"; readonly min: bigint; readonly max: bigint }
  | { readonly type: "text"; readonly minBytes: number; readonly maxBytes: number; readonly pattern: RegExp | undefined }
  | { readonly type: "bytes"; readonly minSize: number; readonly maxSize: number }
  | { readonly type: "literal"; readonly value: bigint | string }
  | { readonly type: "array"; readonly items: Shape; readonly min: number; readonly max: number }
  | { readonly type: "map"; readonly fields: ReadonlyMap<string, { readonly shape: Shape; readonly optional: boolean }> }
  | { readonly type: "choice"; readonly options: readonly Shape[] };

interface Optional {
  readonly optional: Shape;
}

const U64_MAX = (1n << 64n) - 1n;
const JSON_INTEGER_MAX = 1n << 53n;
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;
const HEX = /^([0-9a-f]{2})*$/;

export const uint = ({ min = 0n, max = U64_MAX }: { min?: bigint; max?: bigint } = {}): Shape => ({ type: "uint", min, max });

// `pattern` is the CDDL .regexp source; it must match the whole string.
export const text = (maxBytes: number, { minBytes = 0, pattern }: { minBytes?: number; pattern?: string } = {}): Shape => ({
  type: "text",
  minBytes,
  maxBytes,
  pattern: pattern === undefined ? undefined : new RegExp(`^(?:${pattern})$`, "u"),
});

export const bytes = (minSize: number, maxSize = minSize): Shape => ({ type: "bytes", minSize, maxSize });

export const literal = (value: bigint | string): Shape => ({ type: "literal", value });

export const array = (items: Shape, min: number, max: number): Shape => ({ type: "array", items, min, max });

export const optional = (shape: Shape): Optional => ({ optional: shape });

export const map = (fields: Readonly<Record<string, Shape | Optional>>): Shape => ({
  type: "map",
  fields: new Map(Object.entries(fields).map(([name, field]): [string, { shape: Shape; optional: boolean }] =>
    "optional" in field ? [name, { shape: field.optional, optional: true }] : [name, { shape: field, optional: false }])),
});

export const choice = (...options: Shape[]): Shape => ({ type: "choice", options });

const refuse = (field: string): RpcError => new RpcError("INVALID_PARAMS", { field });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function toUint(value: unknown, shape: Extract<Shape, { type: "uint" }>, path: string): bigint {
  let n: bigint;
  if (shape.max <= JSON_INTEGER_MAX) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || Object.is(value, -0)) throw refuse(path);
    n = BigInt(value);
  } else {
    if (typeof value !== "string" || !DECIMAL.test(value)) throw refuse(path);
    n = BigInt(value);
  }
  if (n < shape.min || n > shape.max) throw refuse(path);
  return n;
}

export function jsonToCbor(value: unknown, shape: Shape, path = "params"): CborValue {
  switch (shape.type) {
    case "uint":
      return toUint(value, shape, path);
    case "text": {
      if (typeof value !== "string") throw refuse(path);
      const size = new TextEncoder().encode(value).length;
      if (size < shape.minBytes || size > shape.maxBytes || (shape.pattern && !shape.pattern.test(value))) throw refuse(path);
      return value;
    }
    case "bytes": {
      if (typeof value !== "string" || !HEX.test(value)) throw refuse(path);
      const size = value.length / 2;
      if (size < shape.minSize || size > shape.maxSize) throw refuse(path);
      return Uint8Array.from({ length: size }, (_, i) => parseInt(value.slice(2 * i, 2 * i + 2), 16));
    }
    case "literal":
      if (typeof shape.value === "bigint" ? value !== Number(shape.value) : value !== shape.value) throw refuse(path);
      return shape.value;
    case "array": {
      if (!Array.isArray(value) || value.length < shape.min || value.length > shape.max) throw refuse(path);
      return value.map((item, i) => jsonToCbor(item, shape.items, `${path}[${i}]`));
    }
    case "map": {
      if (!isPlainObject(value) || Object.keys(value).some(name => !shape.fields.has(name))) throw refuse(path);
      const out: CborMap = new Map();
      for (const [name, field] of shape.fields) {
        if (!Object.hasOwn(value, name)) {
          if (field.optional) continue;
          throw refuse(`${path}.${name}`);
        }
        out.set(name, jsonToCbor(value[name], field.shape, `${path}.${name}`));
      }
      return out;
    }
    case "choice": {
      const matches: CborValue[] = [];
      for (const option of shape.options) {
        try {
          matches.push(jsonToCbor(value, option, path));
        } catch (error) {
          if (!(error instanceof RpcError)) throw error;
        }
      }
      if (matches.length > 1) throw new Error(`ambiguous schema: ${matches.length} choices match at ${path}`);
      if (matches.length === 0) throw refuse(path);
      return matches[0] as CborValue;
    }
  }
}

export function jsonToDcbor(value: unknown, shape: Shape, path = "params"): Uint8Array {
  return cborEncode(jsonToCbor(value, shape, path));
}
