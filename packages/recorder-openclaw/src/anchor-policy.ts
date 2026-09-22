/**
 * Pure anchor decisions, extracted so that tests can exercise the REAL code.
 *
 * This module exists because of a defect in the tests that first accompanied
 * these fixes. Every decision here used to be inline inside a ~200-line method,
 * unexported and therefore unimportable, so the tests re-implemented each rule
 * instead of calling it. They passed — and went on passing when the original
 * bug (`anchored: res.ok`) was put back into the shipped source and rebuilt.
 * A suite that is green against the bug it exists to catch is worth less than
 * no suite, because it also reports confidence.
 *
 * Everything here is a pure function of its arguments: no clock, no I/O, no
 * randomness. That is what lets a test assert behaviour rather than restate it.
 */

export type AnchorState = "anchored" | "submitted" | "failed";

export interface AnchorRecord {
  contentDigest?: string;
  state?: AnchorState | string;
  attempts?: number;
  lastAttemptAt?: number;
  requestId?: string;
  [k: string]: unknown;
}

/** Deterministic JSON: object keys sorted at every level. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

/**
 * Classify an anchor POST response.
 *
 * ALLOWLIST, not denylist: anchoring requires an explicit confirmation. A
 * denylist ("not ERROR/FAILED") would count any unknown future status carrying
 * a stale txHash as anchored.
 */
export function classifyAnchorResponse(res: {
  ok: boolean;
  json?: unknown;
}): AnchorState {
  const body = (res.json ?? {}) as Record<string, unknown>;
  const inner = String(body.status ?? "").toUpperCase();
  const txHash = typeof body.txHash === "string" && body.txHash.length > 0 ? body.txHash : null;
  const confirmations = typeof body.confirmations === "number" ? body.confirmations : 0;

  // An explicit failure outranks a stale txHash: a transaction can be built
  // and then rejected, and that hash must not promote the bundle to
  // "submitted" where it would never be retried.
  if (inner === "ERROR" || inner === "FAILED") return "failed";
  if (res.ok && txHash && (inner === "CONFIRMED" || confirmations >= 1)) return "anchored";
  if (res.ok && txHash) return "submitted";
  return "failed";
}

/** Classify a 404 body. Only the server's own not-found may trigger a re-post. */
export function classifyNotFoundBody(raw: string): "unknown" | "error" {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed.detail === "anchor_request_not_found" ? "unknown" : "error";
  } catch {
    return "error";
  }
}

/** Backoff for a failed bundle: doubling to a binding 24h cap. */
export function backoffMs(attempts: number, jitter = 1): number {
  const base = Math.min(2 ** Math.min(attempts, 14) * 60_000, 24 * 60 * 60_000);
  return base * jitter;
}

/**
 * Should this bundle be POSTED now?
 *
 * "submitted" is deliberately absent: a submitted anchor already has a
 * transaction on the network and is resolved by polling, never by a timer.
 */
export function shouldPost(
  prior: AnchorRecord | undefined,
  contentDigest: string,
  now: number,
  jitter = 1
): boolean {
  if (prior?.contentDigest !== contentDigest) return true;   // new or changed
  if (prior.state === "anchored") return false;
  if (prior.state === "submitted") return false;             // poll decides
  if (prior.state === "failed") {
    const attempts = typeof prior.attempts === "number" ? prior.attempts : 0;
    const lastAt = typeof prior.lastAttemptAt === "number" ? prior.lastAttemptAt : 0;
    return now - lastAt >= backoffMs(attempts, jitter);
  }
  return true;
}

/** What to do with a bundle already in "submitted", given a poll result. */
export function decideSubmitted(
  poll: { state: "confirmed" | "pending" | "unknown" | "error" },
  waitedMs: number,
  warnAfterMs: number
): "promote-anchored" | "repost" | "warn-and-wait" | "wait" {
  if (poll.state === "confirmed") return "promote-anchored";
  if (poll.state === "unknown") return "repost";
  return waitedMs >= warnAfterMs ? "warn-and-wait" : "wait";
}

/**
 * Resolve the next anchor time at startup, from whatever was persisted.
 *
 * Returns 0 to mean "nothing usable was saved — pick a fresh jittered time",
 * which the caller does, because jitter is not pure.
 *
 * Extracted for the same reason as the rest of this module: it was inline in
 * runForever(), so the only test that ever covered it was a copy. It is also
 * the item-6 path, where a silent failure is unbounded starvation rather than
 * a wrong answer — the schedule used to live in memory alone, so every restart
 * pushed the next anchor a full cycle out and a crash loop anchored nothing
 * while looking healthy.
 *
 * The clamp is the load-bearing part: a corrupt or absurd far-future value must
 * never be able to park anchoring past one interval.
 */
export function resolveNextAnchorAt(saved: unknown, now: number, intervalMs: number): number {
  const next = (saved as { nextAnchorAt?: unknown } | null)?.nextAnchorAt;
  if (typeof next !== "number" || !Number.isFinite(next)) return 0;
  if (next <= now) return now;          // already due; do not schedule into the past
  return Math.min(next, now + intervalMs);
}
