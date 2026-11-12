import { MateriosConnectionError } from "./errors.js";

export function timeoutBudget(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new RangeError("timeoutMs must be positive, finite, and at most 2147483647");
  }
  return value;
}

/**
 * Settles with `operation`, rejects with `error()` at `deadline`, or rejects with `connect-aborted`
 * as soon as `signal` aborts. The operation is not started when either has already happened.
 */
export async function withinDeadline<T>(operation: () => Promise<T>, deadline: number, error: () => Error, signal?: AbortSignal): Promise<T> {
  const remaining = deadline - Date.now();
  const aborted = () => new MateriosConnectionError("connect-aborted", Math.max(0, remaining));
  if (signal?.aborted) throw aborted();
  if (remaining <= 0) throw error();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(error()), remaining);
        abort = () => reject(aborted());
        signal?.addEventListener("abort", abort, { once: true });
      }),
      operation(),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

/**
 * Resolves after `ms`, or as soon as `signal` aborts; at once when no time is left, since Node
 * stretches a 0 ms timer to 1 ms.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
