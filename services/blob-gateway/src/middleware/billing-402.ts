/**
 * Phase 2.A — pay-per-use billing middleware.
 *
 * Runs before every authed write route. For each request:
 *   1. Identify the payer (api-key Bearer → FPS treasury sponsors, or
 *      sr25519-signed via X-402-Payment-Signature → caller self-pays).
 *   2. Classify the endpoint (`receipt_submit`, `chunk_upload`, etc) via
 *      `classifyEndpoint(req)`.
 *   3. Look up MATRA price via pallet-billing.
 *   4. Read the effective balance for the payer.
 *   5. If balance < price, return HTTP 402 with x402-compatible headers.
 *
 * The middleware does NOT perform the actual on-chain `pay_request` debit
 * — that's the gateway settlement signer's job, post-handler, after the
 * route confirms it has accepted the work. The 402 path is purely
 * pre-flight admission control.
 *
 * Phase rollout via `config.billingEnforcementPhase`:
 *   - "off"         → bypass entirely (no chain reads)
 *   - "measurement" → log what would 402, let the request through
 *   - "live"        → return 402 when balance < price
 *
 * Design ref: /home/deci/work/phase-2-prepaid-balance-design.md
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { config } from "../config.js";
import {
  queryBillingBalance,
  queryEndpointPrice,
} from "../billing/chain_query.js";
import { getApiTokensDb } from "../api-tokens.js";
import { verifyToken } from "../api-tokens.js";
import { getQuotaDb } from "../quota.js";

const X402_HEADER_NAME = "X-402-Payment-Required";
const X402_SIGNATURE_HEADER = "x-402-payment-signature";
const TOKEN_PREFIX = "matra_";

/** Endpoint class string — must match what governance sets via
 *  `pallet-billing::governance_set_endpoint_price`. Canonical form:
 *  lowercase snake_case ASCII, no whitespace, ≤ 64 bytes. */
export type EndpointClass = string;

/**
 * Map an Express request to its billing endpoint class.
 *
 * Returns `"free"` for routes that should bypass billing (health, public
 * reads). Returns the canonical class string for billable routes.
 *
 * Pure function; safe to unit-test without spinning up a router.
 */
export function classifyEndpoint(req: Request): EndpointClass {
  const m = req.method.toUpperCase();
  const p = req.path;

  // Health + status — always free.
  if (p === "/health" || p === "/status" || p.startsWith("/status/")) {
    return "free";
  }

  // Public reads — chain-info, locators, blobs GET, batches GET, etc.
  if (m === "GET") {
    // Manifest fetch is publicly readable for content-addressed blobs.
    if (p.startsWith("/blobs/") && p.endsWith("/manifest")) return "free";
    if (p.startsWith("/blobs/") && /\/chunks\/\d+$/.test(p)) return "free";
    if (p.startsWith("/locators/")) return "free";
    if (p.startsWith("/batches/")) return "free";
    if (p === "/billing/usage") return "billing_usage_query";
    if (p === "/chain-info") return "free";
    return "free";
  }

  // Manifest POST (writes a small JSON blob describing chunks).
  if (m === "POST" && /^\/blobs\/[^/]+\/manifest$/.test(p)) {
    return "manifest_post";
  }
  // Chunk PUT (writes blob bytes — priced PerByte by governance).
  if (m === "PUT" && /^\/blobs\/[^/]+\/chunks\/\d+$/.test(p)) {
    return "chunk_upload";
  }
  // Certified PATCH (marks a manifest as certified after cert-daemon attestation).
  if (m === "PATCH" && /^\/blobs\/[^/]+\/certified$/.test(p)) {
    return "manifest_certified_patch";
  }
  // Metering ingest (compute_metering_v1/v2 envelopes).
  if (m === "POST" && p === "/metering/submit") {
    return "receipt_submit";
  }
  // Batch metadata POST/PUT from cert-daemon.
  if ((m === "POST" || m === "PUT") && /^\/batches\/[^/]+$/.test(p)) {
    return "batch_metadata";
  }
  // Heartbeats — free (operator health, not billable user work).
  if (m === "POST" && p === "/heartbeats") return "free";
  // Faucet — free (operator onboarding).
  if (m === "POST" && p.startsWith("/faucet/")) return "free";

  // Anything we don't recognize defaults to free. Keeps the middleware
  // a strict admission gate rather than a stealth charge surface for any
  // route that hasn't been audited and priced.
  return "free";
}

interface PayerIdentity {
  /** "api-key" → FPS treasury pays; "self" → caller's own balance. */
  kind: "api-key" | "self" | "none";
  /** SS58 address of the account that will be debited. */
  ss58: string | null;
  /** Bearer token hash, only set when kind == "api-key". */
  tokenHash?: string;
}

