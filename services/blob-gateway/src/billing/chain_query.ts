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
import { warnThrottled } from "../middleware/warn-throttle.js";

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
 *
 * NOTE (L3, #225): when the WS connection drops, `apiPromise` is reset
 * inside the disconnect/error handlers but `lastConnectAttempt` is not
 * touched. Until the cooldown elapses (`RECONNECT_COOLDOWN_MS`, 30s) the
 * next `getOrConnectApi()` call returns `null` — which means during the
 * 30s window after a WS flap, EVERY billing query (balance, endpoint
 * price) returns `null`. In `live` mode the 402 middleware treats that
 * as "pallet not present" via `priceRes.price === null` and bypasses
 * gating, so the practical effect is a 30s billing-bypass window after
 * a WS disconnect (NOT a 30s burst of 402 responses). This is the
 * fail-open default we want — better to under-charge than 402-flood
 * legitimate traffic — but it's worth knowing for ops dashboards.
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

/**
 * Per-content-hash composite-trust-score lookup result. The chain stores a
 * `CompositeTrustScore(u8)` (0..=4) per receipt_id under the
 * `pallet-tee-attestation::CompositeTrustScores` storage map (ValueQuery,
 * default = 0).
 *
 * Score levels:
 *   0 = COMMITTEE_ATTESTED_BASELINE — default for any submitted receipt;
 *       no TEE evidence on chain yet.
 *   1 = SINGLE_VENDOR — one accepted TEE evidence record.
 *   2 = MULTI_VENDOR — evidence from 2+ distinct vendors.
 *   3 = MULTI_VENDOR_PLUS_BUILD — multi-vendor + reproducible-build
 *       attestation.
 *   4 = FULL_QUORUM — multi-vendor + build + ZK-proof attestation.
 *
 * IMPORTANT: `composite_trust_score === null` means "couldn't query the
 * chain" (RPC down / decode failure). `composite_trust_score === 0` means
 * "chain reachable, receipt has no TEE evidence yet". The two are
 * semantically distinct — a downstream consumer waiting for the field to
 * become non-zero (see Path C harness `_wait_for_anchor`) MUST NOT treat
 * `null` as `0`.
 */
export interface ChainTrustScore {
  content_hash: string;
  receipt_id: string;
  /** 0..=4 from chain; null only when RPC unreachable / query failed. */
  composite_trust_score: number | null;
}

/**
 * Bulk composite-trust-score lookup. Mirrors `queryReceiptStatuses` shape
 * (one storage query per content_hash, run concurrently); the only delta
 * is the storage map — `teeAttestation.compositeTrustScores(receipt_id)`
 * vs `orinqReceipts.receipts(receipt_id)`.
 *
 * The two queries are independent so the route handler can issue both via
 * `Promise.all` and only pay the latency of the slower one.
 *
 * If the API connection is down, every record gets
 * `composite_trust_score: null` — the route surfaces that as null in the
 * response so callers can distinguish "no TEE evidence yet" (= 0) from
 * "couldn't ask the chain" (= null).
 *
 * `ValueQuery` semantics on the chain mean the storage map ALWAYS returns
 * a value (0 default for missing keys). So `result.isEmpty` shouldn't fire
 * here, but we handle it defensively for forward-compat with future
 * pallet revisions that might switch to OptionQuery.
 *
 * Test hook: `apiOverride` lets unit tests inject a stub. Identical
 * shape to `queryReceiptStatuses`.
 */
export async function queryCompositeTrustScores(
  contentHashes: readonly string[],
  apiOverride?: unknown,
): Promise<ChainTrustScore[]> {
  if (contentHashes.length === 0) return [];

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
      // Connection unavailable — surface null per record (NOT 0). We must
      // preserve the distinction between "chain says no evidence" and
      // "couldn't ask chain".
      return ids.map((x) => ({
        content_hash: x.content_hash,
        receipt_id: x.receipt_id,
        composite_trust_score: null,
      }));
    }
    try {
      api = await pending;
    } catch {
      return ids.map((x) => ({
        content_hash: x.content_hash,
        receipt_id: x.receipt_id,
        composite_trust_score: null,
      }));
    }
  }

  // Issue queries concurrently. A single failure (e.g. metadata mismatch
  // from a forkless upgrade not yet picked up) degrades only that record,
  // not the whole batch.
  const out = await Promise.all(
    ids.map(async ({ content_hash, receipt_id }): Promise<ChainTrustScore> => {
      try {
        // The pallet may not be present on chains that haven't received
        // the spec-213/214 runtime upgrade — guard against undefined to
        // avoid throwing inside the .map.
        const teeQuery = api.query?.teeAttestation?.compositeTrustScores;
        if (typeof teeQuery !== "function") {
          return { content_hash, receipt_id, composite_trust_score: null };
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result: any = await teeQuery(receipt_id);
        if (result?.isEmpty === true) {
          // OptionQuery / forward-compat path: treat as "no evidence".
          return { content_hash, receipt_id, composite_trust_score: 0 };
        }
        // `CompositeTrustScore(pub u8)` — substrate may decode this as a
        // bare number, a `{ value: number }` shape, or a Codec with
        // `.toNumber()`. Handle all three so the gateway doesn't rev-lock
        // to a specific @polkadot/api version.
        const raw = result?.toJSON?.() ?? result;
        let score: number | null = null;
        if (typeof raw === "number") {
          score = raw;
        } else if (raw && typeof raw === "object") {
          const o = raw as Record<string, unknown>;
          const cand = o.value ?? o[0] ?? o;
          if (typeof cand === "number") {
            score = cand;
          } else if (cand && typeof (cand as { toNumber?: () => number }).toNumber === "function") {
            score = (cand as { toNumber: () => number }).toNumber();
          }
        }
        if (score === null && typeof (result as { toNumber?: () => number })?.toNumber === "function") {
          score = (result as { toNumber: () => number }).toNumber();
        }
        if (score === null || !Number.isFinite(score)) {
          return { content_hash, receipt_id, composite_trust_score: null };
        }
        // Clamp to the expected 0..=4 band — anything else is a decode
        // bug, not a valid score, so surface null rather than confuse the
        // consumer with a fabricated value.
        const intScore = Math.trunc(score);
        if (intScore < 0 || intScore > 4) {
          return { content_hash, receipt_id, composite_trust_score: null };
        }
        return { content_hash, receipt_id, composite_trust_score: intScore };
      } catch {
        return { content_hash, receipt_id, composite_trust_score: null };
      }
    }),
  );

  return out;
}

