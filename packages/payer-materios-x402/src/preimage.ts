/**
 * @summary Canonical preimage construction for materios-x402 payment-signature.
 *
 * The preimage is the byte string a payer signs to prove authorization for
 * a specific 402'd request. The gateway settlement signer (Materios runtime
 * side) verifies the same preimage against the sr25519 signature carried in
 * `x-402-payment-signature` before it submits `pay_request` on chain.
 *
 * THIS PACKAGE IS THE SINGLE SOURCE OF TRUTH for the byte layout — any
 * gateway-side verifier (Rust pallet, Python daemon, TypeScript helper)
 * MUST mirror it byte-for-byte. Tests pin the format against known vectors
 * (see `__tests__/preimage.test.ts`).
 *
 * Wire-format contract (v1):
 * ```
 * canonical_preimage = concat(
 *   utf8("materios-x402-v1"),       // 16-byte fixed domain separator
 *   utf8_length_prefix_u32_le(endpointClass) || utf8(endpointClass),
 *   u128_le_bytes(BigInt(pricing.amount)),
 *   bytes32(payload.nonce),         // 32 raw bytes from `0x<64-hex>`
 *   u64_le_bytes(payload.expires)
 * )
 * ```
 *
 * The signer hashes this with blake2-256 before signing, matching the
 * substrate convention used by `pallet-billing` extrinsics. Verifiers
 * MUST hash the same way.
 *
 * Why not just sign the raw JSON header? Two reasons:
 *   1. JSON has multiple valid serializations (key order, whitespace,
 *      number canonicalization). Signing JSON requires a canonicalizer
 *      on both sides and adds an attack surface (e.g. duplicate-key
 *      ambiguity).
 *   2. The on-chain verifier is in Rust and decodes via SCALE, not JSON.
 *      A binary preimage that mirrors SCALE-style concatenation keeps
 *      both sides byte-identical without needing a JSON parser in the
 *      hot path.
 *
 * Used by:
 * - self-pay.ts to build + sign the preimage
 * - __tests__/preimage.test.ts as the byte-pinned contract
 */

import type { MateriosPaymentPayload } from "./types.js";

// ---------------------------------------------------------------------------
// Domain separator
// ---------------------------------------------------------------------------

/**
 * Fixed 16-byte domain separator for v1 of the materios-x402 preimage.
 * UTF-8 of the ASCII string `materios-x402-v1`.
 *
 * Bumping this constant (e.g. `v2`) is the canonical way to roll the
 * preimage format. Old signatures naturally become invalid because they
 * were hashed under a different prefix — there is no risk of cross-version
 * replay.
 */
export const PREIMAGE_DOMAIN_SEPARATOR = new TextEncoder().encode(
  "materios-x402-v1",
);

// ---------------------------------------------------------------------------
// Encoding primitives
// ---------------------------------------------------------------------------

/**
 * Encode a u32 as little-endian 4 bytes.
 */
function u32LeBytes(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) {
    throw new RangeError(`u32LeBytes: out of range u32 (${n})`);
  }
  const out = new Uint8Array(4);
  out[0] = n & 0xff;
  out[1] = (n >>> 8) & 0xff;
  out[2] = (n >>> 16) & 0xff;
  out[3] = (n >>> 24) & 0xff;
  return out;
}

/**
 * Encode a u64 as little-endian 8 bytes. Accepts `number` or `bigint`;
 * uses bigint arithmetic to avoid the 2^53 precision cliff.
 */
function u64LeBytes(n: number | bigint): Uint8Array {
  const v = typeof n === "bigint" ? n : BigInt(n);
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`u64LeBytes: out of range u64 (${v.toString()})`);
  }
  const out = new Uint8Array(8);
  let x = v;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/**
 * Encode a u128 as little-endian 16 bytes.
 */
