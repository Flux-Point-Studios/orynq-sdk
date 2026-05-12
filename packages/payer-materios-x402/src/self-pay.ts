/**
 * @summary Self-pay materios-x402 Payer — caller signs with their own sr25519 key.
 *
 * Given a parsed `X-402-Payment-Required` header from the Materios billing
 * gateway, build the canonical preimage (see `preimage.ts`), sign it with
 * sr25519, and return a `PaymentProof` whose payload carries the headers
 * the gateway-side `identifyPayer` expects on the retry:
 *
 *   - `x-402-payment-signature: 0x<hex sig>`
 *   - `x-402-payer-ss58: <ss58 prefix-42 address>`
 *
 * The gateway settlement signer will later debit `pallet-billing::Balances`
 * for the SS58 in `x-402-payer-ss58`, after verifying the signature against
 * the canonical preimage. This SDK does NOT submit the on-chain debit
 * directly — that role belongs to the gateway, which is the trusted
 * settlement signer.
 *
 * Used by:
 * - `createMateriosPayer({ signerUri })` factory in index.ts
 * - clients that want to drive the materios-x402 flow manually
 */

import { Keyring } from "@polkadot/keyring";
import type { KeyringPair } from "@polkadot/keyring/types";
import {
  cryptoWaitReady,
  sr25519Verify,
  blake2AsU8a,
} from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";
import type {
  ChainId,
  Payer,
  PaymentProof,
  PaymentRequest,
} from "@fluxpointstudios/orynq-sdk-core";
import { PaymentFailedError } from "@fluxpointstudios/orynq-sdk-core";
import { buildMateriosPayPreimage } from "./preimage.js";
import {
  isMateriosPaymentPayload,
  type MateriosPaymentPayload,
  type ValidatedMateriosPayload,
} from "./types.js";

/**
 * CAIP-2-ish identifier for the Materios chain. We don't have a registered
 * CAIP-2 namespace yet; `materios:preprod` / `materios:mainnet` are the
 * project-internal convention.
 */
export const MATERIOS_CHAINS = [
  "materios:preprod",
  "materios:mainnet",
] as const;

/**
 * Default SS58 prefix for Materios. Substrate convention is prefix-42 for
 * generic substrate chains; we keep this default until Materios registers
 * a dedicated prefix.
 */
const MATERIOS_SS58_PREFIX = 42;

/**
 * Configuration for `MateriosSelfPayPayer`.
 */
export interface MateriosSelfPayPayerConfig {
  /**
   * sr25519 signing URI — mnemonic phrase, raw seed `0x<64-hex>`, or a
   * `//Alice`-style dev-key derivation URI. Forwarded directly to
   * `Keyring.addFromUri`.
   */
  signerUri: string;

  /**
   * Optional SS58 prefix override. Defaults to 42 (generic substrate).
   * Useful for testing against chains with non-default prefixes.
   */
  ss58Prefix?: number;
}

/**
 * Self-pay sr25519 Payer implementation. Conforms to the generic `Payer`
 * interface from `@fluxpointstudios/orynq-sdk-core` so it can drop into
 * the same payer-registry plumbing as the EVM / Cardano payers.
 */
export class MateriosSelfPayPayer implements Payer {
  readonly supportedChains: readonly ChainId[] = MATERIOS_CHAINS;

  private readonly signerUri: string;
  private readonly ss58Prefix: number;
  private pair: KeyringPair | null = null;

  constructor(config: MateriosSelfPayPayerConfig) {
    this.signerUri = config.signerUri;
    this.ss58Prefix = config.ss58Prefix ?? MATERIOS_SS58_PREFIX;
  }

  /**
   * Lazily initialise the WASM crypto runtime + derive the keypair. Cached
   * on first call. Throws if the URI cannot be parsed by `@polkadot/keyring`.
   */
  private async getPair(): Promise<KeyringPair> {
    if (this.pair) return this.pair;
    await cryptoWaitReady();
    const keyring = new Keyring({ type: "sr25519", ss58Format: this.ss58Prefix });
    this.pair = keyring.addFromUri(this.signerUri);
    return this.pair;
  }

  supports(request: PaymentRequest): boolean {
    return (
      request.protocol === "x402" &&
      this.supportedChains.includes(request.chain)
    );
  }

