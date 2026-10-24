import { expect, it } from "vitest";
import { assertStandingClock, assertStandingFreshClock } from "../standing-clock.js";

const minute = 60_000, base = Date.parse("2026-10-24T00:00:00Z");
const start = () => ({ chainTime: base, wallTime: base, monotonicMillis: 500 });
const ready = () => ({ chainTime: base + 20 * minute, wallTime: base + 20 * minute, monotonicMillis: 500 + 20 * minute });

it("requires twenty authenticated chain minutes and twenty minutes in the current process", () => {
  expect(() => assertStandingClock(start(), ready())).not.toThrow();
  expect(() => assertStandingClock(start(), { ...ready(), chainTime: ready().chainTime - 1 })).toThrow(/twenty/i);
  expect(() => assertStandingClock(start(), { chainTime: ready().chainTime, wallTime: ready().wallTime - 1, monotonicMillis: ready().monotonicMillis - 1 })).toThrow(/twenty/i);
});

it("restarts the hold for every new process even with an already synchronized database", () => {
  expect(() => assertStandingClock(ready(), ready())).toThrow(/twenty/i);
});

it("requires a fresh authenticated head when the process starts and when it admits work", () => {
  expect(() => assertStandingFreshClock({ ...start(), chainTime: base - 120_000 })).not.toThrow();
  expect(() => assertStandingClock({ ...start(), chainTime: base - 120_001 }, ready())).toThrow(/stale/i);
  expect(() => assertStandingClock(start(), { ...ready(), chainTime: ready().chainTime - 120_001 })).toThrow(/stale/i);
});

it("refuses future chain time and a chain clock that rewinds", () => {
  expect(() => assertStandingFreshClock({ ...ready(), chainTime: ready().wallTime + 30_001 })).toThrow(/future/i);
  expect(() => assertStandingClock(start(), { ...start(), chainTime: base - 1 })).toThrow(/rewind/i);
});

it("detects host-clock steps against the monotonic process clock", () => {
  expect(() => assertStandingClock(start(), { ...ready(), wallTime: ready().wallTime + 1001 })).toThrow(/step/i);
  expect(() => assertStandingClock(start(), { ...ready(), wallTime: ready().wallTime - 1001 })).toThrow(/step/i);
});

it.each([NaN, Infinity, -1, 0.5])("rejects invalid chain-clock evidence %s", chainTime => {
  expect(() => assertStandingClock(start(), { ...ready(), chainTime })).toThrow();
});

it.each([NaN, Infinity, -1])("rejects invalid monotonic evidence %s", monotonicMillis => {
  expect(() => assertStandingClock(start(), { ...ready(), monotonicMillis })).toThrow();
});
