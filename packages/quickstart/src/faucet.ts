/**
 * @summary Free-tier MATRA faucet client.
 *
 * The Materios preprod blob-gateway exposes `POST /blobs/faucet/drip` (and
 * `POST /faucet/drip` mounted at the same handler). One-shot per SS58
 * address, IP-cooldown 5 min on the un-prefixed path. The dripped MATRA
 * generates MOTRA (fee currency) over the next few blocks — that's how a
 * fresh dev pays for their first `submit_receipt` extrinsic without an
 * out-of-band funding step.
 *
 * Returns a discriminated union so callers can branch on `kind` without
 * sniffing error messages.
 */

export interface FaucetDripSuccess {
  kind: "success";
  txHash: string;
  amount: string;
  message: string;
}

export interface FaucetDripAlreadyFunded {
  kind: "already-funded";
  drippedAtMs: number;
}

export interface FaucetDripCooldown {
  kind: "cooldown";
  retryAfterMs: number;
  message: string;
}

export interface FaucetDripError {
  kind: "error";
  status: number;
  message: string;
}

export type FaucetDripResult =
  | FaucetDripSuccess
  | FaucetDripAlreadyFunded
  | FaucetDripCooldown
  | FaucetDripError;

export interface RequestFaucetOptions {
  /** SS58 address to drip MATRA into. */
  address: string;
  /**
   * Gateway base URL. Accepts either `https://host` or `https://host/blobs`.
   * The /blobs/-prefixed faucet path is preferred (per-address ledger);
   * the bare /faucet path adds an IP-level 5-min cooldown so we leave it
   * alone here.
   */
  gatewayBaseUrl: string;
  /**
   * Optional fetch impl injection (for tests + Cloudflare Workers).
   * Defaults to the global `fetch`.
   */
  fetchImpl?: typeof fetch | undefined;
  /**
   * Optional AbortSignal — propagated to the underlying fetch so callers
   * can wire up a Ctrl-C handler.
   */
  signal?: AbortSignal | undefined;
}

/**
 * Strip a trailing slash + trailing /blobs from a gateway base URL,
 * leaving the bare origin. The faucet route is mounted on the express
 * root (not the /blobs router) but is reachable via the nginx
 * reverse-proxy that prefixes /blobs — so the publicly-working URL
 * needs the /blobs segment exactly once.
 */
function normaliseToRoot(base: string): string {
  let s = base.trim();
  if (s.endsWith("/")) s = s.slice(0, -1);
  if (s.endsWith("/blobs")) s = s.slice(0, -"/blobs".length);
  return s;
}

/**
 * Drip MATRA to a fresh SS58 address.
 *
 * Idempotent at the caller's level: if the address has already been
 * dripped (per-address ledger), returns `kind: "already-funded"` instead
 * of throwing — the caller can treat both `success` and `already-funded`
 * as "we have MATRA, proceed".
 */
export async function requestFaucet(
  opts: RequestFaucetOptions,
): Promise<FaucetDripResult> {
  const f = opts.fetchImpl ?? fetch;
  const rootBase = normaliseToRoot(opts.gatewayBaseUrl);
  // /blobs/faucet/drip == the per-address-ledger faucet (preferred).
  // /faucet/drip == the IP-cooldown variant (we avoid it).
  const url = `${rootBase}/blobs/faucet/drip`;

  const fetchOpts: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: opts.address }),
  };
  if (opts.signal) {
    fetchOpts.signal = opts.signal;
  }
  const res = await f(url, fetchOpts);

  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Non-JSON body — surface the raw text as the error message.
    return {
      kind: "error",
      status: res.status,
      message: text.slice(0, 256),
    };
  }

  if (res.ok && json["success"] === true) {
    return {
      kind: "success",
      txHash: String(json["tx_hash"] ?? ""),
      amount: String(json["amount"] ?? ""),
      message: String(json["message"] ?? "MATRA dripped"),
    };
  }

  // Per-address dedup: 409 + "Address already received a drip" + dripped_at.
  if (res.status === 409 && typeof json["dripped_at"] === "number") {
    return { kind: "already-funded", drippedAtMs: Number(json["dripped_at"]) };
  }

  // IP-level cooldown (the un-prefixed /faucet/drip path uses this).
  if (
    res.status === 429 ||
    /cooldown/i.test(String(json["error"] ?? ""))
  ) {
    const retryAfterMs =
      typeof json["cooldown_ms"] === "number"
        ? Number(json["cooldown_ms"])
        : typeof json["retry_after_seconds"] === "number"
          ? Number(json["retry_after_seconds"]) * 1000
          : 0;
    return {
      kind: "cooldown",
      retryAfterMs,
      message: String(json["error"] ?? "Faucet cooldown active"),
    };
  }

  return {
    kind: "error",
    status: res.status,
    message: String(json["error"] ?? text.slice(0, 256) ?? "Unknown faucet error"),
  };
}