  async getAddress(_chain: ChainId): Promise<string> {
    const pair = await this.getPair();
    return pair.address;
  }

  /**
   * Self-pay does not expose an on-chain balance probe — querying
   * `pallet-billing::Balances` requires the full `@polkadot/api` client
   * which this package intentionally avoids depending on. Callers that
   * need a balance reading should hit the gateway's `/billing/usage`
   * endpoint or instantiate their own `ApiPromise`.
   *
   * Returning `0n` here would be misleading; we throw instead so a
   * caller wiring this into a budget-tracker realises the gap rather
   * than treating "no balance" as zero.
   */
  async getBalance(_chain: ChainId, _asset: string): Promise<bigint> {
    throw new Error(
      "MateriosSelfPayPayer.getBalance is not implemented — query the gateway's /billing/usage endpoint or use @polkadot/api directly.",
    );
  }

  /**
   * Execute the x402 sign step against a parsed 402 payload.
   *
   * The generic `Payer.pay(request: PaymentRequest)` contract is awkward
   * for materios-x402: the protocol-neutral `PaymentRequest` doesn't
   * carry the `endpointClass` / `nonce` / `expires` fields we need to
   * build the preimage. We extract them from `request.raw` (which
   * `parsePaymentRequired`-style helpers should populate with the
   * decoded gateway JSON). Callers driving this payer directly should
   * prefer `signMateriosPaymentRequest(payload)` below.
   */
  async pay(request: PaymentRequest): Promise<PaymentProof> {
    if (request.protocol !== "x402") {
      throw new PaymentFailedError(
        request,
        `MateriosSelfPayPayer only supports x402 protocol, got: ${request.protocol}`,
      );
    }
    const raw = request.raw;
    if (!isMateriosPaymentPayload(raw)) {
      throw new PaymentFailedError(
        request,
        "MateriosSelfPayPayer.pay requires `request.raw` to be a materios-x402 payment payload. " +
          'Use `parseMateriosPaymentRequired(headerValue)` or pass the decoded JSON.',
      );
    }
    const result = await this.signMateriosPaymentRequest(raw);
    return {
      kind: "x402-signature",
      // Pack both headers into the signature field as a `header_name=value;header_name=value`
      // string. The PaymentProof type doesn't model HTTP headers directly;
      // packing them here keeps the proof self-contained. Consumers parse
      // via the exported `unpackPaymentProofHeaders` helper.
      signature: serializeHeaders(result.headers),
      payload: JSON.stringify({
        endpointClass: raw.endpointClass,
        amount: raw.pricing.amount,
        nonce: raw.nonce,
        expires: raw.expires,
        payer: result.payerSs58,
      }),
    };
  }

