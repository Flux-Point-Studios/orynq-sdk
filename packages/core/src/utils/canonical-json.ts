/**
 * @summary RFC 8785 (JCS) JSON Canonicalization implementation.
 *
 * This file implements the JSON Canonicalization Scheme (JCS) as defined in
 * RFC 8785. Canonical JSON ensures that semantically equivalent JSON objects
 * produce identical byte sequences, which is critical for cryptographic
 * operations like hashing and signing.
 *
 * Key transformations:
 * - Object keys are sorted lexicographically (by UTF-16 code units)
 * - No whitespace between tokens
 * - Numbers use shortest representation without unnecessary precision
 * - null values in objects are removed (configurable)
 * - undefined values are always removed
 *
 * RFC 8785: https://www.rfc-editor.org/rfc/rfc8785
 *
 * Used by:
 * - Hash generation for idempotency keys
 * - Payment request hashing for signatures
 * - Cross-language verification of signed payloads
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * JSON-compatible value types.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Options for canonical JSON serialization.
 */
export interface CanonicalizeOptions {
  /**
   * Whether to remove null values from objects.
   * @default true (per common practice, though RFC 8785 preserves nulls)
   */
  removeNulls?: boolean;

  /**
   * Whether to remove undefined values from objects.
   * @default true (always recommended)
   */
  removeUndefined?: boolean;

  /**
   * Maximum depth to serialize (prevents stack overflow on circular refs).
   * @default 100
   */
  maxDepth?: number;
}

// ---------------------------------------------------------------------------
// Main Function
// ---------------------------------------------------------------------------

/**
 * Serialize a value to canonical JSON (RFC 8785 JCS).
 *
 * This produces a deterministic JSON string that is suitable for hashing.
 * Two semantically equivalent objects will always produce the same output.
 *
 * @param value - Value to serialize
 * @param options - Serialization options
 * @returns Canonical JSON string
 * @throws Error if value contains circular references or exceeds max depth
 *
 * @example
 * canonicalize({ b: 2, a: 1 }) // '{"a":1,"b":2}'
 * canonicalize({ foo: null }) // '{}' (with removeNulls: true)
 * canonicalize([3, 1, 2]) // '[3,1,2]' (arrays preserve order)
 */
