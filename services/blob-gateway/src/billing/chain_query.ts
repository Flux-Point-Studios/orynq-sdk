/**
 * Materios chain RPC wrapper for the billing-query endpoint (#112).
 *
 * Given a list of `content_hash`es (the gateway-derived hash, hex), look up
 * the on-chain receipt status for each one. The chain doesn't index by
 * content_hash directly; the receipt-id IS deterministic from the
 * content_hash (`receipt_id = sha256(content_hash_bytes)` per
 * `storage.ts::computeReceiptId`), so we compute the receipt-id locally
 * and storage-query `orinqReceipts.receipts(receipt_id)`.
 *
 * Status semantics (mirror `rpc-client.ts::checkReceiptStatus`):
 *   - "certified": receipt exists AND availability_cert_hash != zero-hash
 *   - "pending":   receipt exists AND availability_cert_hash == zero-hash
 *   - "unknown":   receipt does not exist on chain (yet) OR RPC failed
 *
 * The "unknown" path is graceful — a billing query MUST not fail because a
 * record's chain leg hasn't landed yet. The route surfaces "unknown" as
 * `attestation_status="unknown"` + null `attestation_cert_hash`, and the
 * audit_trail block records `chain_query_ms` so customers can see how long
 * the lookups took.
 *
 * Caching: each ApiPromise is shared via `getOrConnectApi()` so the
 * gateway only opens a single WS connection regardless of how many
 * billing requests fly through. Reconnect cooldown matches `rpc-client.ts`.
 *
 * `@polkadot/api` is heavy — keep the dependency footprint here narrow,
 * and don't pull in the SDK helpers (the SDK's `submitReceipt` etc. live
 * in a different package).
 */

import { ApiPromise, WsProvider } from "@polkadot/api";
import { createHash } from "crypto";
import { config } from "../config.js";
import type { AttestationStatus } from "./aggregate.js";

const ZERO_HASH_NO_PREFIX = "00".repeat(32);
const RECONNECT_COOLDOWN_MS = 30_000;

/**
 * Per-content-hash lookup result. `cert_hash` is null when status !=
 * "certified" — we never fabricate a hash, callers must treat null as
 * "no certification on chain yet".
 */
export interface ChainStatus {
  content_hash: string;
  receipt_id: string;
  status: AttestationStatus;
  cert_hash: string | null;
}

let apiPromise: Promise<ApiPromise> | null = null;
let lastConnectAttempt = 0;

/**
 * Lazy-initialise (or reuse) the Materios @polkadot/api connection.
 *
 * Returns null when we've recently failed to connect — callers degrade to
 * `status: "unknown"` rather than queueing waiters or blocking. A separate
 * cooldown timer governs the next connect attempt.
 */
function getOrConnectApi(): Promise<ApiPromise> | null {
  if (apiPromise) return apiPromise;
  if (Date.now() - lastConnectAttempt < RECONNECT_COOLDOWN_MS) return null;
  lastConnectAttempt = Date.now();

  const provider = new WsProvider(config.materiosRpcUrl, /* autoConnectMs */ 5000);
  apiPromise = ApiPromise.create({ provider, noInitWarn: true });
  apiPromise
    .then((api) => {
      api.on("disconnected", () => {
        apiPromise = null;
      });
      api.on("error", () => {
        apiPromise = null;
      });
    })
    .catch(() => {
      apiPromise = null;
    });
  return apiPromise;
}

/**
 * Compute the deterministic receipt_id from a content_hash hex string.
 * Identical to `storage.ts::computeReceiptId` but kept here so callers
 * don't pull in fs-touching modules.
 */
export function receiptIdFromContentHash(contentHashHex: string): string {
  const clean = contentHashHex.startsWith("0x")
    ? contentHashHex.slice(2)
    : contentHashHex;
  const digest = createHash("sha256").update(Buffer.from(clean, "hex")).digest("hex");
  return "0x" + digest;
}

/**
 * Bulk chain status lookup. Issues one `orinqReceipts.receipts(receipt_id)`
 * storage query per content_hash; each is independent so we run them
 * concurrently with `Promise.all`. Substrate's WS handles multiplexed
 * requests fine.
 *
 * If the API connection is down, every record gets `status: "unknown"`
 * with a null cert_hash. The route surfaces a `chain_query_ms = elapsed`
 * regardless so the customer sees that the lookup happened.
 *
 * Test hook: `apiOverride` lets unit tests inject a stub that exposes
 * just `query.orinqReceipts.receipts`. We deliberately accept `unknown`
 * here so the test stub doesn't need to import the heavy ApiPromise type.
 */
export async function queryReceiptStatuses(
  contentHashes: readonly string[],
  apiOverride?: unknown,
): Promise<ChainStatus[]> {
  if (contentHashes.length === 0) return [];

  // Deduplicate — multiple records can hash-collide in theory but in
  // practice the same content_hash maps to one receipt. We over-fetch
  // anyway; caller maps results back by content_hash.
  const uniq = Array.from(new Set(contentHashes));
  const ids: { content_hash: string; receipt_id: string }[] = uniq.map(
    (contentHashHex) => ({
      content_hash: contentHashHex,
      receipt_id: receiptIdFromContentHash(contentHashHex),
    }),
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any = apiOverride;
  if (api === undefined) {
    const pending = getOrConnectApi();
    if (!pending) {
      return ids.map((x) => ({
        content_hash: x.content_hash,
        receipt_id: x.receipt_id,
        status: "unknown",
        cert_hash: null,
      }));
    }
    try {
      api = await pending;
    } catch {
      return ids.map((x) => ({
        content_hash: x.content_hash,
        receipt_id: x.receipt_id,
        status: "unknown",
        cert_hash: null,
      }));
    }
  }

  // Issue queries concurrently. A single failure (e.g. malformed receipt
  // hex on a transient decoder fault) degrades only that record, not the
  // whole batch.
  const out = await Promise.all(
    ids.map(async ({ content_hash, receipt_id }): Promise<ChainStatus> => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result: any = await api.query.orinqReceipts.receipts(receipt_id);
        if (result.isEmpty) {
          return { content_hash, receipt_id, status: "unknown", cert_hash: null };
        }
        const record = result.toJSON() as Record<string, unknown>;
        const certHashRaw = String(
          record.availability_cert_hash ?? record.availabilityCertHash ?? "",
        );
        const cert = certHashRaw.startsWith("0x")
          ? certHashRaw.slice(2)
          : certHashRaw;
        if (!cert || cert === ZERO_HASH_NO_PREFIX) {
          return { content_hash, receipt_id, status: "pending", cert_hash: null };
        }
        return {
          content_hash,
          receipt_id,
          status: "certified",
          cert_hash: "0x" + cert,
        };
      } catch {
        return { content_hash, receipt_id, status: "unknown", cert_hash: null };
      }
    }),
  );

  return out;
}

/** Test hook: clear the cached ApiPromise so the next call re-connects. */
export function resetChainQueryForTests(): void {
  apiPromise = null;
  lastConnectAttempt = 0;
}
