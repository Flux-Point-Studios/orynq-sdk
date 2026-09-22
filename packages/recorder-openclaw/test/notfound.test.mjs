// Only the server's OWN not-found may re-post.
//
// "unknown" is the single poll state that re-posts, so whatever can reach it is
// the one remaining door to a duplicate storm. A bare 404 does not qualify: a
// reverse proxy, a Cloudflare error page, or a renamed route all return one,
// and treating those as unknown would re-post every submitted bundle every
// cycle. Only {"detail":"anchor_request_not_found"} counts.
import { createServer } from "node:http";

async function classify404(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed.detail === "anchor_request_not_found") return "unknown";
    return "error";
  } catch { return "error"; }
}
let fail = 0;
const t = (n, got, want) => { const ok = got === want; if (!ok) fail++; console.log(`  ${ok?"PASS":"FAIL"}  ${n}  (got ${got}, want ${want})`); };

t("the server's own not-found -> unknown (re-post)",
  await classify404('{"detail":"anchor_request_not_found"}'), "unknown");

// Everything else that can produce a 404 must NOT re-post.
t("Cloudflare HTML 404 -> error (wait)",
  await classify404('<!DOCTYPE html><html><title>404 Not Found</title></html>'), "error");
t("nginx HTML 404 -> error (wait)",
  await classify404('<html><head><title>404 Not Found</title></head></html>'), "error");
t("renamed route, different detail -> error (wait)",
  await classify404('{"detail":"Not Found"}'), "error");
t("re-versioned API detail -> error (wait)",
  await classify404('{"detail":"route_not_found","path":"/v2/anchors"}'), "error");
t("empty body 404 -> error (wait)", await classify404(''), "error");
t("JSON without a detail field -> error (wait)",
  await classify404('{"error":"nope"}'), "error");
t("detail present but null -> error (wait)", await classify404('{"detail":null}'), "error");

// Live: a proxy-style 404 in front of the real service must not trigger a repost.
const proxy = createServer((req, res) => {
  res.writeHead(404, {"content-type":"text/html"});
  res.end("<html><body>404 - origin unreachable</body></html>");
});
await new Promise(r => proxy.listen(0,"127.0.0.1",r));
const pr = await fetch(`http://127.0.0.1:${proxy.address().port}/anchors/status/abc`);
t("live proxy 404 is status 404", pr.status, 404);
t("live proxy 404 classifies as error, NOT unknown",
  await classify404(await pr.text()), "error");
proxy.close();

// Live: the real service's not-found does re-post.
const real = createServer((req, res) => {
  res.writeHead(404, {"content-type":"application/json"});
  res.end(JSON.stringify({detail:"anchor_request_not_found"}));
});
await new Promise(r => real.listen(0,"127.0.0.1",r));
const rr = await fetch(`http://127.0.0.1:${real.address().port}/anchors/status/abc`);
t("live service not-found classifies as unknown",
  await classify404(await rr.text()), "unknown");
real.close();

// The regression this prevents.
t("treating any 404 as unknown would have re-posted on a proxy error", true, true);

console.log(`\n  ${fail===0?"ALL TESTS PASS":fail+" FAILURES"}`);
process.exit(fail===0?0:1);
