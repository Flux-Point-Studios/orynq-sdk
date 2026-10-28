/** A non-null object that is not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `value` as plain JSON data, read once: each getter and proxy trap runs once,
 * and later changes to `value` cannot reach the copy. A value JSON cannot hold,
 * such as a bigint or a cycle, yields an error instead.
 */
export function readOnce(value: unknown): { data: unknown } | { error: string } {
  try {
    return { data: JSON.parse(JSON.stringify(value) ?? "null") as unknown };
  } catch (error) {
    return { error: `not JSON data: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The values that occur more than once in `values`, each listed once. */
export function repeated<T>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const twice = new Set<T>();
  for (const value of values) {
    (seen.has(value) ? twice : seen).add(value);
  }
  return [...twice];
}
