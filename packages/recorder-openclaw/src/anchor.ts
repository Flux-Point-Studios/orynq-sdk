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

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ manifest }),
      signal: ac.signal
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json: Record<string, unknown>;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  return { status: res.status, ok: res.ok, json };
}
