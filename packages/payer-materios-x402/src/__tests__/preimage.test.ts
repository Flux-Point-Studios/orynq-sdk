/**
 * @summary Byte-pinned tests for the materios-x402 canonical preimage.
 *
 * These tests are the WIRE-FORMAT CONTRACT for any downstream verifier.
 * If a refactor breaks one of the byte-pin assertions below, the format
 * has shifted and every verifier (gateway settlement signer, future Rust
 * pallet check, Python daemons, etc) must update in lockstep — or, the
 * domain separator must bump from `v1` to `v2`.
 */

import { describe, it, expect } from "vitest";
import {
  buildMateriosPayPreimage,
  PREIMAGE_DOMAIN_SEPARATOR,
} from "../preimage.js";
import type { MateriosPaymentPayload } from "../types.js";

const NONCE_FIXED =
  "0x" +
  "00112233445566778899aabbccddeeff" +
  "00112233445566778899aabbccddeeff";

const PAYLOAD_FIXED: MateriosPaymentPayload = {
  scheme: "materios-x402",
  chain: "materios",
  network: "preprod",
  endpointClass: "receipt_submit",
  pricing: { token: "MATRA", decimals: 15, amount: "1000000" },
  recipient: "pallet-billing",
  nonce: NONCE_FIXED,
  expires: 1700000000,
};

/**
 * Hex-encode a Uint8Array for human-readable assertions.
 */
function toHex(b: Uint8Array): string {
  return Array.from(b)
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}

describe("PREIMAGE_DOMAIN_SEPARATOR", () => {
  it("is exactly the UTF-8 bytes of 'materios-x402-v1' (16 bytes)", () => {
    expect(PREIMAGE_DOMAIN_SEPARATOR.length).toBe(16);
    expect(toHex(PREIMAGE_DOMAIN_SEPARATOR)).toBe(
      // m a t e r i o s - x 4 0 2 - v 1
      "6d6174657269" + "6f732d783430" + "322d7631",
    );
  });
});

describe("buildMateriosPayPreimage", () => {
  it("is byte-deterministic across two calls with the same input", () => {
    const a = buildMateriosPayPreimage(PAYLOAD_FIXED);
    const b = buildMateriosPayPreimage(PAYLOAD_FIXED);
    expect(toHex(a)).toBe(toHex(b));
  });

  it("produces a different preimage when endpointClass changes (anti-collision)", () => {
    const a = buildMateriosPayPreimage(PAYLOAD_FIXED);
    const b = buildMateriosPayPreimage({
      ...PAYLOAD_FIXED,
      endpointClass: "chunk_upload",
    });
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it("produces a different preimage when pricing.amount changes", () => {
    const a = buildMateriosPayPreimage(PAYLOAD_FIXED);
    const b = buildMateriosPayPreimage({
      ...PAYLOAD_FIXED,
      pricing: { ...PAYLOAD_FIXED.pricing, amount: "1000001" },
    });
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it("produces a different preimage when nonce changes", () => {
    const a = buildMateriosPayPreimage(PAYLOAD_FIXED);
    const altNonce = "0x" + "ff".repeat(32);
    const b = buildMateriosPayPreimage({
      ...PAYLOAD_FIXED,
      nonce: altNonce,
    });
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it("produces a different preimage when expires changes", () => {
    const a = buildMateriosPayPreimage(PAYLOAD_FIXED);
    const b = buildMateriosPayPreimage({
      ...PAYLOAD_FIXED,
      expires: PAYLOAD_FIXED.expires + 1,
    });
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it("BYTE-PIN: matches the canonical layout for the fixed test vector", () => {
    // Layout assembly (LE everywhere except UTF-8 strings):
    //   domain        = "materios-x402-v1"                                            (16 bytes)
    //   endpointLen   = 0x0e000000  (= 14 LE)
    //   endpointBytes = "receipt_submit"                                              (14 bytes)
    //   amount(u128)  = 1000000  -> 40 42 0f 00 00 ... (16 bytes, LE)
    //   nonce(32)     = 00112233445566778899aabbccddeeff (×2)
    //   expires(u64)  = 1_700_000_000 = 0x6553F100 -> LE 00 F1 53 65 00 00 00 00
    const expectedHex =
      // domain "materios-x402-v1"
      "6d6174657269" + "6f732d783430" + "322d7631" +
      // u32 LE 14
      "0e000000" +
      // "receipt_submit" (14 bytes ASCII)
      "726563656970745f7375626d6974" +
      // u128 LE 1_000_000 (0x0F4240)
      "40420f00000000000000000000000000" +
      // nonce 32 bytes
      "00112233445566778899aabbccddeeff" +
      "00112233445566778899aabbccddeeff" +
      // u64 LE 1_700_000_000 (0x6553F100)
      "00f1536500000000";
    const got = toHex(buildMateriosPayPreimage(PAYLOAD_FIXED));
    expect(got).toBe(expectedHex);

    // Sanity-check total length: 16 + 4 + 14 + 16 + 32 + 8 = 90 bytes = 180 hex chars.
    expect(got.length).toBe(180);
  });

  it("rejects a malformed nonce (not 0x + 64 hex)", () => {
    expect(() =>
      buildMateriosPayPreimage({ ...PAYLOAD_FIXED, nonce: "0xdeadbeef" }),
    ).toThrow(/decodeFixedHex/);
  });

  it("rejects a pricing.amount that is not a BigInt-parseable string", () => {
    expect(() =>
      buildMateriosPayPreimage({
        ...PAYLOAD_FIXED,
        pricing: { ...PAYLOAD_FIXED.pricing, amount: "not-a-number" },
      }),
    ).toThrow(/pricing\.amount/);
  });
});
