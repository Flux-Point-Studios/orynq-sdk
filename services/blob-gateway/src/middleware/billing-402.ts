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
  queryBillingBalance as defaultQueryBillingBalance,
  queryEndpointPrice as defaultQueryEndpointPrice,
} from "../billing/chain_query.js";
import type {
  BillingBalanceResult,
  EndpointQuoteResult,
} from "../billing/chain_query.js";
import { getApiTokensDb } from "../api-tokens.js";
import { verifyToken } from "../api-tokens.js";

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
 * Returns `"free"` for public-read routes that should bypass billing.
 * Returns `"admin"` for admin-guarded routes (also bypass billing, but
 * marked semantically as "intentionally not metered" rather than "anyone
 * can hit this for free"). Returns the canonical class string for
 * billable routes.
 *
 * Every routed endpoint in `services/blob-gateway/src/index.ts` MUST be
 * accounted for here. Anything not explicitly listed falls through and
 * emits a `billing.unclassified_route` warn at the bottom — this is a
 * loud signal that a new route was added without an explicit billing
 * decision.
 *
 * Pure function; safe to unit-test without spinning up a router.
 */
export function classifyEndpoint(req: Request): EndpointClass {
  const m = req.method.toUpperCase();
  const p = req.path;

  // ----- Health + status — always free. -----
  if (p === "/health" || p === "/status" || p.startsWith("/status/")) {
    return assertEndpointClass("free");
  }

  // ----- Admin-guarded routes (auth-gated upstream, not billable). -----
  // /admin/* — every admin route registered in index.ts goes through a
  // hard ADMIN_API_KEY check before the handler. Listing them here flags
  // them as "intentionally not billed" rather than letting them fall
  // through to the implicit-fallback warn.
  if (p.startsWith("/admin/")) {
    return assertEndpointClass("admin");
  }
  // /auth/token* — Bearer-token lifecycle. Admin-only.
  if (p === "/auth/token" || p.startsWith("/auth/token/") || p === "/auth/tokens") {
    return assertEndpointClass("admin");
  }
  // Operator onboarding — invite-token / admin-gated.
  if (m === "POST" && p === "/operators/register") {
    return assertEndpointClass("admin");
  }
  if (m === "POST" && p === "/operators/create-invite") {
    return assertEndpointClass("admin");
  }
  if (m === "PATCH" && /^\/operators\/[^/]+\/session-keys$/.test(p)) {
    return assertEndpointClass("admin");
  }

  // ----- Public reads — chain-info, locators, blobs GET, batches GET, etc. -----
  if (m === "GET") {
    // Manifest fetch is publicly readable for content-addressed blobs.
    if (p.startsWith("/blobs/") && p.endsWith("/manifest")) return assertEndpointClass("free");
    if (p.startsWith("/blobs/") && p.endsWith("/status")) return assertEndpointClass("free");
    if (p.startsWith("/blobs/") && /\/chunks\/\d+$/.test(p)) return assertEndpointClass("free");
    if (p.startsWith("/chunks/")) return assertEndpointClass("free");
    if (p.startsWith("/locators/")) return assertEndpointClass("free");
    if (p.startsWith("/batches/")) return assertEndpointClass("free");
    if (p === "/billing/usage") return assertEndpointClass("billing_usage_query");
    if (p === "/chain-info") return assertEndpointClass("free");
    if (p === "/faucet/status") return assertEndpointClass("free");
    if (p.startsWith("/heartbeats/")) return assertEndpointClass("free");
    if (/^\/operators\/[^/]+\/session-keys$/.test(p)) return assertEndpointClass("free");
    if (/^\/operators\/status\/[^/]+$/.test(p)) return assertEndpointClass("free");
    // Daemon-facing chain-submission feeder (task #143). Bearer-token
    // authenticated upstream; not user-billable traffic.
    if (p === "/v2/attestation_evidence/pending") {
      return assertEndpointClass("admin");
    }
    return assertEndpointClass("free");
  }

  // ----- Write routes — billable -----

  // Manifest POST (writes a small JSON blob describing chunks).
  if (m === "POST" && /^\/blobs\/[^/]+\/manifest$/.test(p)) {
    return assertEndpointClass("manifest_post");
  }
  // Chunk PUT (writes blob bytes — priced PerByte by governance).
  if (m === "PUT" && /^\/blobs\/[^/]+\/chunks\/\d+$/.test(p)) {
    return assertEndpointClass("chunk_upload");
  }
  // Certified PATCH (marks a manifest as certified after cert-daemon attestation).
  if (m === "PATCH" && /^\/blobs\/[^/]+\/certified$/.test(p)) {
    return assertEndpointClass("manifest_certified_patch");
  }
  // Metering ingest (compute_metering_v1/v2 envelopes).
  if (m === "POST" && p === "/metering/submit") {
    return assertEndpointClass("receipt_submit");
  }
  // Batch metadata POST/PUT from cert-daemon.
  if ((m === "POST" || m === "PUT") && /^\/batches\/[^/]+$/.test(p)) {
    return assertEndpointClass("batch_metadata");
  }
  // Wave 3 Phase 2 — TEE evidence submit (daemon Bearer auth upstream;
  // billable per receipt to the attestor).
  if (m === "POST" && p === "/v2/attestation_evidence") {
    return assertEndpointClass("tee_evidence_submit");
  }
  // Daemon mark-submitted callback (task #143). Bearer-token authenticated
  // upstream; price it separately so we can throttle daemon traffic
  // distinctly from end-user evidence submits.
  if (m === "POST" && /^\/v2\/attestation_evidence\/[^/]+\/mark_submitted$/.test(p)) {
    return assertEndpointClass("tee_evidence_mark_submitted");
  }
  // Heartbeats — free (operator health, not billable user work).
  if (m === "POST" && p === "/heartbeats") return assertEndpointClass("free");
  // Faucet — free (operator onboarding).
  if (m === "POST" && p.startsWith("/faucet/")) return assertEndpointClass("free");

  // -----------------------------------------------------------------------
  // Implicit-fallback warn. Anything that lands here is a NEW route that
  // was added to the gateway without a corresponding billing decision —
  // we want a loud signal in the logs so the next reviewer can decide
  // whether it should be free/admin/billable. The fail-open default
  // ("free") is preserved so a new route doesn't suddenly start 402-ing
  // production traffic, but the warn-log makes it impossible to ship a
  // new route without it showing up in audit.
  // -----------------------------------------------------------------------
  if (m !== "GET") {
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        log: "billing.unclassified_route",
        method: m,
        path: p,
      }),
    );
  }
  return assertEndpointClass("free");
}

