/**
 * @summary Tests for verifiable tool-call receipts (issue #60).
 *
 * A receipt only counts as verified when BOTH hold:
 *  1. the signature is valid over `receipt.signedPayload`, AND
 *  2. the signed content commits to the recorded `response.hash`, verified with
 *     an out-of-band (or explicitly trusted) key.
 * The forgery suites below pin those two properties.
 */

import { describe, it, expect } from "vitest";
import {
  createHash,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import {
  createTrace,
  addSpan,
  closeSpan,
  finalizeTrace,
} from "@fluxpointstudios/orynq-sdk-process-trace";
import type { TraceRun, TraceBundle, ToolReceiptEvent } from "@fluxpointstudios/orynq-sdk-process-trace";
import {
  addToolReceipt,
  hashToolPayload,
  verifyJwsReceipt,
  verifyToolReceipts,
  verifyTrace,
  createSigningProxy,
} from "../index.js";
import type { ToolReceiptSchemeVerifier, ToolReceiptVerifyContext } from "../index.js";

/** Record a receipt whose recorded response is `responsePayload`. */
async function traceWithReceipt(
  receipt: ToolReceiptEvent["receipt"],
  responsePayload: unknown
): Promise<TraceBundle> {
  const run: TraceRun = await createTrace({ agentId: "agent-1" });
  const span = addSpan(run, { name: "tool-call", visibility: "public" });
  await addToolReceipt(run, span.id, {
    toolId: "demo.tool",
    request: { hash: await hashToolPayload({ q: 1 }) },
    response: { hash: await hashToolPayload(responsePayload), payload: responsePayload },
    receipt,
  });
  await closeSpan(run, span.id);
  return finalizeTrace(run);
}

const pem = (k: ReturnType<typeof generateKeyPairSync>["publicKey"]): string =>
  k.export({ type: "spki", format: "pem" }).toString();

describe("Stripe webhook receipts", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ id: "evt_1", type: "charge.succeeded" });

  it("verifies a valid Stripe signature within tolerance (response bound to the body)", async () => {
    const t = 1_900_000_000;
    const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    const bundle = await traceWithReceipt(
      { scheme: "stripe-webhook", signer: "acct_123", signature: `t=${t},v1=${v1}`, signedPayload: body },
      body
    );
    const outcome = await verifyToolReceipts(bundle, { keys: { acct_123: secret }, nowSec: t + 10 });
    expect(outcome.valid).toBe(true);
    expect(outcome.results[0]!.verified).toBe(true);
  });

  it("rejects a stale Stripe signature (outside tolerance)", async () => {
    const t = 1_900_000_000;
    const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    const bundle = await traceWithReceipt(
      { scheme: "stripe-webhook", signer: "acct_123", signature: `t=${t},v1=${v1}`, signedPayload: body },
      body
    );
    const outcome = await verifyToolReceipts(bundle, {
      keys: { acct_123: secret },
      nowSec: t + 10_000,
      toleranceSec: 300,
    });
    expect(outcome.valid).toBe(false);
    expect(outcome.results[0]!.error).toMatch(/tolerance/i);
  });

  it("rejects a wrong secret", async () => {
    const t = 1_900_000_000;
    const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    const bundle = await traceWithReceipt(
      { scheme: "stripe-webhook", signer: "acct_123", signature: `t=${t},v1=${v1}`, signedPayload: body },
      body
    );
    const outcome = await verifyToolReceipts(bundle, { keys: { acct_123: "whsec_wrong" }, nowSec: t + 10 });
    expect(outcome.results[0]!.verified).toBe(false);
  });
});

describe("GitHub webhook receipts", () => {
  const secret = "gh_webhook_secret";
  const body = JSON.stringify({ action: "opened", number: 42 });

  it("verifies a valid sha256= signature bound to the body", async () => {
    const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    const bundle = await traceWithReceipt(
      { scheme: "github-webhook", signer: "gh:org/repo", signature: sig, signedPayload: body },
      body
    );
    const outcome = await verifyToolReceipts(bundle, { keys: { "gh:org/repo": secret } });
    expect(outcome.results[0]!.verified).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    const bundle = await traceWithReceipt(
      { scheme: "github-webhook", signer: "gh:org/repo", signature: sig, signedPayload: body + "tampered" },
      body
    );
    const outcome = await verifyToolReceipts(bundle, { keys: { "gh:org/repo": secret } });
    expect(outcome.results[0]!.verified).toBe(false);
  });
});

