/**
 * Tests for the hot-path warn rate-limiter (#227 Part 2).
 *
 * Contract: `warnThrottled(key, payload)` emits a structured JSON line via
 * `console.warn` at most once per `THROTTLE_MS` (60s) per key. Different
 * keys are tracked independently. The test hook `resetWarnThrottleForTests()`
 * clears the throttle state so each test gets a clean slate.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  resetWarnThrottleForTests,
  warnThrottled,
} from "../middleware/warn-throttle.js";

describe("warnThrottled", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetWarnThrottleForTests();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  test("first call for a key emits", () => {
    warnThrottled("k1", { log: "test", n: 1 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const arg = warnSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed).toEqual({ log: "test", n: 1 });
  });

  test("second call within the window does not emit", () => {
    warnThrottled("k1", { log: "test", n: 1 });
    warnThrottled("k1", { log: "test", n: 2 });
    warnThrottled("k1", { log: "test", n: 3 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // Sanity: it was the FIRST payload that landed (n=1), not later ones.
    const parsed = JSON.parse(warnSpy.mock.calls[0]?.[0] as string);
    expect(parsed.n).toBe(1);
  });

  test("after THROTTLE_MS elapses, the next call emits again", () => {
    vi.useFakeTimers();
    // Anchor wall-clock so Date.now() advances deterministically.
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    warnThrottled("k1", { log: "test", phase: "first" });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Advance just shy of the window — still suppressed.
    vi.advanceTimersByTime(59_999);
    warnThrottled("k1", { log: "test", phase: "still-suppressed" });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Cross the threshold (60_000 ms total) — next call emits.
    vi.advanceTimersByTime(2);
    warnThrottled("k1", { log: "test", phase: "second" });
    expect(warnSpy).toHaveBeenCalledTimes(2);
    const parsed = JSON.parse(warnSpy.mock.calls[1]?.[0] as string);
    expect(parsed.phase).toBe("second");
  });

  test("different keys are tracked independently", () => {
    warnThrottled("k1", { log: "k1-first" });
    warnThrottled("k2", { log: "k2-first" });
    warnThrottled("k1", { log: "k1-suppressed" });
    warnThrottled("k3", { log: "k3-first" });
    // 3 distinct keys → 3 emissions; the duplicate k1 is suppressed.
    expect(warnSpy).toHaveBeenCalledTimes(3);
    const logs = warnSpy.mock.calls
      .map((c) => JSON.parse(c[0] as string).log)
      .sort();
    expect(logs).toEqual(["k1-first", "k2-first", "k3-first"]);
  });

  test("resetWarnThrottleForTests clears state so the next call re-emits", () => {
    warnThrottled("k1", { log: "first" });
    warnThrottled("k1", { log: "suppressed" });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    resetWarnThrottleForTests();
    warnThrottled("k1", { log: "after-reset" });
    expect(warnSpy).toHaveBeenCalledTimes(2);
    const parsed = JSON.parse(warnSpy.mock.calls[1]?.[0] as string);
    expect(parsed.log).toBe("after-reset");
  });

  test("integration: classifyEndpoint-style key suppresses repeats but allows distinct routes", () => {
    // Mimic the call-site shape: one key per (method, path) pair.
    warnThrottled("billing.unclassified_route:POST /v2/new_route", {
      log: "billing.unclassified_route",
      method: "POST",
      path: "/v2/new_route",
    });
    // Same route again → suppressed.
    warnThrottled("billing.unclassified_route:POST /v2/new_route", {
      log: "billing.unclassified_route",
      method: "POST",
      path: "/v2/new_route",
    });
    // Distinct route → still gets its first emission.
    warnThrottled("billing.unclassified_route:POST /v2/another_route", {
      log: "billing.unclassified_route",
      method: "POST",
      path: "/v2/another_route",
    });
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});
