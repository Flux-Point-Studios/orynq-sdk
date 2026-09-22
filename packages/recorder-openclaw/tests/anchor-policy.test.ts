/**
 * Unit probes for the anchor decisions — importing SOURCE, not a build.
 *
 * Two defects sit behind this file's shape, both worth remembering.
 *
 * First: the suites these replace re-implemented every rule they tested, so
 * they stayed green when the original bug was restored in src. A copy tests
 * the copy.
 *
 * Second, and subtler: the .mjs rewrite that fixed THAT imported ../dist/*.js
 * per-file modules. The repo builds with tsup (entry src/index.ts, clean:true)
 * and emits only dist/index.*, so those files cannot exist after a real build —
 * they were an artifact of running `tsc -p tsconfig.json` by hand. The probes
 * passed against something neither shipped nor built by CI. A stale-artifact
 * gate does not catch that; only never building at all does.
 *
 * Vitest compiles the source directly. There is no artifact between a mutation
 * and the assertion, so neither failure mode is reachable from here.
 */
import { describe, it, expect } from "vitest";
import {
  canonical,
  classifyAnchorResponse,
  classifyNotFoundBody,
  backoffMs,
  shouldPost,
  decideSubmitted,
  resolveNextAnchorAt
} from "../src/anchor-policy";
import { buildTraceFromSpool } from "../src/build-trace";

const HOUR = 3_600_000;

describe("classifyAnchorResponse — allowlist, not denylist", () => {
  it("CONFIRMED with a txHash is anchored", () => {
    expect(classifyAnchorResponse({ ok: true, json: { status: "CONFIRMED", txHash: "ab" } })).toBe("anchored");
  });
  it("confirmations >= 1 is anchored", () => {
    expect(classifyAnchorResponse({ ok: true, json: { status: "PENDING", txHash: "ab", confirmations: 1 } })).toBe("anchored");
  });
  it("THE ORIGINAL BUG: HTTP ok wrapping an inner ERROR is failed, not anchored", () => {
    // The exact shape of all 224 production failures: {"anchored":true,"status":200}
    // wrapping {"status":"ERROR","txHash":null}.
    expect(classifyAnchorResponse({ ok: true, json: { status: "ERROR", txHash: null } })).toBe("failed");
  });
  it.each(["ERROR", "FAILED"])("%s outranks a stale txHash", (status) => {
    expect(classifyAnchorResponse({ ok: true, json: { status, txHash: "stale" } })).toBe("failed");
  });
  it("a txHash without confirmation is submitted, never anchored", () => {
    expect(classifyAnchorResponse({ ok: true, json: { requestId: "r", status: "ACCEPTED", txHash: "ab" } })).toBe("submitted");
  });
  it("ALLOWLIST: an unknown future status with a txHash is submitted, not anchored", () => {
    expect(classifyAnchorResponse({ ok: true, json: { requestId: "r", status: "QUEUED_V2", txHash: "ab" } })).toBe("submitted");
  });
  it("a requestId without a txHash is submitted: the worker may already be on chain", () => {
    // t-backend answers from its DB row, PENDING with txHash null until the
    // worker's best-effort callback lands. Re-posting that is a second anchor.
    expect(classifyAnchorResponse({ ok: true, json: { requestId: "r", status: "PENDING", txHash: null } })).toBe("submitted");
  });
  it("without a requestId there is nothing to poll, so even a txHash is failed", () => {
    expect(classifyAnchorResponse({ ok: true, json: { status: "SUBMITTED", txHash: "ab" } })).toBe("failed");
  });
  it.each([
    ["no txHash", { ok: true, json: { status: "CONFIRMED" } }],
    ["empty txHash", { ok: true, json: { status: "CONFIRMED", txHash: "" } }],
    ["HTTP failure", { ok: false, json: { status: "CONFIRMED", txHash: "ab" } }],
    ["empty body", { ok: true, json: {} }],
    ["unparseable body", { ok: true, json: { raw: "<html>502</html>" } }]
  ])("%s is failed", (_label, res) => {
    expect(classifyAnchorResponse(res as { ok: boolean; json: unknown })).toBe("failed");
  });
});