export function canonicalize(
  value: unknown,
  options: CanonicalizeOptions = {}
): string {
  const { removeNulls = true, removeUndefined = true, maxDepth = 100 } = options;

  const seen = new WeakSet<object>();

  function serialize(val: unknown, depth: number): string {
    if (depth > maxDepth) {
      throw new Error(`Maximum depth of ${maxDepth} exceeded during canonicalization`);
    }

    // Handle primitives
    if (val === null) {
      return "null";
    }

    if (val === undefined) {
      // undefined serializes to undefined (will be filtered in objects)
      return "undefined";
    }

    switch (typeof val) {
      case "boolean":
        return val ? "true" : "false";

      case "number":
        return serializeNumber(val);

      case "string":
        return serializeString(val);

      case "object":
        // Check for circular references
        if (seen.has(val)) {
          throw new Error("Circular reference detected during canonicalization");
        }
        seen.add(val);

        try {
          if (Array.isArray(val)) {
            return serializeArray(val, depth);
          }
          return serializeObject(val as Record<string, unknown>, depth);
        } finally {
          seen.delete(val);
        }

      default:
        // Functions, symbols, bigint, etc. are not JSON-serializable
        throw new Error(`Cannot canonicalize value of type ${typeof val}`);
    }
  }

  function serializeNumber(num: number): string {
    // Handle special cases per RFC 8785
    if (!Number.isFinite(num)) {
      throw new Error(`Cannot canonicalize non-finite number: ${num}`);
    }

    // Use JavaScript's default number serialization which matches RFC 8785
    // for most cases. Edge cases are handled below.

    // Zero (positive and negative zero both become "0")
    if (Object.is(num, 0) || Object.is(num, -0)) {
      return "0";
    }

    // Use JSON.stringify for correct handling of edge cases
    // This handles exponential notation correctly
    return JSON.stringify(num);
  }

  function serializeString(str: string): string {
    // JSON.stringify handles escaping correctly per RFC 8785
    return JSON.stringify(str);
  }

  function serializeArray(arr: unknown[], depth: number): string {
    const elements = arr.map((item) => {
      const serialized = serialize(item, depth + 1);
      // Arrays can contain undefined, which becomes null in JSON
      return serialized === "undefined" ? "null" : serialized;
    });
    return "[" + elements.join(",") + "]";
  }

  function serializeObject(obj: Record<string, unknown>, depth: number): string {
    // Get all string keys and sort them lexicographically
    const keys = Object.keys(obj).sort((a, b) => {
      // Sort by UTF-16 code units (JavaScript's default string comparison)
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    });

    const pairs: string[] = [];

    for (const key of keys) {
      const value = obj[key];

      // Skip undefined values
      if (removeUndefined && value === undefined) {
        continue;
      }

      // Skip null values if configured
      if (removeNulls && value === null) {
        continue;
      }

      const serializedValue = serialize(value, depth + 1);

      // Skip if value serialized to undefined
      if (serializedValue === "undefined") {
        continue;
      }

      pairs.push(serializeString(key) + ":" + serializedValue);
    }

    return "{" + pairs.join(",") + "}";
  }

  const result = serialize(value, 0);

  // Top-level undefined is not valid JSON
  if (result === "undefined") {
    throw new Error("Cannot canonicalize undefined at top level");
  }

  return result;
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Parse a canonical JSON string back to a value.
 * This is simply JSON.parse with type safety.
 *
 * @param json - Canonical JSON string
 * @returns Parsed value
 */
export function parseCanonical<T = JsonValue>(json: string): T {
  return JSON.parse(json) as T;
}

/**
 * Compare two values for canonical equality.
 * Returns true if both values produce the same canonical JSON.
 *
 * @param a - First value
 * @param b - Second value
 * @param options - Canonicalization options
 * @returns true if canonically equal
 */
export function canonicalEquals(
  a: unknown,
  b: unknown,
  options?: CanonicalizeOptions
): boolean {
  try {
    return canonicalize(a, options) === canonicalize(b, options);
  } catch {
    return false;
  }
}

/**
 * Create a deep copy of a value with canonical key ordering.
 * Useful for normalizing objects before comparison or storage.
 *
 * @param value - Value to normalize
 * @param options - Canonicalization options
 * @returns Normalized copy of the value
 */
export function normalizeJson<T>(
  value: T,
  options?: CanonicalizeOptions
): T {
  return parseCanonical<T>(canonicalize(value, options));
}

/**
 * Sort object keys recursively to canonical order.
 * Returns a new object with sorted keys.
 *
 * @param obj - Object to sort
 * @returns New object with sorted keys
 */
export function sortObjectKeys<T extends Record<string, unknown>>(obj: T): T {
  if (typeof obj !== "object" || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) =>
      typeof item === "object" && item !== null
        ? sortObjectKeys(item as Record<string, unknown>)
        : item
    ) as unknown as T;
  }

  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj).sort();

  for (const key of keys) {
    const value = obj[key];
    sorted[key] =
      typeof value === "object" && value !== null
        ? sortObjectKeys(value as Record<string, unknown>)
        : value;
  }

  return sorted as T;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Check if a string is valid canonical JSON.
 * A string is canonical if parsing and re-canonicalizing produces the same string.
 *
 * @param json - JSON string to validate
 * @param options - Canonicalization options
 * @returns true if the string is canonical
 */
export function isCanonical(
  json: string,
  options?: CanonicalizeOptions
): boolean {
  try {
    const parsed = JSON.parse(json);
    const recanonical = canonicalize(parsed, options);
    return json === recanonical;
  } catch {
    return false;
  }
}
