/**
 * Sponsored-receipt notification hook.
 *
 * When a Bearer- or api-key-authed upload completes, the gateway fires a
 * fire-and-forget POST to an external submitter service that holds the
 * operator signing keys and turns the upload into an on-chain receipt.
 *
 * This keeps the gateway free of any sr25519 signer state — signing infra
 * lives in a dedicated service (or, for now, a bespoke operator worker)
 * that is the ONLY place an operator keypair is loaded. If the submitter
 * URL is not configured the hook is a no-op; existing non-sponsored
 * flows (sig-only uploads with their own signer) are unaffected.
 *
 * Contract with the submitter (HTTP):
 *   POST <url>
 *   Headers:
 *     content-type: application/json
 *     authorization: Bearer <SPONSORED_RECEIPT_SUBMITTER_TOKEN>  (if set)
 *   Body:
 *     {
 *       "contentHash": "<64 hex, no 0x>",
 *       "operator":    "<SS58 address the upload was authed against>",
 *       "authTier":    "bearer" | "api-key" | "api-key-legacy-ss58",
 *       "rootHash":    "<64 hex from manifest, optional>",
 *       "manifestHash":"<sha256 of the canonical manifest JSON>",
 *       "source":      "blob-gateway"
 *     }
 *   Response:
 *     2xx → gateway considers the receipt delegated and moves on
 *     non-2xx → gateway logs a warning; the blob stays complete on the
 *               gateway and the cleanup sweep will reap it after
 *               RECEIPT_GRACE_HOURS if no on-chain receipt appears.
 */
import { config } from "./config.js";

export interface SponsoredReceiptPayload {
  contentHash: string;
  operator: string;
  authTier: "bearer" | "api-key" | "api-key-legacy-ss58";
  rootHash?: string;
  manifestHash?: string;
}

/**
 * Fire-and-forget notification. Resolves when the POST completes OR the
 * configured timeout elapses OR the submitter responds, whichever comes
 * first. Never throws — all errors become warn-log lines.
 */
export async function notifySponsoredReceiptSubmitter(
  payload: SponsoredReceiptPayload,
): Promise<void> {
  const url = config.sponsoredReceiptSubmitterUrl;
  if (!url) return;

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (config.sponsoredReceiptSubmitterToken) {
    headers["authorization"] = "Bearer " + config.sponsoredReceiptSubmitterToken;
  }

  const body = JSON.stringify({
    contentHash: payload.contentHash,
    operator: payload.operator,
    authTier: payload.authTier,
    rootHash: payload.rootHash,
    manifestHash: payload.manifestHash,
    source: "blob-gateway",
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    config.sponsoredReceiptNotifyTimeoutMs,
  );

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(
        `[blob-gateway] sponsored-receipt-submitter non-2xx: ${res.status} ` +
          `hash=${payload.contentHash} operator=${payload.operator} ` +
          `body=${text.slice(0, 200)}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[blob-gateway] sponsored-receipt-submitter fetch error: ${msg} ` +
        `hash=${payload.contentHash} operator=${payload.operator}`,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * True when the given auth tier is a sponsored upload — i.e. an operator
 * has taken responsibility for the bytes via token or legacy key, rather
 * than signing each upload individually with their own keypair.
 */
export function isSponsoredTier(
  tier: string | undefined,
): tier is "bearer" | "api-key" | "api-key-legacy-ss58" {
  return (
    tier === "bearer" ||
    tier === "api-key" ||
    tier === "api-key-legacy-ss58"
  );
}