describe("classifyNotFoundBody — only the server's own not-found re-posts", () => {
  it("the server's own not-found is unknown", () => {
    expect(classifyNotFoundBody('{"detail":"anchor_request_not_found"}')).toBe("unknown");
  });
  it.each([
    ["proxy HTML", "<html>404</html>"],
    ["a different detail", '{"detail":"route_not_found"}'],
    ["empty body", ""],
    ["no detail field", '{"error":"nope"}'],
    ["null detail", '{"detail":null}']
  ])("%s is an error, never a re-post", (_l, body) => {
    expect(classifyNotFoundBody(body)).toBe("error");
  });
});

describe("shouldPost — submitted is resolved by polling, never by a timer", () => {
  const D = "d0";
  it("an unseen bundle posts", () => expect(shouldPost(undefined, D, 0)).toBe(true));
  it("an anchored bundle never re-posts", () =>
    expect(shouldPost({ contentDigest: D, state: "anchored" }, D, 1e12)).toBe(false));
  it("a submitted bundle never re-posts on a timer, at any age", () => {
    for (const age of [HOUR, 7 * HOUR, 30 * 24 * HOUR]) {
      expect(shouldPost({ contentDigest: D, state: "submitted", lastAttemptAt: 0 }, D, age)).toBe(false);
    }
  });
  it("changed content re-posts even when the old content was anchored", () =>
    expect(shouldPost({ contentDigest: D, state: "anchored" }, "d1", 0)).toBe(true));
  it("a failure waits out its backoff, then retries", () => {
    const prior = { contentDigest: D, state: "failed", attempts: 1, lastAttemptAt: 0 };
    expect(shouldPost(prior, D, 30_000)).toBe(false);
    expect(shouldPost(prior, D, 3 * HOUR)).toBe(true);
  });
});

describe("backoffMs — the 24h cap is what binds", () => {
  it("early attempts are short", () => expect(backoffMs(1)).toBe(120_000));
  it.each([20, 99])("attempt %i is capped at 24h", (n) => expect(backoffMs(n)).toBe(24 * HOUR));
  it("jitter scales the delay — the B3 mutant materios found my suite could not see", () => {
    // `base * jitter` changed to `base + 0 * jitter` survived my whole battery.
    // Without this, the +/-20% spread that keeps 224 simultaneously-failing
    // bundles from retrying in a synchronised burst can be removed silently.
    expect(backoffMs(1, 0.8)).toBe(96_000);
    expect(backoffMs(1, 1.2)).toBe(144_000);
    expect(backoffMs(1, 1)).toBe(120_000);
  });

  it("jitter moves the retry boundary either side of the unjittered one", () => {
    const prior = { contentDigest: "d0", state: "failed", attempts: 1, lastAttemptAt: 0 };
    expect(shouldPost(prior, "d0", 100_000, 0.8)).toBe(true);   // 96s elapsed-threshold
    expect(shouldPost(prior, "d0", 100_000, 1.2)).toBe(false);  // 144s threshold
  });

  it("a permanently failing bundle settles at about one attempt a day", () => {
    const prior = { contentDigest: "d0", state: "failed", attempts: 20, lastAttemptAt: 0 };
    const retries = Array.from({ length: 24 }, (_, h) => shouldPost(prior, "d0", (h + 1) * HOUR)).filter(Boolean);
    expect(retries).toHaveLength(1);
  });
});