describe("RFC 9421 HTTP Message Signatures", () => {
  it("verifies an ed25519 signature whose base binds the body via content-digest", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const body = JSON.stringify({ charged: true });
    const cd = createHash("sha256").update(body).digest("base64");
    const signatureBase =
      `"@method": POST\n"@path": /charge\n"content-digest": sha-256=:${cd}:\n` +
      `"@signature-params": ("@method" "@path" "content-digest");created=1900000000`;
    const sig = cryptoSign(null, Buffer.from(signatureBase), privateKey).toString("base64");
    const bundle = await traceWithReceipt(
      {
        scheme: "http-message-signatures",
        signer: "key-ed25519",
        signature: sig,
        signedPayload: signatureBase,
        params: { alg: "ed25519", publicKey: pem(publicKey) },
      },
      body
    );
    const outcome = await verifyToolReceipts(bundle, { keys: { "key-ed25519": pem(publicKey) } });
    expect(outcome.results[0]!.verified).toBe(true);
  });

  it("rejects an RFC 9421 receipt whose base has no content-digest (proves nothing about the response)", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const body = JSON.stringify({ charged: true });
    const signatureBase = '"@method": POST\n"@signature-params": ("@method");created=1900000000';
    const sig = cryptoSign(null, Buffer.from(signatureBase), privateKey).toString("base64");
    const bundle = await traceWithReceipt(
      {
        scheme: "http-message-signatures",
        signer: "key-ed25519",
        signature: sig,
        signedPayload: signatureBase,
        params: { alg: "ed25519", publicKey: pem(publicKey) },
      },
      body
    );
    const outcome = await verifyToolReceipts(bundle, { keys: { "key-ed25519": pem(publicKey) } });
    expect(outcome.results[0]!.verified).toBe(false);
    expect(outcome.results[0]!.reason).toBe("response-not-bound");
  });
});

describe("JWS receipts via signing proxy (anti-lie pattern)", () => {
  it("signs + verifies an EdDSA receipt with an out-of-band key", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const proxy = createSigningProxy({ signer: "tee://pricing-proxy", alg: "EdDSA", privateKey, publicKey: pem(publicKey) });
    const payload = { price: 4200, currency: "usd" };
    const receipt = proxy.sign(payload);
    expect(receipt.scheme).toBe("jws");
    const bundle = await traceWithReceipt(receipt, payload);
    const outcome = await verifyToolReceipts(bundle, { keys: { "tee://pricing-proxy": pem(publicKey) } });
    expect(outcome.results[0]!.verified).toBe(true);
  });

  it("signs + verifies an RS256 receipt", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const proxy = createSigningProxy({ signer: "proxy-rsa", alg: "RS256", privateKey, publicKey: pem(publicKey) });
    const payload = { data: "x" };
    const bundle = await traceWithReceipt(proxy.sign(payload), payload);
    const outcome = await verifyToolReceipts(bundle, { keys: { "proxy-rsa": pem(publicKey) } });
    expect(outcome.results[0]!.verified).toBe(true);
  });

  it("HS256 secret is NOT embedded and must be supplied to verify", async () => {
    const proxy = createSigningProxy({ signer: "hs-signer", alg: "HS256", secret: "topsecret" });
    const payload = { data: "y" };
    const bundle = await traceWithReceipt(proxy.sign(payload), payload);
    const noKey = await verifyToolReceipts(bundle);
    expect(noKey.results[0]!.verified).toBe(false);
    const withKey = await verifyToolReceipts(bundle, { keys: { "hs-signer": "topsecret" } });
    expect(withKey.results[0]!.verified).toBe(true);
  });

  it("flags a tampered JWS signature", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const proxy = createSigningProxy({ signer: "tee://x", alg: "EdDSA", privateKey, publicKey: pem(publicKey) });
    const payload = { a: 1 };
    const receipt = proxy.sign(payload);
    // Deterministic tamper: flip a byte in the DECODED signature and re-encode.
    // A base64url character swap can decode to identical bytes for a 64-byte
    // ed25519 sig, so tamper at the byte level to reliably corrupt it.
    const sigBytes = Buffer.from(receipt.signature, "base64url");
    sigBytes[Math.floor(sigBytes.length / 2)] ^= 0xff;
    receipt.signature = sigBytes.toString("base64url");
    const bundle = await traceWithReceipt(receipt, payload);
    const outcome = await verifyToolReceipts(bundle, { keys: { "tee://x": pem(publicKey) } });
    expect(outcome.results[0]!.verified).toBe(false);
  });
});

