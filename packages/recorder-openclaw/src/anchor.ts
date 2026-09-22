import { classifyNotFoundBody } from "./anchor-policy.js";
export async function anchorManifest(params: {
  baseUrl: string;
  endpointPath: string;
  partnerKey?: string;
  manifest: Record<string, unknown>;
  timeoutMs?: number;
}) {
  const { baseUrl, endpointPath, partnerKey, manifest } = params;
  const url = `${baseUrl.replace(/\/$/, "")}${endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`}`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (partnerKey) headers["X-Partner"] = partnerKey;

  // Item 5: an unbounded fetch can hang the whole anchor cycle indefinitely —
  // the daemon has no other thread, so one stalled socket stops all anchoring
  // with no error and no log line.
  const timeoutMs = params.timeoutMs ?? 60_000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  // The deadline must cover the body as well as the headers: a server that
  // sends headers and then stalls or trickles the body would otherwise hold
  // the cycle until undici's idle timer, or forever.
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ manifest }),
      signal: ac.signal
    });
    const text = await res.text();
    let json: Record<string, unknown>;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, ok: res.ok, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll an earlier submission for confirmation.
 *
 * A submitted anchor must never be re-posted — today all 15 SUBMITTED anchors
 * landed on preprod in consecutive blocks, so re-posting would duplicate work
 * that already succeeded. The only safe way out of "submitted" is to ask.
 *
 * The endpoint is lazy: it checks the chain on each call and upgrades the row
 * when it finds the transaction. Nothing had ever called it, which is why every
 * row read confirmations=0.
 *
 * Returns "unknown" when the server does not recognise the requestId — the one
 * case where re-posting is correct — and "error" when the poll itself failed,
 * which must NOT be read as either confirmation or absence.
 */
export async function checkAnchorStatus(params: {
  baseUrl: string;
  requestId: string;
  partnerKey?: string;
  timeoutMs?: number;
}): Promise<{ state: "confirmed" | "pending" | "unknown" | "error"; detail?: string; txHash?: string }> {
  const { baseUrl, requestId, partnerKey } = params;
  const url = `${baseUrl.replace(/\/$/, "")}/anchors/status/${encodeURIComponent(requestId)}`;

  const headers: Record<string, string> = {};
  if (partnerKey) headers["X-Partner"] = partnerKey;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), params.timeoutMs ?? 30_000);
  try {
    const res = await fetch(url, { headers, signal: ac.signal });

    // A bare 404 is NOT proof the request never reached the server: a reverse
    // proxy, a Cloudflare error page, or a renamed/re-versioned route all
    // return one. Since "unknown" is the single state that re-posts, treating
    // any 404 as unknown would re-post every submitted bundle on every cycle
    // and reopen the duplicate storm through that one door.
    //
    // Only the server's own not-found counts, which it raises as
    //   HTTPException(status_code=404, detail="anchor_request_not_found")
    // Any other 404, and any non-JSON 404, is a poll error: wait.
    if (res.status === 404) {
      const raw = await res.text();
      // One definition of this rule: classifyNotFoundBody in anchor-policy.ts.
      // It previously lived here as well, so the unit probe covered a copy the
      // recorder never called — two copies of one rule, which is the defect
      // commit 7 exists to remove.
      return classifyNotFoundBody(raw) === "unknown"
        ? { state: "unknown", detail: "requestId not recognised" }
        : { state: "error", detail: "404 was not the server's own anchor_request_not_found" };
    }
    if (!res.ok) return { state: "error", detail: `http ${res.status}` };

    const body = (await res.json()) as Record<string, unknown>;
    const status = String(body.status ?? "").toUpperCase();
    const confirmations = typeof body.confirmations === "number" ? body.confirmations : 0;
    // Precedence matches classifyAnchorResponse: an explicit failure outranks
    // a confirmation count. The two classifiers disagreeing is how a body like
    // {"status":"FAILED","confirmations":1} polls as confirmed in one path and
    // failed in the other.
    if (status === "ERROR" || status === "FAILED") {
      return { state: "error", detail: `anchor reported ${status}` };
    }
    if (status === "CONFIRMED" || confirmations >= 1) {
      return typeof body.txHash === "string" && body.txHash.length > 0
        ? { state: "confirmed", txHash: body.txHash }
        : { state: "confirmed" };
    }
    return { state: "pending", detail: status || "no status" };
  } catch (err) {
    return { state: "error", detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