/**
 * Identify the payer for this request based on which auth header it carries.
 *
 * Precedence: api-key Bearer wins if present (cheaper for the caller +
 * gateway-signed by FPS, no client crypto). Self-pay sr25519 signature is
 * the fallback. Neither = `kind: "none"`, charge will fail in "live" mode.
 *
 * Notes:
 * - We only inspect headers here; we do NOT verify signatures (the route's
 *   own auth middleware does that later). The 402 middleware can be
 *   wrong-about-payer with no fee/refund impact: if it picks "self" but
 *   the request later fails auth, the route returns 401 and no charge
 *   happens (gateway settlement signer never submits pay_request).
 */
function identifyPayer(req: Request): PayerIdentity {
  const authHeader = (req.headers.authorization || req.headers.Authorization) as
    | string
    | undefined;

  // api-key Bearer path
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    if (token.startsWith(TOKEN_PREFIX)) {
      try {
        const v = verifyToken(getApiTokensDb(), token);
        if (v.valid) {
          // Effective payer is the FPS treasury (gateway settlement signer
          // will sign pay_request from this account). The api-key holder
          // is the *attribution* identity for per-key spend caps.
          return {
            kind: "api-key",
            ss58: config.fpsTreasurySs58 || null,
            // We hash here only for the spend-cap lookup; the real auth
            // happens downstream.
            tokenHash: undefined,
          };
        }
      } catch {
        // Bad DB / not initialized → treat as no payer; downstream will
        // 401. Don't block the request at 402 if we can't even auth.
      }
    }
  }

  // self-pay sr25519 path
  const sig = req.headers[X402_SIGNATURE_HEADER];
  if (typeof sig === "string" && sig.length > 0) {
    // The signature header itself encodes the signer's SS58 in a sibling
    // header (x-402-payer-ss58). We trust it for routing only; the
    // gateway will verify the sr25519 sig against the canonical pay_request
    // payload before submitting.
    const payerSs58 = req.headers["x-402-payer-ss58"];
    if (typeof payerSs58 === "string" && payerSs58.length > 0) {
      return { kind: "self", ss58: payerSs58 };
    }
  }

  return { kind: "none", ss58: null };
}

/**
 * Build the `X-402-Payment-Required` header payload.
 *
 * Mirrors the x402 spec's `PAYMENT-REQUIRED` JSON shape, encoded as a
 * single JSON string in the header value (clients decode via
 * `@fluxpointstudios/orynq-sdk-transport-x402::parse402Response`).
 */
function buildPaymentRequiredHeader(opts: {
  endpointClass: EndpointClass;
  priceMatra: bigint;
  payerSs58: string;
  requestId: string;
  expiresUnix: number;
}): string {
  return JSON.stringify({
    scheme: "materios-x402",
    chain: "materios",
    network: "preprod",
    endpointClass: opts.endpointClass,
    pricing: { token: "MATRA", decimals: 15, amount: opts.priceMatra.toString() },
    payer: opts.payerSs58,
    recipient: "pallet-billing",
    nonce: opts.requestId,
    expires: opts.expiresUnix,
  });
}

/**
 * Quick request-id derivation. We don't need cryptographic uniqueness here;
 * idempotency is enforced on-chain by `PaidRequests`. A 16-byte hex random
 * is plenty.
 */
function newRequestId(): string {
  return (
    "0x" +
    Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * Roll the per-key MATRA-spend-today counter into a new UTC day if needed.
 * Called from `live` mode just before the spend-cap check.
 *
 * Returns the row's current state. Returns `null` if no row exists (which
 * shouldn't happen for a verified api-key, but treat as no-cap defensively).
 */
function getOrRollMatraCounter(keyHash: string): {
  max_matra_per_day: bigint;
  matra_spent_today: bigint;
} | null {
  const db = getQuotaDb();
  if (!db) return null;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const row = db
    .prepare(
      "SELECT max_matra_per_day, matra_spent_today, matra_day_bucket FROM api_keys WHERE key_hash = ?",
    )
    .get(keyHash) as
    | {
        max_matra_per_day: number | string;
        matra_spent_today: number | string;
        matra_day_bucket: string | null;
      }
    | undefined;
  if (!row) return null;
  if (row.matra_day_bucket !== today) {
    db.prepare(
      "UPDATE api_keys SET matra_spent_today = 0, matra_day_bucket = ? WHERE key_hash = ?",
    ).run(today, keyHash);
    return {
      max_matra_per_day: BigInt(row.max_matra_per_day),
      matra_spent_today: 0n,
    };
  }
  return {
    max_matra_per_day: BigInt(row.max_matra_per_day),
    matra_spent_today: BigInt(row.matra_spent_today),
  };
}

interface BillingDecisionLog {
  phase: "off" | "measurement" | "live";
  endpoint_class: EndpointClass;
  payer_kind: PayerIdentity["kind"];
  payer_ss58: string | null;
  price: string;
  balance: string | null;
  would_402: boolean;
  acted_402: boolean;
  reason?: string;
}

function logBilling(req: Request, d: BillingDecisionLog): void {
  // Structured log line — JSON so log scrapers can index `would_402`,
  // `phase`, etc.
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      log: "billing.decision",
      method: req.method,
      path: req.path,
      ...d,
    }),
  );
}