describe("Forgery resistance (issue #60 core guarantee)", () => {
  it("rejects a genuine signature paired with a fabricated response (response-swap)", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const proxy = createSigningProxy({ signer: "tee://oracle", alg: "EdDSA", privateKey, publicKey: pem(publicKey) });
    // The TEE honestly signs price:100 ...
    const receipt = proxy.sign({ price: 100, currency: "usd" });
    // ... but the agent records price:1 next to the genuine receipt.
    const bundle = await traceWithReceipt(receipt, { price: 1, currency: "usd" });
    const outcome = await verifyToolReceipts(bundle, { keys: { "tee://oracle": pem(publicKey) } });
    expect(outcome.results[0]!.verified).toBe(false);
    expect(outcome.results[0]!.reason).toBe("response-binding-mismatch");
  });

  it("rejects an attacker-embedded key claiming a trusted signer (embedded key not trusted by default)", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const proxy = createSigningProxy({
      signer: "tee://trusted-oracle",
      alg: "EdDSA",
      privateKey, // attacker's own key
      publicKey: pem(publicKey), // attacker embeds the matching pubkey
    });
    const payload = { price: 999_999, note: "FORGED" };
    const receipt = proxy.sign(payload); // response binding matches — attacker controls both
    const bundle = await traceWithReceipt(receipt, payload);

    // Default: embedded key is untrusted -> not verified.
    const def = await verifyToolReceipts(bundle);
    expect(def.results[0]!.verified).toBe(false);

    // An auditor who pins the REAL oracle key rejects the forged signature.
    const { publicKey: realPub } = generateKeyPairSync("ed25519");
    const pinned = await verifyToolReceipts(bundle, { keys: { "tee://trusted-oracle": pem(realPub) } });
    expect(pinned.results[0]!.verified).toBe(false);
  });

  it("accepts an embedded key ONLY when the caller explicitly opts in", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const proxy = createSigningProxy({ signer: "tee://p", alg: "EdDSA", privateKey, publicKey: pem(publicKey) });
    const payload = { ok: true };
    const bundle = await traceWithReceipt(proxy.sign(payload), payload);
    const outcome = await verifyToolReceipts(bundle, { trustEmbeddedKeys: true });
    expect(outcome.results[0]!.verified).toBe(true);
  });
});

describe("verifyTrace integration", () => {
  it("folds receipt verification into the bundle result", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const proxy = createSigningProxy({ signer: "tee://ok", alg: "EdDSA", privateKey, publicKey: pem(publicKey) });
    const payload = { ok: true };
    const bundle = await traceWithReceipt(proxy.sign(payload), payload);

    const result = await verifyTrace(bundle, { keys: { "tee://ok": pem(publicKey) } });
    expect(result.valid).toBe(true);
    expect(result.checks.toolReceiptsValid).toBe(true);
    expect(result.toolReceipts.results[0]!.verified).toBe(true);
  });

  it("fails the whole trace when a receipt fails", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const proxy = createSigningProxy({ signer: "tee://bad", alg: "EdDSA", privateKey, publicKey: pem(publicKey) });
    const payload = { ok: true };
    const receipt = proxy.sign(payload);
    const sigBytes = Buffer.from(receipt.signature, "base64url");
    sigBytes[Math.floor(sigBytes.length / 2)] ^= 0xff;
    receipt.signature = sigBytes.toString("base64url");
    const bundle = await traceWithReceipt(receipt, payload);

    const result = await verifyTrace(bundle, { keys: { "tee://bad": pem(publicKey) } });
    expect(result.checks.toolReceiptsValid).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("reports unknown schemes as unverified", async () => {
    const bundle = await traceWithReceipt(
      { scheme: "exotic-scheme", signer: "x", signature: "deadbeef", signedPayload: "{}" },
      {}
    );
    const outcome = await verifyToolReceipts(bundle);
    expect(outcome.results[0]!.verified).toBe(false);
    expect(outcome.results[0]!.error).toMatch(/no verifier/i);
  });
});

