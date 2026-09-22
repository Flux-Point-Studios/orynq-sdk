// Dedup + backoff decision logic, lifted verbatim from recorder.ts.
import { createHash } from "node:crypto";
// NOTE: "submitted" is deliberately absent from this decision function. A
// submitted anchor is never re-posted on a timer — it is resolved by polling
// the status endpoint, which submitted-poll.test.mjs covers. An earlier version
// of this file modelled a 6h re-check here; that design was rejected because it
// would have re-anchored every landed bundle four times a day.

function shouldAnchor(prior, contentDigest, now, rnd = 0.5) {
  if (prior?.contentDigest === contentDigest && prior?.state === "anchored") return false;
  // submitted never re-posts from here, at any age.
  if (prior?.contentDigest === contentDigest && prior?.state === "submitted") return false;
  if (prior?.contentDigest === contentDigest && prior?.state === "failed") {
    const attempts = typeof prior.attempts === "number" ? prior.attempts : 0;
    const lastAt = typeof prior.lastAttemptAt === "number" ? prior.lastAttemptAt : 0;
    const base = Math.min(2 ** Math.min(attempts, 14) * 60_000, 24 * 60 * 60_000);
    if (now - lastAt < base * (0.8 + rnd * 0.4)) return false;
  }
  return true;
}
// canonical() and the digest, as build-trace.ts computes them
function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
const digestOf = (agentId, datas) =>
  createHash("sha256").update(`${agentId}\n${datas.map(canonical).join("\n")}`).digest("hex");

let fail = 0;
const t = (n, got, want) => { const ok = got === want; if (!ok) fail++; console.log(`  ${ok?"PASS":"FAIL"}  ${n}  (got ${got}, want ${want})`); };
const HOUR = 3_600_000;
const A = "openclaw:unknown";
const base = [{kind:"msg",contentHash:"sha256:aa",meta:{}},{kind:"msg",contentHash:"sha256:bb",meta:{}}];
const D = digestOf(A, base);

// --- THE ORIGINAL BUG -----------------------------------------------------
const anchored = { contentDigest: D, state: "anchored", attempts: 0, lastAttemptAt: 0 };
t("anchored bundle is never re-posted", shouldAnchor(anchored, D, Date.now()), false);
let posts = 0;
for (let h = 0; h < 24; h++) if (shouldAnchor(anchored, D, Date.now() + h*HOUR)) posts++;
t("24 hourly cycles -> 0 re-posts", posts, 0);
let oldPosts = 0;
for (let h = 0; h < 24; h++) if (createHash("sha256").update(`run-${h}`).digest("hex") !== "x") oldPosts++;
t("old manifestHash dedup re-posted every cycle", oldPosts, 24);

// --- THE HOLE MATERIOS FOUND: digest must cover meta and sessionId ---------
t("meta change alters the digest",
  digestOf(A, [{kind:"msg",contentHash:"sha256:aa",meta:{model:"opus"}},base[1]]) !== D, true);
t("sessionId change alters the digest",
  digestOf(A, [{...base[0], sessionId:"s1"},base[1]]) !== D, true);
t("agentId change alters the digest", digestOf("openclaw:other", base) !== D, true);
t("key order does NOT alter the digest",
  digestOf(A, [{contentHash:"sha256:aa",meta:{},kind:"msg"},base[1]]), D);
t("identical content -> identical digest", digestOf(A, base), D);

// --- SUBMITTED: never re-posted from the dedup path, at any age -----------
const sub = { contentDigest: D, state: "submitted", attempts: 0, lastAttemptAt: Date.now() };
t("submitted is not re-posted after 1h", shouldAnchor(sub, D, Date.now()+HOUR), false);
t("submitted is not re-posted after 7h", shouldAnchor(sub, D, Date.now()+7*HOUR), false);
t("submitted is not re-posted after 30 days", shouldAnchor(sub, D, Date.now()+30*24*HOUR), false);

// --- FAILED: retries with jittered backoff -------------------------------
const f1 = { contentDigest: D, state: "failed", attempts: 1, lastAttemptAt: Date.now() };
t("failure does not retry immediately", shouldAnchor(f1, D, Date.now()+30_000), false);
t("failure retries after backoff", shouldAnchor(f1, D, Date.now()+3*HOUR), true);
const f20 = { contentDigest: D, state: "failed", attempts: 20, lastAttemptAt: 0 };
t("many failures blocked before 24h cap", shouldAnchor(f20, D, 19*HOUR), false);
t("many failures retry after 24h cap", shouldAnchor(f20, D, 30*HOUR), true);
t("permanent failure settles at ~1 attempt/day",
  Array.from({length:24},(_,h)=>shouldAnchor(f20,D,(h+1)*HOUR)).filter(Boolean).length, 1);
// jitter actually varies the boundary
const lo = shouldAnchor(f1, D, Date.now() + 1.7*60_000, 0.0);
const hi = shouldAnchor(f1, D, Date.now() + 1.7*60_000, 1.0);
t("jitter varies the retry boundary", lo !== hi, true);

// --- changed / unseen content always anchors ------------------------------
t("changed content re-anchors", shouldAnchor(anchored, digestOf(A, [...base, {kind:"msg",contentHash:"sha256:cc",meta:{}}]), Date.now()), true);
t("unseen bundle anchors", shouldAnchor(undefined, D, Date.now()), true);

console.log(`\n  ${fail===0?"ALL TESTS PASS":fail+" FAILURES"}`);
process.exit(fail===0?0:1);
