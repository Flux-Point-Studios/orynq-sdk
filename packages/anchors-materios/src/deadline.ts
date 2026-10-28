export function timeoutBudget(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new RangeError("timeoutMs must be positive, finite, and at most 2147483647");
  }
  return value;
}

export async function withinDeadline<T>(operation: () => Promise<T>, deadline: number, error: () => Error): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw error();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(error()), remaining); }),
      operation(),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves after `ms`; at once when no time is left, since Node stretches a 0 ms timer to 1 ms. */
export function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}