/**
 * Belt-and-suspenders runtime check that every classifyEndpoint return is
 * a valid canonical endpoint-class identifier. All call-sites pass static
 * literals so this is a noop in practice — it's here to catch a future
 * refactor that accidentally constructs a class string from request input
 * (which would let an attacker steer governance pricing lookups).
 */
function assertEndpointClass<T extends string>(c: T): T {
  if (!/^[a-z0-9_]+$/.test(c)) {
    throw new Error(
      `classifyEndpoint returned non-canonical class ${JSON.stringify(c)}; expected /^[a-z0-9_]+$/`,
    );
  }
  return c;
}

interface PayerIdentity {
  /** "api-key" → FPS treasury pays; "self" → caller's own balance. */
  kind: "api-key" | "self" | "none";
  /** SS58 address of the account that will be debited. */
  ss58: string | null;
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
 * - CRITICAL: in the self-pay path, `ss58` is the CLAIMED address from
 *   the `x-402-payer-ss58` header — at this layer the sr25519 signature
 *   has NOT been verified. Treat the value as untrusted; never reflect
 *   it (or anything derived from it, e.g. its on-chain balance) back to
 *   the caller in a way that lets an attacker harvest balances for
 *   arbitrary SS58 addresses by guessing them. See `billing402Middleware`
 *   for the 402-emission scrubbing.
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
 *
 * NOTE FOR CLIENTS: `pricing.amount` is a STRING-encoded u128. Clients
 * MUST parse it as `BigInt` (not `Number`), otherwise values larger than
 * 2^53 silently lose precision. Likewise the `balance` field on the 402
 * JSON body (when non-null) is a string-encoded u128 — same parsing
 * contract.
 */
function buildPaymentRequiredHeader(opts: {
  endpointClass: EndpointClass;
  priceMatra: bigint;
  /** May be `null` when we have no verified payer identity. Never
   *  reflect an unverified claimed-ss58 here — see H1 fix in #221. */
  payerSs58: string | null;
  requestId: string;
  expiresUnix: number;
}): string {
  return JSON.stringify({
    scheme: "materios-x402",
    chain: "materios",
    network: "preprod",
    endpointClass: opts.endpointClass,
    // pricing.amount: STRING-encoded u128 — parse as BigInt on the
    // client. Never coerce to Number.
    pricing: { token: "MATRA", decimals: 15, amount: opts.priceMatra.toString() },
    // payer is omitted entirely when null so clients don't have to
    // distinguish "unset" from "<verify>" sentinel strings.
    ...(opts.payerSs58 !== null ? { payer: opts.payerSs58 } : {}),
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

interface BillingDecisionLog {
  phase: "off" | "measurement" | "live";
  endpoint_class: EndpointClass;
  payer_kind: PayerIdentity["kind"];
  /** SS58 of the VERIFIED api-key payer (treasury account). Set for
   *  `payer_kind === "api-key"`. */
  payer_ss58: string | null;
  /** Unverified self-pay SS58 from the `x-402-payer-ss58` header. Set
   *  for `payer_kind === "self"`. Never trust this for balance lookups
   *  beyond the 402 admission decision — at this layer the sr25519 sig
   *  hasn't been verified. */
  payer_ss58_claimed: string | null;
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

/**
 * Split the payer's SS58 into the two log fields based on payer kind.
 * Verified api-key path uses `payer_ss58`; unverified self-pay path uses
 * `payer_ss58_claimed`. The "none" path leaves both null.
 *
 * This is the safety boundary for H1 (#221): downstream log scrapers can
 * trust `payer_ss58` to be a verified treasury identity, and treat
 * `payer_ss58_claimed` as untrusted (parse-but-don't-act).
 */
function payerLogFields(payer: PayerIdentity): {
  payer_ss58: string | null;
  payer_ss58_claimed: string | null;
} {
  if (payer.kind === "api-key") {
    return { payer_ss58: payer.ss58, payer_ss58_claimed: null };
  }
  if (payer.kind === "self") {
    return { payer_ss58: null, payer_ss58_claimed: payer.ss58 };
  }
  return { payer_ss58: null, payer_ss58_claimed: null };
}

/**
 * Build dependency-injected middleware. The default closure binds to the
 * module-level `queryEndpointPrice` / `queryBillingBalance` imports; tests
 * inject stubs via `deps` so they can exercise the full live/measurement
 * flow without monkey-patching the module cache.
 *
 * The split is the cleanest way to give vitest a deterministic seam —
 * `vi.mock` of the chain-query module had a module-resolution edge case
 * in PR #43's harness (see deferred-test note in the test file). DI keeps
 * production code identical while making the test surface trivial.
 */
export interface BillingMiddlewareDeps {
  queryEndpointPrice?: (
    endpointClass: string,
    requestBytes: number,
  ) => Promise<EndpointQuoteResult>;
  queryBillingBalance?: (ss58: string) => Promise<BillingBalanceResult>;
}

export function billing402Middleware(
  deps: BillingMiddlewareDeps = {},
): RequestHandler {
  const queryEndpointPrice = deps.queryEndpointPrice ?? defaultQueryEndpointPrice;
  const queryBillingBalance =
    deps.queryBillingBalance ?? defaultQueryBillingBalance;

  return async (req: Request, res: Response, next: NextFunction) => {
    // M3 (#224): wrap the entire handler in a try/catch so any unexpected
    // throw (DB connection, RPC stub, malformed header parsing) fails open
    // rather than 500-ing the route. Fail-open matches the rest of the
    // off-by-default contract — we'd rather under-charge during a bug
    // than block legitimate traffic.
    try {
      if (config.billingEnforcementPhase === "off") return next();

      const endpointClass = classifyEndpoint(req);
      if (endpointClass === "free" || endpointClass === "admin") return next();

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
          ...payerLogFields(payer),
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
          ...payerLogFields(payer),
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
          ...payerLogFields(payer),
          price: price.toString(),
          balance: balance!.toString(),
          would_402: false,
          acted_402: false,
        });
        return next();
      }

      // ----- Insufficient balance → 402. -----
      // H1 (#221): SCRUB unverified self-pay identity from the response.
      // For the self-pay path, the SS58 came from a request header and
      // has NOT been signature-verified at this layer. Reflecting the
      // SS58 (or its on-chain balance) back lets an attacker harvest the
      // balance of any address they can guess by sending junk-sig +
      // target-SS58.
      //
      // Rules:
      //   - api-key path → reflect the verified treasury SS58 + balance
      //     (the api-key auth happens above via `verifyToken`).
      //   - self-pay / none path → null out payer + balance on the wire.
      //     The route handler's own auth layer (which DOES verify the
      //     sr25519 sig) is responsible for any post-verification balance
      //     surfacing.
      const isVerifiedPayer = payer.kind === "api-key";
      const wirePayerSs58 = isVerifiedPayer ? payer.ss58 : null;
      const wireBalance: bigint | null = isVerifiedPayer ? balance : null;

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
          payerSs58: wirePayerSs58,
          requestId,
          expiresUnix: expires,
        }),
      );

      logBilling(req, {
        phase: "live",
        endpoint_class: endpointClass,
        payer_kind: payer.kind,
        ...payerLogFields(payer),
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

      // 402 JSON body — same scrubbing rule as the header (see H1 above).
      // NOTE: `price` and `balance` are STRING-encoded u128s; clients MUST
      // parse them as BigInt, never Number.
      res.status(402).json({
        error: "payment_required",
        endpoint_class: endpointClass,
        price: price.toString(),
        currency: "MATRA",
        balance: wireBalance === null ? null : wireBalance.toString(),
        payer: wirePayerSs58,
        request_id: requestId,
        expires,
        hint:
          payer.kind === "none"
            ? "Authenticate with `Authorization: Bearer matra_…` (api-key) OR sign a self-pay header (`X-402-Payment-Signature`)."
            : payer.kind === "api-key"
              ? "FPS treasury balance exhausted or daily cap reached. Contact your account manager to top up."
              : "Top up your `pallet-billing::Balances` via `topup_self` extrinsic, or sign a sufficient `X-402-Payment-Signature` for this request.",
      });
    } catch (err) {
      // M3 (#224): fail-open on any internal error. The 402 path is
      // pre-flight admission control; an exception here should never
      // 500 the underlying request. Log and pass through.
      // eslint-disable-next-line no-console
      console.error("billing-402 internal error", err);
      return next();
    }
  };
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------
//
// NOTE: `getOrRollMatraCounter` was removed in #224 (M4) — it was only
// reachable via this `__test__` export and never wired into the live
// middleware, which means its SELECT-then-UPDATE race at the UTC-day
// boundary was a guaranteed-future-incident. The per-key MATRA spend
// cap will be reintroduced as part of #216 (payer-materios-x402 SDK)
// with proper transactional atomicity (db.transaction(...)). Until then
// the surface stays empty.
//
// TODO(#216): per-key MATRA spend cap will be wired in when
// payer-materios-x402 SDK lands. Reintroduce a SELECT+UPDATE wrapper
// that runs inside `db.transaction(...)` so two concurrent calls at a
// day boundary can't clobber each other's `matra_day_bucket` reset.

export const __test__ = {
  classifyEndpoint,
  identifyPayer,
  buildPaymentRequiredHeader,
  payerLogFields,
};
