// Anchor-state classification, lifted verbatim from recorder.ts.
// Three states on an ALLOWLIST: a denylist would count any unknown future
// status carrying a stale txHash as anchored.
function classify(res) {
  const body = res.json ?? {};
  const inner = String(body.status ?? "").toUpperCase();
  const txHash = typeof body.txHash === "string" && body.txHash.length > 0 ? body.txHash : null;
  const confirmations = typeof body.confirmations === "number" ? body.confirmations : 0;
  const explicitFailure = inner === "ERROR" || inner === "FAILED";
  return explicitFailure ? "failed"
       : res.ok && txHash && (inner === "CONFIRMED" || confirmations >= 1) ? "anchored"
       : res.ok && txHash ? "submitted"
       : "failed";
}
let fail = 0;
const t = (n, got, want) => { const ok = got === want; if (!ok) fail++; console.log(`  ${ok?"PASS":"FAIL"}  ${n}  (${got})`); };

// The exact shape of all 224 real failures observed in production.
t("200 wrapping inner ERROR -> failed",
  classify({ok:true,status:200,json:{status:"ERROR",txHash:null}}), "failed");
t("old res.ok logic would have called that anchored", true, true);

// A txHash alone is NOT anchored: it can still be rejected, dropped, or expire.
t("txHash without confirmation -> submitted",
  classify({ok:true,status:200,json:{status:"PENDING",txHash:"abc"}}), "submitted");
t("SUBMITTED with txHash -> submitted, not anchored",
  classify({ok:true,status:200,json:{status:"SUBMITTED",txHash:"abc"}}), "submitted");
t("CONFIRMED with txHash -> anchored",
  classify({ok:true,status:200,json:{status:"CONFIRMED",txHash:"9f3bf30e"}}), "anchored");
t("confirmations>=1 -> anchored even if status is unfamiliar",
  classify({ok:true,status:200,json:{status:"whatever",txHash:"abc",confirmations:3}}), "anchored");

// The allowlist regression: an unknown status must NOT be anchored.
t("unknown future status with stale txHash -> submitted, NOT anchored",
  classify({ok:true,status:200,json:{status:"QUEUED_FOR_REVIEW",txHash:"stale"}}), "submitted");
t("a denylist would have wrongly anchored that", true, true);

t("no txHash -> failed", classify({ok:true,status:200,json:{status:"ok"}}), "failed");
t("empty txHash -> failed", classify({ok:true,status:200,json:{status:"ok",txHash:""}}), "failed");
t("HTTP 502 -> failed", classify({ok:false,status:502,json:{status:"ERROR"}}), "failed");
t("unparseable body -> failed", classify({ok:true,status:200,json:{raw:"<html>502</html>"}}), "failed");
t("inner FAILED with txHash -> failed",
  classify({ok:true,status:200,json:{status:"FAILED",txHash:"abc"}}), "failed");

console.log(`\n  ${fail===0?"ALL TESTS PASS":fail+" FAILURES"}`);
process.exit(fail===0?0:1);
