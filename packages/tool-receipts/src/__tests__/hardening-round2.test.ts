/**
 * @summary Round-2 hardening regression tests for tool-call receipts.
 *
 * Each suite reproduces an exploit an adversarial re-review surfaced, then
 * asserts the receipt now FAILS to verify:
 *  1. response.payload↔hash gap — auditors read `response.payload`, so an
 *     honest `response.hash` paired with a fabricated `response.payload` must
 *     not verify.
 *  2. JWT algorithm confusion — an asymmetric public key must never be fed into
 *     an HMAC branch (alg:HS256 over a known public-key PEM).
 *  3. Replay / call-binding — a self-signed JWS receipt lifted into a different
 *     runId/request must fail; external webhook receipts are authenticity-only
 *     and flagged not-call-bound.
 */

import { describe, it, expect } from "vitest";
import { createHmac, generateKeyPairSync } from "node:crypto";
import {
  createTrace,
  addSpan,
  closeSpan,
  finalizeTrace,
} from "@fluxpointstudios/orynq-sdk-process-trace";
import type {
  TraceRun,
  TraceBundle,
  ToolReceiptEvent,
} from "@fluxpointstudios/orynq-sdk-process-trace";
import {
  addToolReceipt,
  hashToolPayload,
  verifyToolReceipts,
  createSigningProxy,
} from "../index.js";

const pem = (k: ReturnType<typeof generateKeyPairSync>["publicKey"]): string =>
  k.export({ type: "spki", format: "pem" }).toString();

/** Record a receipt with an explicit request/response, returning the bundle. */
async function traceWith(opts: {
  receipt: ToolReceiptEvent["receipt"];
  request: { hash: string };
  response: { hash: string; payload?: unknown };
}): Promise<TraceBundle> {
  const run: TraceRun = await createTrace({ agentId: "agent-h2" });
  const span = addSpan(run, { name: "tool-call", visibility: "public" });
  await addToolReceipt(run, span.id, {
    toolId: "demo.tool",
    request: opts.request,
    response: opts.response,
    receipt: opts.receipt,
  });
  await closeSpan(run, span.id);
  return finalizeTrace(run);
}

describe("response.payload vs response.hash binding", () => {
  it("rejects an honest response.hash paired with a fabricated response.payload", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const proxy = createSigningProxy({
      signer: "tee://oracle",
      alg: "EdDSA",
      privateKey,
      publicKey: pem(publicKey),
    });
    const honest = { price: 100, currency: "usd" };
    const receipt = proxy.sign(honest);

    // Signature binds to the honest hash, but the retained human-readable
    // payload auditors actually read is fabricated.
    const bundle = await traceWith({
      receipt,
      request: { hash: await hashToolPayload({ q: 1 }) },
      response: { hash: await hashToolPayload(honest), payload: { price: 1, currency: "usd" } },
    });

    const outcome = await verifyToolReceipts(bundle, {
      keys: { "tee://oracle": pem(publicKey) },
    });
    expect(outcome.results[0]!.verified).toBe(false);
    expect(outcome.results[0]!.reason).toBe("response-payload-mismatch");
  });

  it("accepts a payload that hashes to response.hash", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const proxy = createSigningProxy({
      signer: "tee://oracle",
      alg: "EdDSA",
      privateKey,
      publicKey: pem(publicKey),
    });
    const honest = { price: 100, currency: "usd" };
    const receipt = proxy.sign(honest);
    const bundle = await traceWith({
      receipt,
      request: { hash: await hashToolPayload({ q: 1 }) },
      response: { hash: await hashToolPayload(honest), payload: honest },
    });
    const outcome = await verifyToolReceipts(bundle, {
      keys: { "tee://oracle": pem(publicKey) },
    });
    expect(outcome.results[0]!.verified).toBe(true);
  });
});

