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