describe("decideSubmitted", () => {
  it("confirmed promotes", () => expect(decideSubmitted({ state: "confirmed" }, 0, HOUR)).toBe("promote-anchored"));
  it("the server's own not-found is the ONLY re-post", () =>
    expect(decideSubmitted({ state: "unknown" }, 0, HOUR)).toBe("repost"));
  it("a poll ERROR must not re-post — it is not evidence the anchor is absent", () =>
    expect(decideSubmitted({ state: "error" }, 0, HOUR)).toBe("wait"));
  it("pending waits, then warns", () => {
    expect(decideSubmitted({ state: "pending" }, 0, HOUR)).toBe("wait");
    expect(decideSubmitted({ state: "pending" }, 2 * HOUR, HOUR)).toBe("warn-and-wait");
  });
});

describe("resolveNextAnchorAt — item 6, where silence is starvation", () => {
  const NOW = 1_700_000_000_000;
  const INT = HOUR;
  it("a saved schedule resumes rather than restarting the cycle", () =>
    expect(resolveNextAnchorAt({ nextAnchorAt: NOW + 10 * 60_000 }, NOW, INT)).toBe(NOW + 10 * 60_000));
  it("an absurd far-future value is clamped to one interval", () =>
    expect(resolveNextAnchorAt({ nextAnchorAt: NOW + 365 * 24 * INT }, NOW, INT)).toBe(NOW + INT));
  it("an overdue schedule fires now, not in the past", () =>
    expect(resolveNextAnchorAt({ nextAnchorAt: NOW - 5 * INT }, NOW, INT)).toBe(NOW));
  it.each([
    ["missing file", null],
    ["empty object", {}],
    ["wrong type", { nextAnchorAt: "soon" }],
    ["NaN", { nextAnchorAt: NaN }],
    ["Infinity", { nextAnchorAt: Infinity }],
    ["undefined", undefined]
  ])("%s yields 0, meaning the caller picks a fresh jittered time", (_l, saved) => {
    expect(resolveNextAnchorAt(saved, NOW, INT)).toBe(0);
  });
  it("NO input can schedule further out than one interval", () => {
    const inputs = [NOW + 1, NOW + INT, NOW + 10 * INT, NOW + 1e15, Infinity, NaN, "x", null, -1];
    for (const v of inputs) {
      expect(resolveNextAnchorAt({ nextAnchorAt: v }, NOW, INT)).toBeLessThanOrEqual(NOW + INT);
    }
  });
});

describe("canonical + contentDigest, through the real buildTraceFromSpool", () => {
  it("key order does not change the serialisation", () => {
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
    expect(canonical({ x: { b: 1, a: 2 } })).toBe(canonical({ x: { a: 2, b: 1 } }));
  });
  it("array order DOES change it", () => expect(canonical([1, 2])).not.toBe(canonical([2, 1])));

  const ev = (over: Record<string, unknown> = {}) => ({
    kind: "message", contentHash: "sha256:aa", sessionId: "s1",
    meta: {}, content: "hi", ts: 1, ...over
  });
  const digest = async (agentId: string, evs: unknown[]) =>
    (await buildTraceFromSpool({ agentId, spoolEvents: evs as never })).contentDigest;
  const A = "openclaw:unknown";

  it("THE ORIGINAL BUG: an unchanged spool digests identically across builds", async () => {
    // The manifest hash moved every cycle (createTrace mints a runId, addEvent
    // stamps the clock), so every bundle was re-posted hourly: 459,699 requests.
    expect(await digest(A, [ev()])).toBe(await digest(A, [ev()]));
  });
  it.each([
    ["meta", { meta: { model: "opus" } }],
    ["sessionId", { sessionId: "s2" }],
    ["contentHash", { contentHash: "sha256:bb" }]
  ])("a %s change moves the digest", async (_l, over) => {
    expect(await digest(A, [ev(over)])).not.toBe(await digest(A, [ev()]));
  });
  it("an agentId change moves the digest", async () => {
    expect(await digest("openclaw:other", [ev()])).not.toBe(await digest(A, [ev()]));
  });
  it("an extra event moves the digest", async () => {
    expect(await digest(A, [ev(), ev({ contentHash: "sha256:cc" })])).not.toBe(await digest(A, [ev()]));
  });
});