describe("JWT algorithm confusion (HS* over an asymmetric public key)", () => {
  it("refuses to HMAC-verify with a pinned asymmetric public key (alg:HS256 forgery)", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const pubPem = pem(publicKey);

    // Attacker forges a JWS with alg:HS256 and HMACs the signing input using the
    // VICTIM'S PUBLIC KEY PEM as the "secret" (public = known to the attacker).
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const body = { price: 999_999, note: "FORGED" };
    const payloadSeg = Buffer.from(JSON.stringify(body)).toString("base64url");
    const signingInput = `${header}.${payloadSeg}`;
    const forgedSig = createHmac("sha256", pubPem).update(signingInput).digest("base64url");

    const receipt: ToolReceiptEvent["receipt"] = {
      scheme: "jws",
      signer: "tee://asym-oracle",
      signature: forgedSig,
      signedPayload: signingInput,
    };
    const bundle = await traceWith({
      receipt,
      request: { hash: await hashToolPayload({ q: 1 }) },
      response: { hash: await hashToolPayload(body), payload: body },
    });

    // Auditor pins the ASYMMETRIC public key. The HMAC branch must NOT accept it.
    const outcome = await verifyToolReceipts(bundle, {
      keys: { "tee://asym-oracle": pubPem },
    });
    expect(outcome.results[0]!.verified).toBe(false);
    expect(outcome.results[0]!.error ?? "").toMatch(/public key|asymmetric|hmac/i);
  });

  it("optional keyAlgs allow-list rejects an alg outside it", async () => {
    // A genuine HS256 receipt, but the auditor pins keyAlgs to EdDSA only.
    const proxy = createSigningProxy({ signer: "hs-signer", alg: "HS256", secret: "topsecret" });
    const payload = { data: "y" };
    const receipt = proxy.sign(payload);
    const bundle = await traceWith({
      receipt,
      request: { hash: await hashToolPayload({ q: 1 }) },
      response: { hash: await hashToolPayload(payload), payload },
    });
    const outcome = await verifyToolReceipts(bundle, {
      keys: { "hs-signer": "topsecret" },
      keyAlgs: { "hs-signer": ["EdDSA"] },
    });
    expect(outcome.results[0]!.verified).toBe(false);
    expect(outcome.results[0]!.error ?? "").toMatch(/alg|allow/i);
  });
});

describe("self-signed JWS call-binding (anti-replay)", () => {
  it("a genuine receipt copied into a different runId/request fails", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");

    // Signer commits to the response AND the run/request binding context.
    const run: TraceRun = await createTrace({ agentId: "agent-src" });
    const span = addSpan(run, { name: "tool-call", visibility: "public" });
    const request = { q: "price?" };
    const response = { price: 100 };
    const requestHash = await hashToolPayload(request);
    const proxy = createSigningProxy({
      signer: "tee://oracle",
      alg: "EdDSA",
      privateKey,
      publicKey: pem(publicKey),
      binding: { runId: run.id, requestHash },
    });
    const receipt = proxy.sign(response);
    await addToolReceipt(run, span.id, {
      toolId: "demo.tool",
      request: { hash: requestHash },
      response: { hash: await hashToolPayload(response), payload: response },
      receipt,
    });
    await closeSpan(run, span.id);
    const srcBundle = await finalizeTrace(run);

    // In the ORIGINAL run it is call-bound and verifies.
    const honest = await verifyToolReceipts(srcBundle, {
      keys: { "tee://oracle": pem(publicKey) },
    });
    expect(honest.results[0]!.verified).toBe(true);
    expect(honest.results[0]!.callBound).toBe(true);

    // Lift the genuine receipt into a DIFFERENT run (different runId).
    const victimRun: TraceRun = await createTrace({ agentId: "agent-victim" });
    const vspan = addSpan(victimRun, { name: "tool-call", visibility: "public" });
    await addToolReceipt(victimRun, vspan.id, {
      toolId: "demo.tool",
      request: { hash: requestHash },
      response: { hash: await hashToolPayload(response), payload: response },
      receipt, // same genuine, honestly-signed receipt
    });
    await closeSpan(victimRun, vspan.id);
    const victimBundle = await finalizeTrace(victimRun);

    const replayed = await verifyToolReceipts(victimBundle, {
      keys: { "tee://oracle": pem(publicKey) },
    });
    expect(replayed.results[0]!.verified).toBe(false);
    expect(replayed.results[0]!.reason).toBe("call-binding-mismatch");
  });

  it("external webhook receipts verify for authenticity but are marked not-call-bound", async () => {
    const secret = "whsec_test_secret";
    const body = JSON.stringify({ id: "evt_1", type: "charge.succeeded" });
    const t = 1_900_000_000;
    const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    const bundle = await traceWith({
      receipt: {
        scheme: "stripe-webhook",
        signer: "acct_123",
        signature: `t=${t},v1=${v1}`,
        signedPayload: body,
      },
      request: { hash: await hashToolPayload({ q: 1 }) },
      response: { hash: await hashToolPayload(body), payload: body },
    });
    const outcome = await verifyToolReceipts(bundle, {
      keys: { acct_123: secret },
      nowSec: t + 10,
    });
    expect(outcome.results[0]!.verified).toBe(true);
    expect(outcome.results[0]!.callBound).toBe(false);
  });
});
