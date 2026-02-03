export async function anchorManifest(params: {
  baseUrl: string;
  endpointPath: string;
  partnerKey?: string;
  manifest: Record<string, unknown>;
}) {
  const { baseUrl, endpointPath, partnerKey, manifest } = params;
  const url = `${baseUrl.replace(/\/$/, "")}${endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`}`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (partnerKey) headers["X-Partner"] = partnerKey;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ manifest })
  });

  const text = await res.text();
  let json: Record<string, unknown>;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  return { status: res.status, ok: res.ok, json };
}
