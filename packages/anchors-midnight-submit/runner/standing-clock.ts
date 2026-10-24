export interface StandingClockPoint { chainTime: number; wallTime: number; monotonicMillis: number }

export function assertStandingFreshClock(point: StandingClockPoint): void {
  if (![point.chainTime, point.wallTime].every(value => Number.isSafeInteger(value) && value >= 0) || !Number.isFinite(point.monotonicMillis) || point.monotonicMillis < 0) throw new Error("Invalid standing clock evidence");
  if (point.wallTime - point.chainTime > 120_000) throw new Error("Standing authenticated head is stale");
  if (point.chainTime - point.wallTime > 30_000) throw new Error("Standing authenticated head lies in the host clock's future");
}

export function assertStandingClock(started: StandingClockPoint, current: StandingClockPoint): void {
  assertStandingFreshClock(started); assertStandingFreshClock(current);
  if (current.chainTime < started.chainTime) throw new Error("Standing chain clock rewind requires a new process hold");
  const elapsed = current.monotonicMillis - started.monotonicMillis, wallElapsed = current.wallTime - started.wallTime;
  if (elapsed < 0 || Math.abs(wallElapsed - elapsed) > 1000) throw new Error("Standing host clock step requires a new process hold");
  if (current.chainTime - started.chainTime < 20 * 60_000 || elapsed < 20 * 60_000) throw new Error("Standing warmup requires twenty authenticated chain minutes in this process");
}
