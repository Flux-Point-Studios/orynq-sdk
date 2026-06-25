/**
 * @summary Tests for verifiable tool-call receipts (issue #60).
 */

import { describe, it, expect } from "vitest";
import {
  createHmac,
  generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";
import {
  createTrace,
  addSpan,
  addEvent,
  closeSpan,
  finalizeTrace,
} from "@fluxpointstudios/orynq-sdk-process-trace";
import type { TraceRun, TraceBundle, ToolReceiptEvent } from "@fluxpointstudios/orynq-sdk-process-trace";
import {
  addToolReceipt,
  hashToolPayload,
  verifyToolReceipts,
  verifyTrace,
  createSigningProxy,
} from "../index.js";

async function traceWithReceipt(
  receipt: ToolReceiptEvent["receipt"],
  responsePayload: unknown = { ok: true }
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

describe("Stripe webhook receipts", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ id: "evt_1", type: "charge.succeeded" });

  it("verifies a valid Stripe signature within tolerance", async () => {
    const t = 1_900_000_000;
    const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    const bundle = await traceWithReceipt({
      scheme: "stripe-webhook",
      signer: "acct_123",
      signature: `t=${t},v1=${v1}`,
      signedPayload: body,
    });
    const outcome = await verifyToolReceipts(bundle, {
      keys: { acct_123: secret },
      nowSec: t + 10,
    });
    expect(outcome.valid).toBe(true);
    expect(outcome.results[0]!.verified).toBe(true);
  });

  it("rejects a stale Stripe signature (outside tolerance)", async () => {
    const t = 1_900_000_000;
    const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    const bundle = await traceWithReceipt({
      scheme: "stripe-webhook",
      signer: "acct_123",
      signature: `t=${t},v1=${v1}`,
      signedPayload: body,
    });
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
    const bundle = await traceWithReceipt({
      scheme: "stripe-webhook",
      signer: "acct_123",
      signature: `t=${t},v1=${v1}`,
      signedPayload: body,
    });
    const outcome = await verifyToolReceipts(bundle, {
      keys: { acct_123: "whsec_wrong" },
      nowSec: t + 10,
    });
    expect(outcome.results[0]!.verified).toBe(false);
  });
});

describe("GitHub webhook receipts", () => {
  const secret = "gh_webhook_secret";
  const body = JSON.stringify({ action: "opened", number: 42 });

  it("verifies a valid sha256= signature", async () => {
    const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    const bundle = await traceWithReceipt({
      scheme: "github-webhook",
      signer: "gh:org/repo",
      signature: sig,
      signedPayload: body,
    });
    const outcome = await verifyToolReceipts(bundle, { keys: { "gh:org/repo": secret } });
    expect(outcome.results[0]!.verified).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    const bundle = await traceWithReceipt({
      scheme: "github-webhook",
      signer: "gh:org/repo",
      signature: sig,
      signedPayload: body + "tampered",
    });
    const outcome = await verifyToolReceipts(bundle, { keys: { "gh:org/repo": secret } });
    expect(outcome.results[0]!.verified).toBe(false);
  });
});

describe("RFC 9421 HTTP Message Signatures", () => {
  it("verifies an ed25519 signature over the signature base", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signatureBase =
      '"@method": POST\n"@path": /charge\n"@signature-params": ("@method" "@path");created=1900000000';
    const sig = cryptoSign(null, Buffer.from(signatureBase), privateKey).toString("base64");
    const bundle = await traceWithReceipt({
      scheme: "http-message-signatures",
      signer: "key-ed25519",
      signature: sig,
      signedPayload: signatureBase,
      params: { alg: "ed25519", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() },
    });
    const outcome = await verifyToolReceipts(bundle);
    expect(outcome.results[0]!.verified).toBe(true);
  });

  it("verifies an ecdsa-p256-sha256 signature", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const signatureBase = '"@method": GET\n"@signature-params": ("@method");created=1';
    const sig = cryptoSign("sha256", Buffer.from(signatureBase), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64");
    const bundle = await traceWithReceipt({
      scheme: "http-message-signatures",
      signer: "key-ec",
      signature: sig,
      signedPayload: signatureBase,
      params: {
        alg: "ecdsa-p256-sha256",
        publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
    });
    const outcome = await verifyToolReceipts(bundle);
    expect(outcome.results[0]!.verified).toBe(true);
  });
});

