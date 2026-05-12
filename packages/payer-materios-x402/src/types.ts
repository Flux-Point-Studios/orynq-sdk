/**
 * @summary Internal wire-format types for the materios-x402 payer.
 *
 * These types describe the JSON shape the gateway places in the
 * `X-402-Payment-Required` response header (see
 * `services/blob-gateway/src/middleware/billing-402.ts`).
 *
 * They are intentionally narrower than the generic `PaymentRequest` type in
 * `@fluxpointstudios/orynq-sdk-core` — this payer only handles the
 * `scheme === "materios-x402"` variant. The factory layer (index.ts) maps
 * between this internal shape and `PaymentRequest` when implementing the
 * generic `Payer` interface.
 *
 * Used by:
 * - self-pay.ts to parse + validate the 402 header before signing
 * - api-key.ts to detect when the gateway emitted a materios-x402 header
 * - __tests__/ as the canonical fixture shape
 */

/**
 * Decoded `X-402-Payment-Required` JSON payload, as emitted by the gateway.
 *
 * Wire format (see billing-402.ts::buildPaymentRequiredHeader):
 * ```json
 * {
 *   "scheme": "materios-x402",
 *   "chain": "materios",
 *   "network": "preprod" | "mainnet",
 *   "endpointClass": "receipt_submit",
 *   "pricing": { "token": "MATRA", "decimals": 15, "amount": "1000000" },
 *   "recipient": "pallet-billing",
 *   "nonce": "0x<64-hex>",
 *   "expires": 1234567890,
 *   "payer"?: "<ss58>"   // only present when api-key path identified a verified treasury
 * }
 * ```
 *
 * CRITICAL: `pricing.amount` is a STRING-encoded u128. Always parse as
 * `BigInt`, never `Number`. Same rule applies to any balance reflected
 * back in the 402 body.
 */
export interface MateriosPaymentPayload {
  /** Always `"materios-x402"` — used to detect this payer's wire format. */
  scheme: "materios-x402";
  /** Always `"materios"` for this payer. */
  chain: "materios";
  /** Materios network identifier. */
  network: "preprod" | "mainnet" | string;
  /** Canonical endpoint-class string (snake_case ASCII). */
  endpointClass: string;
  /** Pricing block — `amount` is a STRING-encoded u128. */
  pricing: {
    token: "MATRA" | string;
    decimals: number;
    amount: string;
  };
  /** Always `"pallet-billing"` for this payer. */
  recipient: string;
  /** Request nonce — `0x` + 64 hex chars (32 bytes). */
  nonce: string;
  /** Unix seconds (UTC) after which this 402 is no longer valid. */
  expires: number;
  /** Verified treasury SS58, present only for api-key path; never for self-pay. */
  payer?: string;
}

/**
 * Type guard — checks structural conformance to the materios-x402 wire
 * format. Does NOT validate semantic constraints (nonce hex shape, amount
 * numeric, expires in future) — those are checked by `validatePayload` in
 * `self-pay.ts`. This guard is the cheap first-line filter that lets
 * non-materios schemes fall through to other payers in a multi-payer setup.
 */
export function isMateriosPaymentPayload(
  v: unknown,
): v is MateriosPaymentPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.scheme !== "materios-x402") return false;
  if (typeof o.chain !== "string") return false;
  if (typeof o.network !== "string") return false;
  if (typeof o.endpointClass !== "string") return false;
  if (typeof o.recipient !== "string") return false;
  if (typeof o.nonce !== "string") return false;
  if (typeof o.expires !== "number") return false;
  if (!o.pricing || typeof o.pricing !== "object") return false;
  const p = o.pricing as Record<string, unknown>;
  if (typeof p.token !== "string") return false;
  if (typeof p.decimals !== "number") return false;
  if (typeof p.amount !== "string") return false;
  return true;
}

/**
 * The internal "validated payload" shape returned by `validatePayload` —
 * a `MateriosPaymentPayload` whose semantic constraints (nonce, amount,
 * expires) have been checked. Same runtime shape, distinct nominal type
 * to make it obvious where validation has been performed.
 */
export type ValidatedMateriosPayload = MateriosPaymentPayload & {
  readonly __validated: true;
};

/**
 * The PaymentProof headers this payer attaches to a retry. Mirror the
 * names the gateway's `identifyPayer` reads in billing-402.ts.
 */
export interface MateriosPaymentProofHeaders {
  "x-402-payment-signature": string;
  "x-402-payer-ss58": string;
}