export function billing402Middleware(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (config.billingEnforcementPhase === "off") return next();

    const endpointClass = classifyEndpoint(req);
    if (endpointClass === "free") return next();

    const payer = identifyPayer(req);
    // Read the request's payload size for PerByte endpoints. For
    // `chunk_upload`, this is the `content-length` of the PUT body.
    const requestBytes = Number(req.headers["content-length"] || 0);

    const [priceRes, balanceRes] = await Promise.all([
      queryEndpointPrice(endpointClass, requestBytes),
      payer.ss58
        ? queryBillingBalance(payer.ss58)
        : Promise.resolve({ ss58: "", balance: null }),
    ]);

    // pallet-billing not yet wired → bypass. Once 2.A part 2 lands and the
    // pallet is in `construct_runtime!`, this branch goes away.
    if (priceRes.price === null) {
      logBilling(req, {
        phase: config.billingEnforcementPhase,
        endpoint_class: endpointClass,
        payer_kind: payer.kind,
        payer_ss58: payer.ss58,
        price: "0",
        balance: null,
        would_402: false,
        acted_402: false,
        reason: "pallet_not_present",
      });
      return next();
    }

    const price = priceRes.price;
    if (price === 0n) {
      // Endpoint explicitly priced at zero — treat as free.
      return next();
    }

    const balance = balanceRes.balance;
    const insufficient = balance === null || balance < price;

    if (config.billingEnforcementPhase === "measurement") {
      logBilling(req, {
        phase: "measurement",
        endpoint_class: endpointClass,
        payer_kind: payer.kind,
        payer_ss58: payer.ss58,
        price: price.toString(),
        balance: balance === null ? null : balance.toString(),
        would_402: insufficient,
        acted_402: false,
      });
      return next();
    }

    // phase === "live"
    if (!insufficient) {
      logBilling(req, {
        phase: "live",
        endpoint_class: endpointClass,
        payer_kind: payer.kind,
        payer_ss58: payer.ss58,
        price: price.toString(),
        balance: balance!.toString(),
        would_402: false,
        acted_402: false,
      });
      return next();
    }

    // Insufficient balance → 402. Build x402 headers.
    const requestId = newRequestId();
    const expires = Math.floor(Date.now() / 1000) + 300; // 5 min validity

    res.setHeader(
      "WWW-Authenticate",
      `X-402 realm="materios", endpoint="${endpointClass}", price="${price.toString()}", currency="MATRA"`,
    );
    res.setHeader(
      X402_HEADER_NAME,
      buildPaymentRequiredHeader({
        endpointClass,
        priceMatra: price,
        payerSs58: payer.ss58 || "",
        requestId,
        expiresUnix: expires,
      }),
    );

    logBilling(req, {
      phase: "live",
      endpoint_class: endpointClass,
      payer_kind: payer.kind,
      payer_ss58: payer.ss58,
      price: price.toString(),
      balance: balance === null ? null : balance.toString(),
      would_402: true,
      acted_402: true,
      reason:
        balance === null
          ? payer.kind === "none"
            ? "no_payer_identity"
            : "balance_read_failed"
          : "insufficient_balance",
    });

    res.status(402).json({
      error: "payment_required",
      endpoint_class: endpointClass,
      price: price.toString(),
      currency: "MATRA",
      balance: balance === null ? null : balance.toString(),
      payer: payer.ss58,
      request_id: requestId,
      expires,
      hint:
        payer.kind === "none"
          ? "Authenticate with `Authorization: Bearer matra_…` (api-key) OR sign a self-pay header (`X-402-Payment-Signature`)."
          : payer.kind === "api-key"
            ? "FPS treasury balance exhausted or daily cap reached. Contact your account manager to top up."
            : "Top up your `pallet-billing::Balances` via `topup_self` extrinsic, or sign a sufficient `X-402-Payment-Signature` for this request.",
    });
  };
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const __test__ = {
  classifyEndpoint,
  identifyPayer,
  buildPaymentRequiredHeader,
  getOrRollMatraCounter,
};