describe("JWS receipts via signing proxy (anti-lie pattern)", () => {
  it("signs + verifies an EdDSA receipt with embedded public key", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const proxy = createSigningProxy({
      signer: "tee://pricing-proxy",
      alg: "EdDSA",
      privateKey,
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    });
    const receipt = proxy.sign({ price: 4200, currency: "usd" });
    expect(receipt.scheme).toBe("jws");
    const bundle = await traceWithReceipt(receipt);
    const outcome = await verifyToolReceipts(bundle);
    expect(outcome.results[0]!.verified).toBe(true);
  });

  it("signs + verifies an RS256 receipt", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const proxy = createSigningProxy({
      signer: "proxy-rsa",
      alg: "RS256",
      privateKey,
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    });
    const bundle = await traceWithReceipt(proxy.sign({ data: "x" }));
    const outcome = await verifyToolReceipts(bundle);
    expect(outcome.results[0]!.verified).toBe(true);
  });

  it("HS256 secret is NOT embedded and must be supplied to verify", async () => {
    const proxy = createSigningProxy({ signer: "hs-signer", alg: "HS256", secret: "topsecret" });
    const bundle = await traceWithReceipt(proxy.sign({ data: "y" }));
    // Without the secret -> cannot verify.
    const noKey = await verifyToolReceipts(bundle);
    expect(noKey.results[0]!.verified).toBe(false);
    // With the secret -> verifies.
    const withKey = await verifyToolReceipts(bundle, { keys: { "hs-signer": "topsecret" } });
    expect(withKey.results[0]!.verified).toBe(true);
  });

  it("flags a tampered JWS signature", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const proxy = createSigningProxy({
      signer: "tee://x",
      alg: "EdDSA",
      privateKey,
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    });
    const receipt = proxy.sign({ a: 1 });
    // Corrupt the signature.
    receipt.signature = receipt.signature.slice(0, -2) + "AA";
    const bundle = await traceWithReceipt(receipt);
    const outcome = await verifyToolReceipts(bundle);
    expect(outcome.results[0]!.verified).toBe(false);
  });
});

describe("verifyTrace integration", () => {
  it("folds receipt verification into the bundle result", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const proxy = createSigningProxy({
      signer: "tee://ok",
      alg: "EdDSA",
      privateKey,
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    });
    const bundle = await traceWithReceipt(proxy.sign({ ok: true }));

    const result = await verifyTrace(bundle);
    expect(result.valid).toBe(true);
    expect(result.checks.toolReceiptsValid).toBe(true);
    expect(result.toolReceipts.results[0]!.verified).toBe(true);
  });

  it("fails the whole trace when a receipt fails", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const proxy = createSigningProxy({
      signer: "tee://bad",
      alg: "EdDSA",
      privateKey,
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    });
    const receipt = proxy.sign({ ok: true });
    receipt.signature = receipt.signature.slice(0, -2) + "AA";
    const bundle = await traceWithReceipt(receipt);

    const result = await verifyTrace(bundle);
    expect(result.checks.toolReceiptsValid).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("reports unknown schemes as unverified", async () => {
    const bundle = await traceWithReceipt({
      scheme: "exotic-scheme",
      signer: "x",
      signature: "deadbeef",
      signedPayload: "{}",
    });
    const outcome = await verifyToolReceipts(bundle);
    expect(outcome.results[0]!.verified).toBe(false);
    expect(outcome.results[0]!.error).toMatch(/no verifier/i);
  });
});
