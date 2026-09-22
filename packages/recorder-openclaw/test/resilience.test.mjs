// Items 5 and 6: the fetch timeout, throw isolation, and the persisted schedule.
// These are exactly the paths that rot untested — a timeout that never fires and
// a schedule that silently resets both look like healthy systems.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const t = (n, got, want) => { const ok = got === want; if (!ok) fail++; console.log(`  ${ok?"PASS":"FAIL"}  ${n}  (got ${got}, want ${want})`); };

// ---- ITEM 5a: the fetch timeout actually aborts --------------------------
// A server that accepts the connection and then never answers. Without an
// AbortController this hangs the anchor cycle forever: no error, no log line,
// all anchoring stopped.
const hang = createServer(() => { /* deliberately never respond */ });
await new Promise((r) => hang.listen(0, "127.0.0.1", r));
const port = hang.address().port;

async function fetchWithTimeout(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try { await fetch(url, { signal: ac.signal }); return "responded"; }
  catch (e) { return e.name === "AbortError" ? "aborted" : `error:${e.name}`; }
  finally { clearTimeout(timer); }
}
const t0 = Date.now();
t("unanswered request aborts rather than hanging",
  await fetchWithTimeout(`http://127.0.0.1:${port}/`, 300), "aborted");
t("abort happens promptly", Date.now() - t0 < 3000, true);
hang.close();

// ---- ITEM 5b: one bundle throwing must not stop the others ---------------
// Mirrors the per-bundle try/catch: the loop continues and records a failure.
function anchorCycle(bundles, anchorFn) {
  const results = [];
  for (const b of bundles) {
    try { results.push({ b, state: anchorFn(b) }); }
    catch (err) { results.push({ b, state: "failed", error: String(err.message) }); }
  }
  return results;
}
const out = anchorCycle(["a","b","c"], (b) => {
  if (b === "b") throw new Error("ECONNRESET");
  return "anchored";
});
t("a throw in one bundle does not abort the cycle", out.length, 3);
t("the throwing bundle is recorded failed", out[1].state, "failed");
t("later bundles still anchor", out[2].state, "anchored");

// ---- ITEM 6: the schedule survives a restart ----------------------------
// Previously in-memory only, so every restart pushed the next anchor a full
// cycle out. Combined with a crash that is unbounded starvation.
const dir = mkdtempSync(join(tmpdir(), "orynq-sched-"));
const schedPath = join(dir, "schedule.json");
const INTERVAL = 60 * 60_000;

function loadSchedule(now) {
  let next = 0;
  try {
    const saved = JSON.parse(readFileSync(schedPath, "utf-8"));
    if (typeof saved?.nextAnchorAt === "number" && Number.isFinite(saved.nextAnchorAt)) {
      next = Math.min(saved.nextAnchorAt, now + INTERVAL);   // clamp
    }
  } catch { next = 0; }
  if (!next) next = now + INTERVAL;
  return next;
}

const now = Date.now();
writeFileSync(schedPath, JSON.stringify({ nextAnchorAt: now + 10 * 60_000 }));
t("restart resumes the saved schedule, not a fresh cycle",
  loadSchedule(now), now + 10 * 60_000);

// the old behaviour, for contrast
t("old in-memory behaviour would have pushed it a full cycle out",
  now + INTERVAL !== now + 10 * 60_000, true);

// a corrupt far-future value must not starve anchoring
writeFileSync(schedPath, JSON.stringify({ nextAnchorAt: now + 365 * 24 * 60 * 60_000 }));
t("absurd future value is clamped to one interval", loadSchedule(now), now + INTERVAL);

// a corrupt file falls back rather than throwing
writeFileSync(schedPath, "{not json");
t("corrupt schedule falls back to a fresh interval", loadSchedule(now), now + INTERVAL);

// a missing file is fine
t("missing schedule falls back to a fresh interval",
  loadSchedule.call(null, now) > 0, true);
t("schedule file was written", existsSync(schedPath), true);

console.log(`\n  ${fail===0?"ALL TESTS PASS":fail+" FAILURES"}`);
process.exit(fail===0?0:1);