  /**
   * The materios-x402-native entry point. Parses + validates the gateway
   * payload, builds the canonical preimage, signs it with sr25519, and
   * returns the two headers the gateway-side `identifyPayer` reads on
   * retry.
   *
   * This method is intentionally separate from `pay()` so callers don't
   * have to construct a synthetic `PaymentRequest` just to drive the
   * sign step.
   */
  async signMateriosPaymentRequest(
    payload: MateriosPaymentPayload,
  ): Promise<{
    headers: {
      "x-402-payment-signature": string;
      "x-402-payer-ss58": string;
    };
    payerSs58: string;
    preimage: Uint8Array;
  }> {
    const validated = validatePayload(payload);
    const pair = await this.getPair();
    const preimage = buildMateriosPayPreimage(validated);
    // blake2-256 hash matches what the substrate-side verifier will
    // re-derive. Signing the hash (not the raw preimage) bounds the
    // signed-data size to 32 bytes regardless of endpointClass length,
    // which keeps `sr25519Sign` fast and matches the convention used by
    // pallet-billing extrinsics.
    const message = blake2AsU8a(preimage, 256);
    // `pair.sign(message)` produces the raw 64-byte sr25519 signature —
    // exactly what `sr25519Verify(message, sig, publicKey)` consumes on
    // the verification side, and what the gateway settlement signer will
    // re-check before submitting the on-chain debit.
    const sigBytes = pair.sign(message);
    return {
      headers: {
        "x-402-payment-signature": u8aToHex(sigBytes),
        "x-402-payer-ss58": pair.address,
      },
      payerSs58: pair.address,
      preimage,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate the semantic constraints of a materios-x402 payment payload.
 * Throws with a descriptive message on failure; returns a nominally-tagged
 * `ValidatedMateriosPayload` on success.
 *
 * Constraints enforced (matching gateway billing-402.ts emission):
 * - `scheme === "materios-x402"`
 * - `nonce` is `0x` + 64 hex chars (32 bytes)
 * - `pricing.amount` parses as BigInt (u128 range)
 * - `expires` is a Unix-seconds timestamp in the future
 */
export function validatePayload(
  payload: MateriosPaymentPayload,
): ValidatedMateriosPayload {
  if (payload.scheme !== "materios-x402") {
    throw new Error(
      `materios-x402: unsupported scheme ${JSON.stringify(payload.scheme)} (expected "materios-x402")`,
    );
  }
  // Network — must be a known Materios network. Enforced so the preimage's
  // network binding (see preimage.ts wire-format contract) can't be
  // sidestepped by submitting a junk string. Restrict to the canonical set
  // we ship today; future networks need an SDK bump.
  if (payload.network !== "preprod" && payload.network !== "mainnet") {
    throw new Error(
      `materios-x402: unsupported network ${JSON.stringify(payload.network)} (expected "preprod" or "mainnet")`,
    );
  }
  // endpointClass shape — must be a non-empty canonical-form string. The
  // gateway-side classifier emits `/^[a-z0-9_]+$/` slugs (e.g.
  // `receipt_submit`); rejecting anything else here keeps the preimage's
  // endpointClass binding aligned with the gateway's canonical form and
  // prevents stray casing / punctuation from sneaking past validation.
  if (
    typeof payload.endpointClass !== "string" ||
    payload.endpointClass.length === 0
  ) {
    throw new Error(`materios-x402: empty endpointClass`);
  }
  if (!/^[a-z0-9_]+$/.test(payload.endpointClass)) {
    throw new Error(
      `materios-x402: endpointClass must match /^[a-z0-9_]+$/ (got ${JSON.stringify(payload.endpointClass)})`,
    );
  }
  // Pricing token + decimals — MATRA is the only billable asset today
  // (15 decimals, matches pallet-billing). Locking these here means a
  // malformed 402 that swaps in a different token / decimals combination
  // is rejected before we hash anything, instead of silently signing a
  // preimage the gateway will then reject.
  if (payload.pricing.token !== "MATRA") {
    throw new Error(
      `materios-x402: unsupported token ${JSON.stringify(payload.pricing.token)} (expected "MATRA")`,
    );
  }
  if (payload.pricing.decimals !== 15) {
    throw new Error(
      `materios-x402: unsupported decimals ${payload.pricing.decimals} (expected 15 for MATRA)`,
    );
  }
  // Nonce shape
  if (
    typeof payload.nonce !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(payload.nonce)
  ) {
    throw new Error(
      `materios-x402: malformed nonce ${JSON.stringify(payload.nonce)} (expected "0x" + 64 hex chars)`,
    );
  }
  // Amount numeric
  if (typeof payload.pricing.amount !== "string") {
    throw new Error(
      `materios-x402: pricing.amount must be a string, got ${typeof payload.pricing.amount}`,
    );
  }
  if (!/^[0-9]+$/.test(payload.pricing.amount)) {
    throw new Error(
      `materios-x402: pricing.amount not a base-10 integer string: ${JSON.stringify(payload.pricing.amount)}`,
    );
  }
  let amount: bigint;
  try {
    amount = BigInt(payload.pricing.amount);
  } catch {
    throw new Error(
      `materios-x402: pricing.amount not parseable as BigInt: ${JSON.stringify(payload.pricing.amount)}`,
    );
  }
  if (amount < 0n || amount > (1n << 128n) - 1n) {
    throw new Error(
      `materios-x402: pricing.amount out of u128 range: ${amount.toString()}`,
    );
  }
  // Defensive zero-charge guard. The gateway never emits 402 for a free
  // route in production, but a zero-charge 402 is structurally malformed —
  // reject client-side so a misconfigured upstream surfaces immediately
  // instead of generating a useless signature for a no-op debit.
  if (amount === 0n) {
    throw new Error(
      `materios-x402: pricing.amount must be > 0 (zero-charge 402 is malformed)`,
    );
  }
  // Expires in future (with a tiny tolerance for clock skew).
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(payload.expires) || payload.expires < nowSec - 5) {
    throw new Error(
      `materios-x402: payment-required expired (expires=${payload.expires}, now=${nowSec})`,
    );
  }
  return payload as ValidatedMateriosPayload;
}

/**
 * Parse the raw `X-402-Payment-Required` header value into a typed payload.
 * Throws on malformed JSON or wrong scheme.
 */
export function parseMateriosPaymentRequired(
  headerValue: string,
): MateriosPaymentPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(headerValue);
  } catch (err) {
    throw new Error(
      `materios-x402: X-402-Payment-Required is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isMateriosPaymentPayload(parsed)) {
    throw new Error(
      `materios-x402: X-402-Payment-Required does not match scheme materios-x402 (got ${
        parsed && typeof parsed === "object" && "scheme" in parsed
          ? JSON.stringify((parsed as Record<string, unknown>).scheme)
          : "<missing scheme field>"
      })`,
    );
  }
  return parsed;
}

/**
 * Serialize the two materios-x402 headers into a single string suitable
 * for `PaymentProof.signature` transport. Format:
 * `x-402-payment-signature=0x…;x-402-payer-ss58=…`
 *
 * Round-trippable via `unpackPaymentProofHeaders` below.
 */
function serializeHeaders(h: {
  "x-402-payment-signature": string;
  "x-402-payer-ss58": string;
}): string {
  return (
    `x-402-payment-signature=${h["x-402-payment-signature"]};` +
    `x-402-payer-ss58=${h["x-402-payer-ss58"]}`
  );
}

/**
 * Round-trip helper — extract the two headers from a `PaymentProof.signature`
 * produced by `MateriosSelfPayPayer.pay()`.
 */
export function unpackPaymentProofHeaders(packed: string): {
  "x-402-payment-signature": string;
  "x-402-payer-ss58": string;
} {
  const out: Record<string, string> = {};
  for (const part of packed.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  const sig = out["x-402-payment-signature"];
  const ss58 = out["x-402-payer-ss58"];
  if (typeof sig !== "string" || typeof ss58 !== "string") {
    throw new Error(
      "unpackPaymentProofHeaders: missing x-402-payment-signature or x-402-payer-ss58",
    );
  }
  return {
    "x-402-payment-signature": sig,
    "x-402-payer-ss58": ss58,
  };
}

/**
 * Verify an sr25519 signature against the canonical materios-x402 preimage
 * hash. Helper for tests + downstream verifiers (e.g. a gateway-side
 * verifier wiring this directly) that don't want to depend on the
 * gateway's full verification path.
 *
 * The payload is run through `validatePayload` first so semantic
 * constraints (scheme, network, endpointClass shape, token+decimals,
 * nonce shape, amount range, freshness window, ...) all reject BEFORE
 * any signature work happens. Without this, a downstream verifier wiring
 * this function as their only check would happily accept a signature
 * over an `expires`-in-the-past or malformed-nonce payload.
 *
 * Returns true iff the signature is valid for `(preimage, publicKey)`.
 * Throws on payload validation failure (same errors as `validatePayload`).
 */
export function verifyMateriosPaymentSignature(opts: {
  payload: MateriosPaymentPayload;
  signatureHex: string;
  publicKey: Uint8Array;
}): boolean {
  const validated = validatePayload(opts.payload);
  const preimage = buildMateriosPayPreimage(validated);
  const message = blake2AsU8a(preimage, 256);
  const sig = hexToBytes(opts.signatureHex);
  return sr25519Verify(message, sig, opts.publicKey);
}

function hexToBytes(s: string): Uint8Array {
  if (typeof s !== "string" || !s.startsWith("0x")) {
    throw new Error(`hexToBytes: expected "0x"-prefixed hex, got ${JSON.stringify(s)}`);
  }
  const body = s.slice(2);
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) {
    throw new Error(`hexToBytes: malformed hex ${JSON.stringify(s)}`);
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
