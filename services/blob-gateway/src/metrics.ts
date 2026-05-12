/**
 * Prometheus metrics for the blob-gateway service.
 *
 * The gateway hadn't had a `/metrics` exposition before this module — Phase
 * 2.A's billing middleware (#43, #44) needed at least one counter for the
 * silent fail-open path that catches internal errors, so prom-client was
 * added here as the canonical home rather than scattering ad-hoc counters
 * across modules.
 *
 * Design notes:
 *   - We use the prom-client default global `Registry`. Every counter is
 *     constructed via `new Counter({ name, ... })`, which auto-registers
 *     against the global. The `/metrics` endpoint (wired in `index.ts`)
 *     serves `register.metrics()`.
 *   - Metric names use `<subsystem>_<thing>_total` for counters. The
 *     `billing_middleware_*` prefix is the 402 middleware subsystem.
 *   - Labels are intentionally low-cardinality. For
 *     `billing_middleware_error_total` the `phase` label takes one of
 *     `off | measurement | live` — three values, bounded forever.
 *   - The `/metrics` endpoint is wired in `index.ts` directly after
 *     `/health` so ops dashboards pick it up automatically.
 *   - Tests reset counter state via `resetMetricsForTests()` which calls
 *     `register.resetMetrics()` — see `__tests__/billing-402.test.ts`
 *     for the M3-error → counter-increments assertion.
 */

import { Counter, collectDefaultMetrics, register } from "prom-client";

/**
 * Counter for billing-middleware fail-open events. Increments inside the
 * top-level try/catch wrap in `billing-402.ts` whenever an internal error
 * causes the middleware to bypass its admission check. In `live` mode this
 * is a silent revenue leak — alert when the rate exceeds a tiny floor
 * (e.g. >1/min sustained).
 *
 * Labels:
 *   - phase: `off | measurement | live` — the configured enforcement phase
 *     at the moment the error fired. We label by phase so the alerting
 *     rule can ignore errors during `off` (where the bypass is intentional)
 *     and focus on `live` (where the bypass is a regression).
 */
export const billingMiddlewareErrorTotal = new Counter({
  name: "billing_middleware_error_total",
  help:
    "Total billing-middleware fail-open events. Increments whenever the " +
    "top-level try/catch in billing-402.ts catches an internal error and " +
    "passes the request through without admission control. In `live` " +
    "mode this is a silent revenue leak — alert when sustained.",
  labelNames: ["phase"] as const,
});

let defaultsCollected = false;

/**
 * Lazy-start the default Node-process metrics (heap, event-loop lag, etc).
 * Called from `index.ts::start()` so the test harness doesn't accidentally
 * start collection in unit tests (which would leak timers and slow down
 * the suite).
 */
export function startDefaultMetricsCollection(): void {
  if (defaultsCollected) return;
  defaultsCollected = true;
  collectDefaultMetrics();
}

/**
 * Expose the prom-client default registry so route wiring can call
 * `register.metrics()` / `register.contentType` without re-importing
 * prom-client across modules.
 */
export { register as metricsRegistry } from "prom-client";

/**
 * Test hook: reset all counter values without unregistering. Use in
 * `beforeEach` so each test sees a clean counter slate.
 */
export function resetMetricsForTests(): void {
  register.resetMetrics();
}