// ---------------------------------------------------------------------------
// pallet-billing reads (Phase 2.A)
// ---------------------------------------------------------------------------
//
// These are the gateway-side reads of the new pallet-billing storage that
// Phase 2.A introduces. While the pallet is not yet wired into the runtime
// (or while a chain reset has un-deployed it) ALL of these return `null` —
// the 402 middleware then bypasses gating instead of failing closed. Once
// the pallet is live, these return concrete values.
//
// Pricing model variants come from the pallet's `types::PricingModel`:
//   PerCall(u128)
//   PerByte { unit_price: u128 }
// We don't import the pallet's TS types directly (there isn't a generated
// binding yet); we shape-match the SCALE-decoded shape via @polkadot/api's
// generic codec.

export interface BillingBalanceResult {
  ss58: string;
  /** MATRA base units (15 decimals). `null` = pallet not present or RPC down. */
  balance: bigint | null;
}

/** Read `pallet-billing::Balances[ss58]`. Returns null on any failure. */
export async function queryBillingBalance(
  ss58: string,
): Promise<BillingBalanceResult> {
  const pending = getOrConnectApi();
  if (!pending) return { ss58, balance: null };
  try {
    const api = await pending;
    // `query.billing` only exists after pallet-billing is wired into the
    // runtime via `construct_runtime!`. Until then this throws.
    const billing = (api.query as unknown as Record<string, unknown>).billing;
    if (!billing || typeof (billing as { balances?: unknown }).balances !== "function") {
      return { ss58, balance: null };
    }
    const raw = await (billing as {
      balances: (who: string) => Promise<{ toBigInt(): bigint }>;
    }).balances(ss58);
    return { ss58, balance: raw.toBigInt() };
  } catch {
    return { ss58, balance: null };
  }
}

export interface EndpointQuoteResult {
  endpointClass: string;
  /** MATRA base units (15 decimals). `null` = pallet not present. */
  price: bigint | null;
}

/**
 * Compute the MATRA charge for one request via pallet-billing's
 * `quote_price` semantics: looks up `EndpointPrices[endpoint_class]`,
 * dispatches PerCall vs PerByte.
 *
 * Implementation note: we read the raw enum from chain and discriminate
 * here rather than calling a custom RPC (which would require building
 * `pallet-billing-rpc` first). Reads two storage slots max.
 */
