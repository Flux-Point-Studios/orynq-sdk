/**
 * Per-process, per-key warn rate-limiter.
 *
 * Two warn lines fire from the hot path of the 402 billing middleware:
 *
 *   - `billing.unknown_pricing_variant` — emitted by `decodePricingModel`
 *     when the on-chain `PricingModel` enum decodes to a variant the
 *     gateway doesn't recognise (forkless-upgrade ahead of the gateway
 *     image).
 *   - `billing.unclassified_route` — emitted by `classifyEndpoint` when a
 *     non-GET route slips past the explicit allow-list.
 *
 * Both warns are valuable signals on the FIRST occurrence per misconfig.
 * But both fire on every request under load — a misconfigured prod
 * could trivially write N warns/sec, swamping the structured-log pipeline
 * and burning disk for zero new information.
 *
 * Contract: emit the structured warn line at most once per
 * `THROTTLE_MS` per key. Callers construct `key` so it uniquely
 * identifies the kind+context (e.g. `"billing.unclassified_route:POST /v2/new"`)
 * — each distinct route still gets its FIRST emission promptly, but
 * subsequent repeats are dropped until the throttle window elapses.
 *
 * This is per-process state (a module-level `Map`). For multi-worker
 * deployments the throttle is per-worker, not global — which is fine:
 * N workers × 1 warn/min is still bounded.
 */

const lastEmitted = new Map<string, number>();
const THROTTLE_MS = 60_000;

/**
 * Emit a structured warn line at most once per `THROTTLE_MS` per key.
 * Use when a hot-path observable could spam logs under load. `key` should
 * uniquely identify the kind+context of the warning (e.g.
 * ``billing.unclassified_route:POST /v2/new_route`` so each distinct
 * route gets its own first emission but repeats are throttled).
 */
export function warnThrottled(
  key: string,
  payload: Record<string, unknown>,
): void {
  const now = Date.now();
  const prev = lastEmitted.get(key);
  if (prev !== undefined && now - prev < THROTTLE_MS) return;
  lastEmitted.set(key, now);
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify(payload));
}

/** Test hook: reset the throttle state. */
export function resetWarnThrottleForTests(): void {
  lastEmitted.clear();
}
