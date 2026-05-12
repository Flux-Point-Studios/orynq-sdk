/**
 * @summary Public entry point for @fluxpointstudios/orynq-sdk-payer-materios-x402.
 *
 * This package provides a Materios-native x402 payer implementation that
 * closes the client-side x402 loop for the Materios billing gateway. The
 * gateway 402 middleware (services/blob-gateway/src/middleware/billing-402.ts)
 * emits x402 headers when a request lacks sufficient `pallet-billing::Balances`
 * — this package generates the matching payment proof a client returns to
 * retry the request.
 *
 * Two configuration shapes are supported, mapped 1:1 to the two payer
 * paths the gateway recognises:
 *
 * 1. **api-key path** — caller already authorizes via
 *    `Authorization: Bearer matra_…`. The FPS treasury sponsors the
 *    request. No x402 sign step is needed; `pay()` throws if a 402 still
 *    arrives (treasury exhausted / per-key cap hit). See `api-key.ts`.
 *
 * 2. **self-pay path** — caller signs the canonical materios-x402
 *    preimage with their own sr25519 key. The resulting headers
 *    (`x-402-payment-signature`, `x-402-payer-ss58`) are returned on the
 *    `PaymentProof`. The gateway verifies + submits the on-chain debit
 *    against `pallet-billing::Balances`. See `self-pay.ts`.
 *
 * Usage:
 * ```ts
 * import { createMateriosPayer, parseMateriosPaymentRequired }
 *   from "@fluxpointstudios/orynq-sdk-payer-materios-x402";
 *
 * // self-pay path
 * const payer = createMateriosPayer({ signerUri: "//Alice" });
 *
 * // On a 402:
 * const payload = parseMateriosPaymentRequired(
 *   response.headers.get("X-402-Payment-Required")!
 * );
 * const proof = await payer.pay({
 *   protocol: "x402",
 *   chain: "materios:preprod",
 *   asset: "MATRA",
 *   amountUnits: payload.pricing.amount,
 *   payTo: payload.recipient,
 *   raw: payload,
 * });
 * // → proof.signature carries the headers for the retry.
 * ```
 *
 * Wire-format contract:
 * The canonical preimage layout is documented in `preimage.ts` and pinned
 * by `__tests__/preimage.test.ts`. Gateway-side verifiers MUST mirror it
 * byte-for-byte.
 *
 * Used by:
 * - Materios billing clients (browser + Node.js)
 * - The orynq-sdk client SDK for automatic 402 retry handling
 * - Downstream verifiers that want to share the preimage builder
 */

import type { Payer } from "@fluxpointstudios/orynq-sdk-core";
import {
  MateriosApiKeyPayer,
  type MateriosApiKeyPayerConfig,
} from "./api-key.js";
import {
  MateriosSelfPayPayer,
  MATERIOS_CHAINS,
  parseMateriosPaymentRequired,
  validatePayload,
  unpackPaymentProofHeaders,
  verifyMateriosPaymentSignature,
  type MateriosSelfPayPayerConfig,
} from "./self-pay.js";
import { buildMateriosPayPreimage, PREIMAGE_DOMAIN_SEPARATOR } from "./preimage.js";
import { isMateriosPaymentPayload } from "./types.js";

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Discriminator-shape config for the api-key path. `{ apiKey }` (with no
 * `signerUri`) routes to `MateriosApiKeyPayer`.
 */
export type MateriosApiKeyPayerOpts = MateriosApiKeyPayerConfig & {
  signerUri?: never;
};

/**
 * Discriminator-shape config for the self-pay path. `{ signerUri }` (with
 * no `apiKey`) routes to `MateriosSelfPayPayer`.
 */
export type MateriosSelfPayPayerOpts = MateriosSelfPayPayerConfig & {
  apiKey?: never;
};

/**
 * Union of the two supported configuration shapes. TypeScript will narrow
 * inside `createMateriosPayer` based on which key is present.
 */
export type MateriosPayerOpts =
  | MateriosApiKeyPayerOpts
  | MateriosSelfPayPayerOpts;

/**
 * Factory entry point. Routes to `MateriosApiKeyPayer` when `apiKey` is
 * provided, or `MateriosSelfPayPayer` when `signerUri` is provided.
 * Throws if neither (or both) is present — the two paths are mutually
 * exclusive on purpose; a single caller should pick one.
 *
 * @example
 * ```ts
 * // api-key (FPS-sponsored)
 * const payer = createMateriosPayer({ apiKey: "matra_abc123…" });
 *
 * // self-pay (sr25519)
 * const payer = createMateriosPayer({ signerUri: "your mnemonic phrase here" });
 * ```
 */
export function createMateriosPayer(opts: MateriosPayerOpts): Payer {
  const hasApiKey = "apiKey" in opts && typeof opts.apiKey === "string";
  const hasSigner =
    "signerUri" in opts && typeof opts.signerUri === "string";

  if (hasApiKey && hasSigner) {
    throw new Error(
      "createMateriosPayer: provide either { apiKey } or { signerUri }, not both.",
    );
  }
  if (hasApiKey) {
    return new MateriosApiKeyPayer({ apiKey: (opts as MateriosApiKeyPayerOpts).apiKey });
  }
  if (hasSigner) {
    const o = opts as MateriosSelfPayPayerOpts;
    return new MateriosSelfPayPayer({
      signerUri: o.signerUri,
      ...(o.ss58Prefix !== undefined ? { ss58Prefix: o.ss58Prefix } : {}),
    });
  }
  throw new Error(
    "createMateriosPayer: must provide either { apiKey: 'matra_…' } or { signerUri: '<mnemonic>' }.",
  );
}

// ---------------------------------------------------------------------------
// Public re-exports
// ---------------------------------------------------------------------------

export {
  MateriosApiKeyPayer,
  type MateriosApiKeyPayerConfig,
} from "./api-key.js";
export {
  MateriosSelfPayPayer,
  MATERIOS_CHAINS,
  parseMateriosPaymentRequired,
  validatePayload,
  unpackPaymentProofHeaders,
  verifyMateriosPaymentSignature,
  type MateriosSelfPayPayerConfig,
} from "./self-pay.js";
export {
  buildMateriosPayPreimage,
  PREIMAGE_DOMAIN_SEPARATOR,
} from "./preimage.js";
export {
  isMateriosPaymentPayload,
  type MateriosPaymentPayload,
  type ValidatedMateriosPayload,
  type MateriosPaymentProofHeaders,
} from "./types.js";

// Silence "unused import" — the re-exports above suffice, but keeping the
// imports near the top of the file makes the dependency graph obvious to
// readers. The TS compiler treats `export { … } from "./module.js"` as
// type-and-value re-export, so the direct imports here aren't strictly
// required at runtime — they're a deliberate documentation hint.
void MateriosApiKeyPayer;
void MateriosSelfPayPayer;
void MATERIOS_CHAINS;
void parseMateriosPaymentRequired;
void validatePayload;
void unpackPaymentProofHeaders;
void verifyMateriosPaymentSignature;
void buildMateriosPayPreimage;
void PREIMAGE_DOMAIN_SEPARATOR;
void isMateriosPaymentPayload;

// Version constant — bumped alongside the `version` in package.json.
// Kept in sync manually; the build does NOT auto-stamp it (tsup doesn't
// have a built-in version-injector and we don't want a postinstall script).
export const VERSION = "0.1.0";

// Type-only re-exports require the types to be referenced somewhere for
// the tsc cli to keep them in the .d.ts. The `type` re-exports above
// already accomplish this, so we don't need void-references for them.
export type {
  MateriosPayerOpts as _MateriosPayerOpts,
};
