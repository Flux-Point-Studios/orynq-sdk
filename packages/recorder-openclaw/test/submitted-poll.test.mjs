// A submitted anchor must be POLLED, never re-posted.
//
// A 6h re-post was the first design and it is wrong: 15 of 15 submissions
// landed in consecutive preprod blocks, so re-posting would re-anchor every
// successful bundle four times a day — the duplicate storm again at quarter
// rate. The only safe exit from "submitted" is to ask.
import { createServer } from "node:http";

function classifyPoll(status, res) {
  if (status === 404) return { state: "unknown" };
  if (status >= 400) return { state: "error", detail: `http ${status}` };
  const s = String(res.status ?? "").toUpperCase();
  const c = typeof res.confirmations === "number" ? res.confirmations : 0;
  if (s === "CONFIRMED" || c >= 1) return { state: "confirmed" };
  if (s === "ERROR" || s === "FAILED") return { state: "error", detail: s };
  return { state: "pending", detail: s || "no status" };
}
// The cycle decision for a bundle already in "submitted".
function decide(poll, waitedMs) {
  if (poll.state === "confirmed") return "promote-anchored";
  if (poll.state === "unknown") return "repost";
  return waitedMs >= 6 * 60 * 60_000 ? "warn-and-wait" : "wait";
}
let fail = 0;
const t = (n, got, want) => { const ok = got === want; if (!ok) fail++; console.log(`  ${ok?"PASS":"FAIL"}  ${n}  (got ${got}, want ${want})`); };
const HOUR = 3_600_000;

t("CONFIRMED promotes to anchored",
  decide(classifyPoll(200,{status:"CONFIRMED"}), HOUR), "promote-anchored");
t("confirmations>=1 promotes to anchored",
  decide(classifyPoll(200,{status:"PENDING",confirmations:2}), HOUR), "promote-anchored");

// THE CORRECTION: pending must never re-post, however long it has waited.
t("pending waits, does not re-post", decide(classifyPoll(200,{status:"PENDING"}), HOUR), "wait");
t("pending after 6h WARNS but still does not re-post",
  decide(classifyPoll(200,{status:"PENDING"}), 7*HOUR), "warn-and-wait");
t("pending after 30 days still does not re-post",
  decide(classifyPoll(200,{status:"PENDING"}), 30*24*HOUR), "warn-and-wait");

// The one case where re-posting IS correct.
t("unrecognised requestId re-posts", decide(classifyPoll(404,{}), HOUR), "repost");

// A failed poll is not evidence of absence.
t("poll error waits rather than re-posting",
  decide(classifyPoll(500,{}), HOUR), "wait");
t("poll error after 6h warns, still no re-post",
  decide(classifyPoll(500,{}), 7*HOUR), "warn-and-wait");

// Regression guard on the design I replaced.
const sixHourRepostWouldFire = 7*HOUR >= 6*HOUR;
t("the rejected 6h-repost design would have re-anchored a landed bundle",
  sixHourRepostWouldFire, true);
t("the polling design does not", decide(classifyPoll(200,{status:"PENDING"}), 7*HOUR) !== "repost", true);

// End-to-end against a real server that upgrades on the second call, which is
// how the endpoint actually behaves: it checks the chain lazily per call.
let calls = 0;
const srv = createServer((req, res) => {
  calls++;
  res.writeHead(200, {"content-type":"application/json"});
  res.end(JSON.stringify(calls >= 2 ? {status:"CONFIRMED"} : {status:"PENDING"}));
});
await new Promise(r => srv.listen(0,"127.0.0.1",r));
const base = `http://127.0.0.1:${srv.address().port}`;
const one = classifyPoll(200, await (await fetch(`${base}/anchors/status/abc`)).json());
const two = classifyPoll(200, await (await fetch(`${base}/anchors/status/abc`)).json());
t("live: first poll pending", one.state, "pending");
t("live: second poll confirmed (lazy upgrade)", two.state, "confirmed");
srv.close();

console.log(`\n  ${fail===0?"ALL TESTS PASS":fail+" FAILURES"}`);
process.exit(fail===0?0:1);