export async function queryEndpointPrice(
  endpointClass: string,
  requestBytes: number,
): Promise<EndpointQuoteResult> {
  const pending = getOrConnectApi();
  if (!pending) return { endpointClass, price: null };
  try {
    const api = await pending;
    const billing = (api.query as unknown as Record<string, unknown>).billing;
    if (
      !billing ||
      typeof (billing as { endpointPrices?: unknown }).endpointPrices !==
        "function"
    ) {
      return { endpointClass, price: null };
    }
    const raw = await (billing as {
      endpointPrices: (k: Uint8Array | string) => Promise<unknown>;
    }).endpointPrices(Buffer.from(endpointClass, "utf8"));
    return {
      endpointClass,
      price: decodePricingModel(raw, requestBytes),
    };
  } catch {
    return { endpointClass, price: null };
  }
}

/**
 * Translate a SCALE-decoded `PricingModel` enum into a u128 MATRA charge.
 *
 * @polkadot/api decodes enums as objects with `isPerCall` / `isPerByte`
 * boolean getters and `asPerCall` / `asPerByte` accessors. We tolerate
 * either that shape OR a plain JSON dict shape (test-mock compatibility).
 *
 * Saturation: a malicious or governance-set `PerByte` with huge unit_price
 * can theoretically overflow `u128 * u64`. The pallet uses `saturating_mul`
 * which clamps to `u128::MAX`. We mirror that here with bigint saturation.
 */
export function decodePricingModel(raw: unknown, requestBytes: number): bigint {
  const U128_MAX = (1n << 128n) - 1n;
  const bytes = BigInt(Math.max(0, requestBytes));

  // @polkadot/api codec shape
  const codec = raw as {
    isPerCall?: boolean;
    isPerByte?: boolean;
    asPerCall?: { toBigInt(): bigint };
    asPerByte?: { unitPrice: { toBigInt(): bigint } };
  };
  if (codec && typeof codec.isPerCall === "boolean") {
    if (codec.isPerCall && codec.asPerCall) {
      return codec.asPerCall.toBigInt();
    }
    if (codec.isPerByte && codec.asPerByte) {
      const unit = codec.asPerByte.unitPrice.toBigInt();
      const product = unit * bytes;
      return product > U128_MAX ? U128_MAX : product;
    }
  }

  // Plain JSON dict shape (test mocks, or `toJSON()`-style readers).
  const json = raw as { PerCall?: string | number; PerByte?: { unit_price?: string | number; unitPrice?: string | number } };
  if (json && json.PerCall !== undefined) {
    return BigInt(json.PerCall);
  }
  if (json && json.PerByte) {
    const unit = BigInt(json.PerByte.unit_price ?? json.PerByte.unitPrice ?? 0);
    const product = unit * bytes;
    return product > U128_MAX ? U128_MAX : product;
  }

  // M2 (#223): the on-chain `PricingModel` is an open enum — a forkless
  // runtime upgrade could introduce a new variant (e.g. `PerCallPerByte`,
  // or a tiered-pricing dict). Both decode paths above would miss it and
  // silently return 0n, turning every request priced under that variant
  // into a free request without any operational signal. Emit a warn so
  // ops sees the regression in the gateway's structured log stream.
  //
  // We still return 0n (fail-safe — better to under-charge than block
  // legitimate traffic), but the warn line is the bell that calls
  // attention to the variant gap. Pair this with the runtime-upgrade
  // checklist: any new PricingModel variant requires a gateway bump in
  // lockstep.
  //
  // #227 Part 2: throttle the warn to once per minute per variant-key so
  // a forkless-upgrade ahead of the gateway image doesn't write N warns/sec
  // under load. The first occurrence per distinct variant still surfaces
  // promptly; repeats are dropped until the throttle elapses.
  const rawKeys =
    typeof raw === "object" && raw !== null ? Object.keys(raw) : [];
  const variantKey = rawKeys.join(",");
  warnThrottled(`billing.unknown_pricing_variant:${variantKey}`, {
    log: "billing.unknown_pricing_variant",
    raw_keys: rawKeys,
  });
  // Unknown / unset → free, mirrors `PricingModel::FREE` default in the pallet.
  return 0n;
}

/** Test hook: clear the cached ApiPromise so the next call re-connects. */
export function resetChainQueryForTests(): void {
  apiPromise = null;
  lastConnectAttempt = 0;
}
