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
  /**
   * Optional schema hash override. When set (e.g. by the
   * `compute_metering_v1` route via `schemas/compute_metering_v1.ts`'s
   * `SCHEMA_HASH_HEX`), the submitter is expected to pass it as
   * `submit_receipt_v2(schema_hash = ...)`. When unset (existing manifest
   * flow), the submitter uses its own default (sha256 of "manifest_v1") so
   * existing callers don't change behaviour.
   *
   * Hex, 64 chars, no `0x` prefix.
   */
  schemaHash?: string;
  /**
   * Optional override for the `source` field in the outbound payload.
   * Defaults to `"blob-gateway"`. Set to `"compute-metering-v1"` (or another
   * stable string) when the submitter needs to route the request through a
   * non-default code path (e.g. compute-portal billing).
   */
  source?: string;
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

  // Include `schemaHash` only when caller supplied it — keeps the wire shape
  // identical for the legacy manifest flow so existing submitter
  // implementations don't see new fields they may reject as unknown.
  const bodyShape: Record<string, unknown> = {
    contentHash: payload.contentHash,
    operator: payload.operator,
    authTier: payload.authTier,
    rootHash: payload.rootHash,
    manifestHash: payload.manifestHash,
    source: payload.source ?? "blob-gateway",
  };
  if (payload.schemaHash) bodyShape.schemaHash = payload.schemaHash;
  const body = JSON.stringify(bodyShape);

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