describe("externally registered schemes", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keys = { "acme:pricing": pem(publicKey) };
  const signedBody = JSON.stringify({ price: 4200, currency: "usd" });

  /** A detached ed25519 signature whose signed bytes are the raw response body. */
  const detachedReceipt = (body: string): ToolReceiptEvent["receipt"] => ({
    scheme: "detached-ed25519",
    signer: "acme:pricing",
    signature: cryptoSign(null, Buffer.from(body), privateKey).toString("base64"),
    signedPayload: body,
  });

  const detachedEd25519: ToolReceiptSchemeVerifier = async (
    event: ToolReceiptEvent,
    ctx?: ToolReceiptVerifyContext
  ) => {
    const key = ctx?.keys?.[event.receipt.signer];
    if (key === undefined) throw new Error("detached-ed25519: signer key not configured");
    return cryptoVerify(
      null,
      Buffer.from(event.receipt.signedPayload),
      createPublicKey(key),
      Buffer.from(event.receipt.signature, "base64")
    );
  };
  detachedEd25519.responseCommitment = async (event) => hashToolPayload(event.receipt.signedPayload);

  it("verifies a receipt whose registered scheme commits to the recorded response", async () => {
    const bundle = await traceWithReceipt(detachedReceipt(signedBody), signedBody);
    const result = await verifyTrace(bundle, {
      keys,
      verifiers: { "detached-ed25519": detachedEd25519 },
    });
    expect(result.toolReceipts.results[0]!.reason).toBeUndefined();
    expect(result.toolReceipts.results[0]!.verified).toBe(true);
    expect(result.toolReceipts.results[0]!.callBound).toBe(false);
    expect(result.valid).toBe(true);
  });

  it("rejects a genuine custom-scheme signature paired with a fabricated response", async () => {
    const bundle = await traceWithReceipt(
      detachedReceipt(signedBody),
      JSON.stringify({ price: 1, currency: "usd" })
    );
    const outcome = await verifyToolReceipts(bundle, {
      keys,
      verifiers: { "detached-ed25519": detachedEd25519 },
    });
    expect(outcome.results[0]!.reason).toBe("response-binding-mismatch");
    expect(outcome.results[0]!.verified).toBe(false);
  });

  it("fails closed when a scheme accepts every signature but registers no response commitment", async () => {
    const bundle = await traceWithReceipt(detachedReceipt(signedBody), signedBody);
    const outcome = await verifyToolReceipts(bundle, {
      verifiers: { "detached-ed25519": async () => true },
    });
    expect(outcome.results[0]!.reason).toBe("response-not-bound");
    expect(outcome.results[0]!.verified).toBe(false);
  });

  it("fails closed when a scheme's response commitment reports the receipt unbound", async () => {
    const unbound: ToolReceiptSchemeVerifier = async () => true;
    unbound.responseCommitment = async () => null;
    const bundle = await traceWithReceipt(detachedReceipt(signedBody), signedBody);
    const outcome = await verifyToolReceipts(bundle, {
      verifiers: { "detached-ed25519": unbound },
    });
    expect(outcome.results[0]!.reason).toBe("response-not-bound");
    expect(outcome.results[0]!.verified).toBe(false);
  });

  it("keeps the built-in response binding when a built-in scheme is overridden without a commitment", async () => {
    const { privateKey: jwsKey, publicKey: jwsPub } = generateKeyPairSync("ed25519");
    const proxy = createSigningProxy({ signer: "tee://oracle", alg: "EdDSA", privateKey: jwsKey });
    const bundle = await traceWithReceipt(proxy.sign({ price: 100 }), { price: 1 });
    const outcome = await verifyToolReceipts(bundle, {
      keys: { "tee://oracle": pem(jwsPub) },
      verifiers: { jws: (event, ctx) => verifyJwsReceipt(event, ctx) },
    });
    expect(outcome.results[0]!.reason).toBe("response-binding-mismatch");
    expect(outcome.results[0]!.verified).toBe(false);
  });

  it("lets an overriding scheme's unbound commitment replace the built-in one", async () => {
    const { privateKey: jwsKey, publicKey: jwsPub } = generateKeyPairSync("ed25519");
    const proxy = createSigningProxy({ signer: "tee://oracle", alg: "EdDSA", privateKey: jwsKey });
    const bundle = await traceWithReceipt(proxy.sign({ price: 100 }), { price: 100 });
    const jwsKeys = { "tee://oracle": pem(jwsPub) };
    const builtin = await verifyToolReceipts(bundle, { keys: jwsKeys });
    expect(builtin.results[0]!.verified).toBe(true);

    const override: ToolReceiptSchemeVerifier = (event, ctx) => verifyJwsReceipt(event, ctx);
    override.responseCommitment = async () => null;
    const outcome = await verifyToolReceipts(bundle, { keys: jwsKeys, verifiers: { jws: override } });
    expect(outcome.results[0]!.reason).toBe("response-not-bound");
    expect(outcome.results[0]!.verified).toBe(false);
  });

  it("finds no verifier for a scheme that only a polluted Object.prototype supplies", async () => {
    const bundle = await traceWithReceipt(
      { scheme: "planted-scheme", signer: "s", signature: "AA", signedPayload: "anything" },
      { price: 1 }
    );
    const planted: ToolReceiptSchemeVerifier = async () => true;
    planted.responseCommitment = async (event) => event.response.hash;
    Object.defineProperty(Object.prototype, "planted-scheme", { configurable: true, value: planted });
    try {
      for (const ctx of [undefined, { verifiers: {} }]) {
        const outcome = await verifyToolReceipts(bundle, ctx);
        expect(outcome.results[0]).toMatchObject({ verified: false, error: expect.stringMatching(/no verifier/i) });
      }
    } finally {
      delete (Object.prototype as Record<string, unknown>)["planted-scheme"];
    }
  });

  it("finds no verifier for a scheme named after an Object.prototype member", async () => {
    for (const scheme of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const bundle = await traceWithReceipt({ scheme, signer: "s", signature: "AA", signedPayload: "x" }, "x");
      for (const ctx of [undefined, { verifiers: {} }]) {
        const outcome = await verifyToolReceipts(bundle, ctx);
        expect(outcome.results[0], scheme).toMatchObject({
          verified: false,
          error: expect.stringMatching(/no verifier/i),
        });
      }
    }
  });

  it("fails closed instead of throwing when a JavaScript caller passes a null registry", async () => {
    const bundle = await traceWithReceipt({ scheme: "custom", signer: "s", signature: "AA", signedPayload: "x" }, "x");
    const ctx = { verifiers: null } as unknown as ToolReceiptVerifyContext;
    const outcome = await verifyToolReceipts(bundle, ctx);
    expect(outcome.results[0]).toMatchObject({ verified: false, error: expect.stringMatching(/no verifier/i) });
  });

  it("ignores a response commitment inherited from a polluted Object.prototype", async () => {
    const { privateKey: jwsKey, publicKey: jwsPub } = generateKeyPairSync("ed25519");
    const proxy = createSigningProxy({ signer: "tee://oracle", alg: "EdDSA", privateKey: jwsKey });
    const bundle = await traceWithReceipt(proxy.sign({ price: 100 }), { price: 1 });
    Object.defineProperty(Object.prototype, "responseCommitment", {
      configurable: true,
      value: async (event: ToolReceiptEvent) => event.response.hash,
    });
    try {
      const outcome = await verifyToolReceipts(bundle, { keys: { "tee://oracle": pem(jwsPub) } });
      expect(outcome.results[0]!.reason).toBe("response-binding-mismatch");
      expect(outcome.results[0]!.verified).toBe(false);
    } finally {
      delete (Object.prototype as { responseCommitment?: unknown }).responseCommitment;
    }
  });
});
