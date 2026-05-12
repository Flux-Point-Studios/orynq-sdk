/**
 * @summary Behavioral tests for the materios-x402 payer factory + paths.
 *
 * Covers:
 *  - factory routing (api-key vs self-pay)
 *  - api-key path fail-fast
 *  - self-pay validation (scheme, expires, nonce, amount)
 *  - self-pay sign → verify roundtrip against //Alice
 *  - PaymentProof header shape (sig hex, ss58 prefix-42)
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  cryptoWaitReady,
  sr25519Verify,
  blake2AsU8a,
  decodeAddress,
  encodeAddress,
} from "@polkadot/util-crypto";
import { Keyring } from "@polkadot/keyring";
import {
  createMateriosPayer,
  MateriosApiKeyPayer,
  MateriosSelfPayPayer,
  parseMateriosPaymentRequired,
  validatePayload,
  unpackPaymentProofHeaders,
  verifyMateriosPaymentSignature,
  buildMateriosPayPreimage,
} from "../index.js";
import type { MateriosPaymentPayload } from "../types.js";
import type { PaymentRequest } from "@fluxpointstudios/orynq-sdk-core";

const NONCE_FIXED =
  "0x" +
  "00112233445566778899aabbccddeeff" +
  "00112233445566778899aabbccddeeff";

// Build a fresh payload with `expires` always 60s in the future relative
// to the test wall-clock. Tests that need an expired payload pass a
// negative offset.
function freshPayload(opts?: Partial<MateriosPaymentPayload> & {
  expiresOffsetSec?: number;
}): MateriosPaymentPayload {
  const offset = opts?.expiresOffsetSec ?? 60;
  const base: MateriosPaymentPayload = {
    scheme: "materios-x402",
    chain: "materios",
    network: "preprod",
    endpointClass: "receipt_submit",
    pricing: { token: "MATRA", decimals: 15, amount: "1000000" },
    recipient: "pallet-billing",
    nonce: NONCE_FIXED,
    expires: Math.floor(Date.now() / 1000) + offset,
  };
  return { ...base, ...(opts ?? {}) };
}

beforeAll(async () => {
  await cryptoWaitReady();
});

// ---------------------------------------------------------------------------
// 1. Factory routing
// ---------------------------------------------------------------------------

describe("createMateriosPayer factory", () => {
  it("routes { apiKey } to MateriosApiKeyPayer", () => {
    const payer = createMateriosPayer({ apiKey: "matra_abcdefgh" });
    expect(payer).toBeInstanceOf(MateriosApiKeyPayer);
  });

  it("routes { signerUri } to MateriosSelfPayPayer", () => {
    const payer = createMateriosPayer({ signerUri: "//Alice" });
    expect(payer).toBeInstanceOf(MateriosSelfPayPayer);
  });

  it("throws when neither apiKey nor signerUri is provided", () => {
    expect(() =>
      // @ts-expect-error — intentional invalid call shape
      createMateriosPayer({}),
    ).toThrow(/either \{ apiKey \}|signerUri/);
  });

  it("throws when both apiKey and signerUri are provided", () => {
    expect(() =>
      // @ts-expect-error — intentional invalid call shape
      createMateriosPayer({ apiKey: "matra_x", signerUri: "//Alice" }),
    ).toThrow(/not both/);
  });
});

// ---------------------------------------------------------------------------
// 2. api-key path
// ---------------------------------------------------------------------------

describe("MateriosApiKeyPayer", () => {
  it("pay() throws a descriptive PaymentFailedError mentioning the api-key situation", async () => {
    const payer = createMateriosPayer({ apiKey: "matra_abcdefgh" });
    const req: PaymentRequest = {
      protocol: "x402",
      chain: "materios:preprod",
      asset: "MATRA",
      amountUnits: "1000000",
      payTo: "pallet-billing",
    };
    await expect(payer.pay(req)).rejects.toThrow(
      /api-key|treasury|cap|self-pay/i,
    );
  });

  it("supports() returns true for materios x402 requests", () => {
    const payer = createMateriosPayer({ apiKey: "matra_abcdefgh" });
    expect(
      payer.supports({
        protocol: "x402",
        chain: "materios:preprod",
        asset: "MATRA",
        amountUnits: "1",
        payTo: "x",
      }),
    ).toBe(true);
  });

  it("rejects a malformed api key", () => {
    expect(() => new MateriosApiKeyPayer({ apiKey: "not-prefixed" })).toThrow(
      /matra_/,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Self-pay parsing + validation
// ---------------------------------------------------------------------------

describe("parseMateriosPaymentRequired / validatePayload", () => {
  it("parses a valid header value", () => {
    const payload = freshPayload();
    const headerValue = JSON.stringify(payload);
    const parsed = parseMateriosPaymentRequired(headerValue);
    expect(parsed.scheme).toBe("materios-x402");
    expect(parsed.endpointClass).toBe("receipt_submit");
  });

  it("rejects a header with scheme !== 'materios-x402'", () => {
    const headerValue = JSON.stringify({
      ...freshPayload(),
      scheme: "x402-evm",
    });
    expect(() => parseMateriosPaymentRequired(headerValue)).toThrow(
      /materios-x402/,
    );
  });

  it("rejects a payload with expires in the past", () => {
    const payload = freshPayload({ expiresOffsetSec: -60 });
    expect(() => validatePayload(payload)).toThrow(/expired/);
  });

  it("rejects a payload with malformed nonce (not 0x + 64-hex)", () => {
    const payload = freshPayload({ nonce: "0xdeadbeef" });
    expect(() => validatePayload(payload)).toThrow(/nonce/);
  });

  it("rejects a payload with non-numeric pricing.amount", () => {
    const payload = freshPayload({
      pricing: { token: "MATRA", decimals: 15, amount: "abc" },
    });
    expect(() => validatePayload(payload)).toThrow(/pricing\.amount/);
  });

  it("rejects malformed JSON in the header value", () => {
    expect(() => parseMateriosPaymentRequired("not-json-at-all")).toThrow(
      /not valid JSON/,
    );
  });

  // ---------------------------------------------------------------------------
  // 0.1.1 polish (task #228) — additional validation coverage
  // ---------------------------------------------------------------------------

  it("[#228 L3] rejects a payload with a non-MATRA pricing.token", () => {
    const payload = freshPayload({
      pricing: { token: "USDC" as unknown as "MATRA", decimals: 15, amount: "1000000" },
    });
    expect(() => validatePayload(payload)).toThrow(
      /unsupported token.*MATRA/,
    );
  });

  it("[#228 L3] rejects a payload with pricing.decimals !== 15", () => {
    const payload = freshPayload({
      pricing: { token: "MATRA", decimals: 6 as 15, amount: "1000000" },
    });
    expect(() => validatePayload(payload)).toThrow(
      /unsupported decimals.*15.*MATRA/,
    );
  });

  it("[#228 L4] rejects a payload with empty endpointClass", () => {
    const payload = freshPayload({ endpointClass: "" });
    expect(() => validatePayload(payload)).toThrow(/empty endpointClass/);
  });

  it("[#228 L4] rejects a payload with non-canonical endpointClass casing/punctuation", () => {
    const payload = freshPayload({ endpointClass: "Receipt-Submit" });
    expect(() => validatePayload(payload)).toThrow(
      /endpointClass must match/,
    );
  });

  it("[#228 L5] rejects a payload with pricing.amount === '0' (zero-charge 402)", () => {
    const payload = freshPayload({
      pricing: { token: "MATRA", decimals: 15, amount: "0" },
    });
    expect(() => validatePayload(payload)).toThrow(/must be > 0/);
  });
});

// ---------------------------------------------------------------------------
// 4. Self-pay sign + verify roundtrip
// ---------------------------------------------------------------------------

describe("MateriosSelfPayPayer sign/verify roundtrip", () => {
  it("signs a known-good payload and the signature verifies against the keypair's public key", async () => {
    const payer = new MateriosSelfPayPayer({ signerUri: "//Alice" });
    const payload = freshPayload();
    const result = await payer.signMateriosPaymentRequest(payload);

    // sr25519 signatures are non-deterministic — we cannot pin the sig
    // bytes themselves. Instead, verify the signature.
    expect(result.headers["x-402-payment-signature"]).toMatch(
      /^0x[0-9a-f]{128}$/,
    );

    // Decode the SS58 to grab the raw public key (32 bytes) for verification.
    const publicKey = decodeAddress(result.headers["x-402-payer-ss58"]);
    expect(publicKey.length).toBe(32);

    const preimage = buildMateriosPayPreimage(payload);
    const message = blake2AsU8a(preimage, 256);
    const sig = hexToBytes(result.headers["x-402-payment-signature"]);
    expect(sr25519Verify(message, sig, publicKey)).toBe(true);
  });

  it("the convenience verifier accepts a valid sig", async () => {
    const payer = new MateriosSelfPayPayer({ signerUri: "//Alice" });
    const payload = freshPayload();
    const result = await payer.signMateriosPaymentRequest(payload);
    const publicKey = decodeAddress(result.headers["x-402-payer-ss58"]);
    expect(
      verifyMateriosPaymentSignature({
        payload,
        signatureHex: result.headers["x-402-payment-signature"],
        publicKey,
      }),
    ).toBe(true);
  });

  it("the convenience verifier rejects a sig from a different signer", async () => {
    const alicePayer = new MateriosSelfPayPayer({ signerUri: "//Alice" });
    const payload = freshPayload();
    const result = await alicePayer.signMateriosPaymentRequest(payload);

    // Derive Bob's public key — different signer, sig must NOT verify.
    const keyring = new Keyring({ type: "sr25519", ss58Format: 42 });
    const bob = keyring.addFromUri("//Bob");
    expect(
      verifyMateriosPaymentSignature({
        payload,
        signatureHex: result.headers["x-402-payment-signature"],
        publicKey: bob.publicKey,
      }),
    ).toBe(false);
  });

  it("returns a PaymentProof.signature that unpacks into the two header values", async () => {
    const payer = new MateriosSelfPayPayer({ signerUri: "//Alice" });
    const payload = freshPayload();
    const req: PaymentRequest = {
      protocol: "x402",
      chain: "materios:preprod",
      asset: "MATRA",
      amountUnits: payload.pricing.amount,
      payTo: payload.recipient,
      raw: payload,
    };
    const proof = await payer.pay(req);
    expect(proof.kind).toBe("x402-signature");
    const headers = unpackPaymentProofHeaders((proof as { signature: string }).signature);
    expect(headers["x-402-payment-signature"]).toMatch(/^0x[0-9a-f]{128}$/);
    // Re-encode the ss58 with prefix-42 to make the test independent of
    // any default-prefix drift in @polkadot/keyring.
    const pk = decodeAddress(headers["x-402-payer-ss58"]);
    expect(encodeAddress(pk, 42)).toBe(headers["x-402-payer-ss58"]);
  });

  it("pay() throws if request.raw is missing or malformed", async () => {
    const payer = new MateriosSelfPayPayer({ signerUri: "//Alice" });
    const req: PaymentRequest = {
      protocol: "x402",
      chain: "materios:preprod",
      asset: "MATRA",
      amountUnits: "1",
      payTo: "pallet-billing",
      // raw is intentionally undefined
    };
    await expect(payer.pay(req)).rejects.toThrow(/materios-x402 payment payload/);
  });

  it("pay() throws when protocol !== 'x402'", async () => {
    const payer = new MateriosSelfPayPayer({ signerUri: "//Alice" });
    const req = {
      protocol: "flux",
      chain: "materios:preprod",
      asset: "MATRA",
      amountUnits: "1",
      payTo: "pallet-billing",
    } as unknown as PaymentRequest;
    await expect(payer.pay(req)).rejects.toThrow(/only supports x402/);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBytes(s: string): Uint8Array {
  const body = s.startsWith("0x") ? s.slice(2) : s;
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
