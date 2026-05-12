/**
 * @summary api-key passthrough materios-x402 payer.
 *
 * The api-key path conveys authorization via the existing
 * `Authorization: Bearer matra_…` header, NOT via the x402
 * `x-402-payment-signature` mechanism. The gateway's `identifyPayer`
 * (services/blob-gateway/src/middleware/billing-402.ts) treats the
 * api-key as proof that the FPS treasury sponsors the request.
 *
 * Therefore, when the gateway emits a 402 to a client that ALREADY
 * presented a valid api-key, retrying with the same api-key + an x402
 * payment signature won't help — the 402 means the treasury balance or
 * per-key cap is exhausted, not that the auth was missing.
 *
 * This payer's `pay()` therefore throws a descriptive error immediately
 * so the caller can:
 *   1. Surface the message to the user (e.g. "your sponsor's daily cap
 *      is exhausted, contact account manager"),
 *   2. Fall back to a `MateriosSelfPayPayer` if they have an sr25519 key
 *      configured.
 *
 * Used by:
 * - `createMateriosPayer({ apiKey })` factory in index.ts
 */

import type {
  ChainId,
  Payer,
  PaymentProof,
  PaymentRequest,
} from "@fluxpointstudios/orynq-sdk-core";
import { PaymentFailedError } from "@fluxpointstudios/orynq-sdk-core";
import { MATERIOS_CHAINS } from "./self-pay.js";

/**
 * Configuration for `MateriosApiKeyPayer`.
 */
export interface MateriosApiKeyPayerConfig {
  /**
   * Bearer token issued by FPS — `matra_<base62>`. The gateway treats
   * this as authorization for the FPS treasury to sponsor the request.
   * Must be sent in the original request's `Authorization` header by
   * whatever transport layer the caller uses; this payer does NOT
   * inject it.
   */
  apiKey: string;
}

/**
 * api-key materios-x402 Payer. Conforms to the generic `Payer`
 * interface but throws on `pay()` because the api-key path doesn't
 * participate in the x402 payment-signature protocol — see file
 * docstring for the full rationale.
 */
export class MateriosApiKeyPayer implements Payer {
  readonly supportedChains: readonly ChainId[] = MATERIOS_CHAINS;

  readonly apiKey: string;

  constructor(config: MateriosApiKeyPayerConfig) {
    if (
      typeof config.apiKey !== "string" ||
      !config.apiKey.startsWith("matra_") ||
      config.apiKey.length < "matra_".length + 8
    ) {
      throw new Error(
        'MateriosApiKeyPayer: apiKey must be a "matra_"-prefixed string of length >= 14',
      );
    }
    this.apiKey = config.apiKey;
  }

  supports(request: PaymentRequest): boolean {
    return (
      request.protocol === "x402" &&
      this.supportedChains.includes(request.chain)
    );
  }

  /**
   * The api-key payer has no on-chain address — it authorizes against
   * the FPS treasury account whose SS58 only the gateway knows. Returns
   * a sentinel string so the `Payer` interface contract is honored
   * without claiming a misleading identity.
   */
  async getAddress(_chain: ChainId): Promise<string> {
    return "fps-treasury";
  }

  /**
   * No balance probe — the api-key path debits the FPS treasury account,
   * whose balance is gateway-internal state not exposed over RPC.
   * Throws to stay consistent with `MateriosSelfPayPayer.getBalance`
   * (both paths legitimately can't read a balance without out-of-band
   * info, and silently returning `0n` while `supports()` returns true
   * is misleading to budget-tracker callers).
   */
  async getBalance(_chain: ChainId, _asset: string): Promise<bigint> {
    throw new Error(
      "MateriosApiKeyPayer.getBalance: api-key path doesn't expose payer balance — FPS treasury balance is gateway-internal, not client-readable; check gateway /billing/usage instead",
    );
  }

  /**
   * Fail fast — see file docstring. The error message tells the caller
   * exactly what to do: contact account manager to top up the
   * treasury, or switch to a self-pay flow.
   */
  async pay(request: PaymentRequest): Promise<PaymentProof> {
    throw new PaymentFailedError(
      request,
      "MateriosApiKeyPayer cannot sign an x402 retry: the api-key conveys " +
        "authorization via the `Authorization: Bearer matra_…` header, not " +
        "via x402 payment-signature. A 402 returned while a valid api-key " +
        "was attached means the FPS treasury balance is exhausted, the " +
        "per-key daily cap was reached, or the api-key was rejected. " +
        "Contact your account manager to top up, or switch to a " +
        "self-pay (sr25519 signerUri) configuration.",
    );
  }
}