function u128LeBytes(v: bigint): Uint8Array {
  if (v < 0n || v > (1n << 128n) - 1n) {
    throw new RangeError(`u128LeBytes: out of range u128 (${v.toString()})`);
  }
  const out = new Uint8Array(16);
  let x = v;
  for (let i = 0; i < 16; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/**
 * Decode a `0x`-prefixed hex string into a `Uint8Array`. Strict — the
 * length must be exactly `expectedBytes * 2` (after stripping `0x`) and
 * every character must be hex. Anything else throws.
 */
function decodeFixedHex(s: string, expectedBytes: number): Uint8Array {
  if (typeof s !== "string" || !s.startsWith("0x")) {
    throw new Error(
      `decodeFixedHex: expected "0x"-prefixed hex string, got ${JSON.stringify(s)}`,
    );
  }
  const body = s.slice(2);
  if (body.length !== expectedBytes * 2) {
    throw new Error(
      `decodeFixedHex: expected ${expectedBytes} bytes (${expectedBytes * 2} hex chars), got ${body.length}`,
    );
  }
  if (!/^[0-9a-fA-F]*$/.test(body)) {
    throw new Error(
      `decodeFixedHex: non-hex characters in ${JSON.stringify(s)}`,
    );
  }
  const out = new Uint8Array(expectedBytes);
  for (let i = 0; i < expectedBytes; i++) {
    out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Concatenate a variadic list of byte arrays into a single buffer. Avoids
 * allocating intermediate copies that the spread-then-Uint8Array.from
 * idiom would produce.
 */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the canonical preimage bytes for a materios-x402 payment-signature.
 *
 * This function is pure and deterministic — same payload bytes in, same
 * bytes out, always. Callers can sign the returned buffer directly (after
 * the standard blake2-256 hash step) and the gateway-side verifier will
 * reconstruct the same bytes for verification.
 *
 * The function intentionally does NOT validate semantic constraints
 * (expires-in-future, nonce length, etc) — that's `validatePayload`'s job.
 * It does enforce byte-level invariants (nonce is exactly 32 bytes hex,
 * amount parses as u128, expires fits in u64) so a malformed payload
 * fails loudly at preimage-construction time rather than producing
 * silently-wrong bytes.
 *
 * @param payload - validated materios-x402 payment payload
 * @returns canonical preimage as `Uint8Array`
 *
 * @example
 * ```ts
 * import { buildMateriosPayPreimage } from "@fluxpointstudios/orynq-sdk-payer-materios-x402";
 *
 * const preimage = buildMateriosPayPreimage({
 *   scheme: "materios-x402",
 *   chain: "materios",
 *   network: "preprod",
 *   endpointClass: "receipt_submit",
 *   pricing: { token: "MATRA", decimals: 15, amount: "1000000" },
 *   recipient: "pallet-billing",
 *   nonce: "0x" + "00".repeat(32),
 *   expires: 1700000000,
 * });
 * ```
 */
export function buildMateriosPayPreimage(
  payload: MateriosPaymentPayload,
): Uint8Array {
  // Domain-sep prefix (16 bytes).
  const domain = PREIMAGE_DOMAIN_SEPARATOR;

  // Length-prefixed endpoint class (u32 LE length || utf8 bytes).
  const endpointBytes = new TextEncoder().encode(payload.endpointClass);
  const endpointLen = u32LeBytes(endpointBytes.length);

  // u128 LE pricing.amount.
  let amount: bigint;
  try {
    amount = BigInt(payload.pricing.amount);
  } catch {
    throw new Error(
      `buildMateriosPayPreimage: pricing.amount not parseable as BigInt: ${JSON.stringify(payload.pricing.amount)}`,
    );
  }
  const amountBytes = u128LeBytes(amount);

  // Nonce: exactly 32 raw bytes (decoded from `0x` + 64-hex).
  const nonceBytes = decodeFixedHex(payload.nonce, 32);

  // u64 LE expires.
  const expiresBytes = u64LeBytes(payload.expires);

  return concatBytes(
    domain,
    endpointLen,
    endpointBytes,
    amountBytes,
    nonceBytes,
    expiresBytes,
  );
}
